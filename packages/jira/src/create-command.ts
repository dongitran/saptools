import process from "node:process";

import { errorMessage } from "@saptools/core";
import type { Command } from "commander";

import { readOptionalJiraAdfBodyInput } from "./adf.js";
import {
  JiraAssigneeAmbiguityError,
  resolveAssignableUserByAccountId,
  resolveAssignableUserByQuery,
} from "./assignment.js";
import { uploadJiraIssueAttachments } from "./attachment-upload.js";
import { toRequestOptions, writeOutputWithOptionalHint } from "./cli-shared.js";
import { assignJiraIssue, fetchJiraCurrentUser, searchJiraAssignableUsers } from "./client.js";
import { collectFieldValueInputs } from "./custom-field-values.js";
import { formatJiraIssueCreated } from "./format.js";
import { createJiraIssue, normalizeJiraCreateLabels } from "./issue-create.js";
import type {
  JiraAssigneeResolution,
  JiraCreateIssueOptions,
  JiraCreateIssueResult,
  JiraIssueAttachment,
  JiraRequestOptions,
} from "./types.js";

interface CreateFlags {
  readonly adfFile?: string;
  readonly assignMe?: boolean;
  readonly assignee?: string;
  readonly field?: string[];
  readonly fieldFile?: string[];
  readonly file?: string[];
  readonly json?: boolean;
  readonly label?: string[];
  readonly notifyUsers?: boolean;
  readonly parent?: string;
  readonly priority?: string;
  readonly project?: string;
  readonly text?: string;
  readonly textFile?: string;
  readonly type?: string;
}

type CreateAssigneeSelector =
  | { readonly kind: "me" }
  | { readonly kind: "query"; readonly value: string };

interface CreateIssueCliResult {
  readonly assignee?: { readonly accountId: string; readonly displayName: string };
  readonly assigneeResolution?: string;
  readonly attachments?: readonly JiraIssueAttachment[];
  readonly id: string;
  readonly issueKey: string;
  readonly issueType: string;
}

export function addCreateCommand(program: Command): void {
  program
    .command("create")
    .description("Create a new Jira issue")
    .argument("<summary>", "Jira issue summary")
    .requiredOption("--project <key>", "Jira project key")
    .requiredOption("--type <name>", "Jira issue type display name, for example Task or Bug")
    .option("--text <text>", "Plain text description body")
    .option("--text-file <path>", "Read a plain text description body from a file")
    .option("--adf-file <path>", "Read a raw ADF JSON description body from a file")
    .option("--priority <name>", "Jira priority display name")
    .option("--label <name>", "Add a Jira label (repeatable)", collectOption, [])
    .option("--parent <key>", "Parent issue key, required for a subtask issue type")
    .option("--field <name=value>", "Display-name field value (repeatable)", collectOption, [])
    .option("--field-file <name=path>", "Read a field value from a file (repeatable)", collectOption, [])
    .option("--file <path>", "Local file to attach right after creation (repeatable)", collectOption, [])
    .option("--assign-me", "Assign the created issue to the connected Jira account", false)
    .option("--assignee <name-or-query>", "Assign the created issue by display-name query")
    .option("--no-notify-users", "Suppress Jira user notifications for the create")
    .option("--json", "Print JSON output", false)
    .action(async (summary: string, flags: CreateFlags): Promise<void> => {
      const assigneeSelector = parseCreateAssigneeSelector(flags);
      const requestOptions = await toRequestOptions(program);
      const createOptions = await toCreateIssueOptions(requestOptions, summary, flags);
      const created = await createJiraIssue(createOptions);
      const assignment = assigneeSelector === null
        ? null
        : await tryAssignCreatedIssue(requestOptions, created.key, assigneeSelector);
      const attachments = await tryAttachCreatedIssueFiles(requestOptions, created.key, flags.file ?? []);
      const result = toCreateResult(created, assignment, attachments);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatJiraIssueCreated(created, assignment, attachments),
        flags.json === true,
      );
    });
}

async function tryAttachCreatedIssueFiles(
  requestOptions: JiraRequestOptions,
  issueKey: string,
  filePaths: readonly string[],
): Promise<readonly JiraIssueAttachment[]> {
  if (filePaths.length === 0) {
    return [];
  }
  try {
    return await uploadJiraIssueAttachments({ ...requestOptions, issueKey, filePaths });
  } catch (error: unknown) {
    process.stderr.write(
      `Warning: Jira issue ${issueKey} was created, but attachments could not be uploaded: ${errorMessage(error)}\n`,
    );
    return [];
  }
}

async function toCreateIssueOptions(
  requestOptions: JiraRequestOptions,
  summary: string,
  flags: CreateFlags,
): Promise<JiraCreateIssueOptions> {
  const description = await readOptionalJiraAdfBodyInput(flags);
  const fieldValues = await collectFieldValueInputs(flags.field ?? [], flags.fieldFile ?? []);
  const labels = normalizeJiraCreateLabels(flags.label ?? []);
  return {
    ...requestOptions,
    summary,
    fieldValues,
    labels,
    issueTypeName: requireFlagText(flags.type, "--type <name>"),
    projectKey: requireFlagText(flags.project, "--project <key>"),
    ...(description === null ? {} : { description: description.document }),
    ...(flags.parent === undefined ? {} : { parentKey: flags.parent }),
    ...(flags.priority === undefined ? {} : { priorityName: flags.priority }),
    ...(flags.notifyUsers === false ? { notifyUsers: false } : {}),
  };
}

function parseCreateAssigneeSelector(flags: CreateFlags): CreateAssigneeSelector | null {
  const hasMe = flags.assignMe === true;
  const hasQuery = flags.assignee !== undefined;
  if (!hasMe && !hasQuery) {
    return null;
  }
  if (hasMe && hasQuery) {
    throw new Error("--assign-me and --assignee cannot be combined.");
  }
  return hasMe ? { kind: "me" } : { kind: "query", value: requireFlagText(flags.assignee, "--assignee <name-or-query>") };
}

async function tryAssignCreatedIssue(
  requestOptions: JiraRequestOptions,
  issueKey: string,
  selector: CreateAssigneeSelector,
): Promise<JiraAssigneeResolution | null> {
  const issueOptions = { ...requestOptions, issueKey };
  try {
    const resolution = selector.kind === "me"
      ? await resolveCreateAssigneeSelf(issueOptions)
      : await resolveCreateAssigneeByQuery(issueOptions, selector.value);
    await assignJiraIssue({ ...issueOptions, accountId: resolution.assignee.accountId });
    return resolution;
  } catch (error: unknown) {
    warnAssignmentFailed(issueKey, error);
    return null;
  }
}

async function resolveCreateAssigneeSelf(
  issueOptions: JiraRequestOptions & { readonly issueKey: string },
): Promise<JiraAssigneeResolution> {
  const currentUser = await fetchJiraCurrentUser(issueOptions);
  if (!currentUser.active) {
    throw new Error("The current Jira user is inactive; no assignment was changed.");
  }
  const candidates = await searchJiraAssignableUsers({ ...issueOptions, accountId: currentUser.accountId });
  return resolveAssignableUserByAccountId(issueOptions.issueKey, currentUser.accountId, candidates, "me");
}

async function resolveCreateAssigneeByQuery(
  issueOptions: JiraRequestOptions & { readonly issueKey: string },
  query: string,
): Promise<JiraAssigneeResolution> {
  const candidates = await searchJiraAssignableUsers({ ...issueOptions, query });
  return resolveAssignableUserByQuery(issueOptions.issueKey, query, candidates);
}

function warnAssignmentFailed(issueKey: string, error: unknown): void {
  const message = error instanceof JiraAssigneeAmbiguityError
    ? `${error.message} Run \`jira assign ${issueKey} --account-id <account-id>\` after inspecting the candidates with \`jira assign ${issueKey} --to "<name>"\`.`
    : errorMessage(error);
  process.stderr.write(`Warning: Jira issue ${issueKey} was created, but the assignee could not be set: ${message}\n`);
}

function toCreateResult(
  created: JiraCreateIssueResult,
  assignment: JiraAssigneeResolution | null,
  attachments: readonly JiraIssueAttachment[],
): CreateIssueCliResult {
  return {
    id: created.id,
    issueKey: created.key,
    issueType: created.issueType,
    ...(assignment === null ? {} : {
      assignee: {
        accountId: assignment.assignee.accountId,
        displayName: assignment.assignee.displayName,
      },
      assigneeResolution: assignment.source,
    }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function requireFlagText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`required option '${label}'`);
  }
  return value;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
