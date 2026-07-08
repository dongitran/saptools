import { readFileSync } from "node:fs";
import process from "node:process";

import { Command } from "commander";

import { assertNoJiraAdfBodySource, readJiraAdfBodyInput } from "./adf.js";
import {
  JiraAssigneeAmbiguityError,
  resolveAssignableUserByAccountId,
  resolveAssignableUserByQuery,
} from "./assignment.js";
import {
  connectJira,
  disconnectJira,
  getJiraConnectionStatus,
  requireStoredOrRefreshJiraTokens,
} from "./auth.js";
import {
  addJiraIssueComment,
  addJiraIssueWorklog,
  assignJiraIssue,
  fetchAssignedJiraIssues,
  fetchJiraCurrentUser,
  fetchJiraCustomFields,
  fetchJiraIssueDescriptionAdf,
  fetchJiraIssueDetail,
  fetchJiraIssueEditMetadata,
  fetchJiraIssueRemoteLinks,
  fetchJiraIssueTransitions,
  searchJiraAssignableUsers,
  transitionJiraIssue,
  updateJiraIssueDescription,
  updateJiraIssueFields,
  updateJiraIssueSummary,
} from "./client.js";
import {
  readCustomFieldSnapshot,
  readPinnedCustomFields,
  writeCustomFieldSnapshot,
  writePinnedCustomFields,
} from "./custom-field-store.js";
import { buildIssueFieldUpdate, collectFieldValueInputs } from "./custom-field-values.js";
import { createCustomFieldSnapshot, resolveFieldByDisplayName, searchCustomFields } from "./custom-fields.js";
import type { CustomFieldSnapshot, PinnedCustomFieldConfig } from "./custom-fields.js";
import {
  formatConnectionStatus,
  formatIssueDetail,
  formatIssueLinks,
  formatIssueTransitions,
  formatJiraIssueCommentAdded,
  formatJiraIssueDescriptionUpdated,
  formatJiraIssueSummaryUpdated,
  formatCustomFieldDiscovery,
  formatCustomFieldRows,
  formatIssues,
  formatPinnedCustomFieldHint,
  formatPinnedCustomFields,
} from "./format.js";
import type {
  AddJiraIssueWorklogOptions,
  FetchAssignedJiraIssuesOptions,
  FetchJiraIssueDetailOptions,
  JiraAuthOptions,
  JiraRequestOptions,
  JiraAssigneeResolution,
  JiraTokens,
} from "./types.js";
import {
  appendJiraWorklogHistory,
  formatJiraDate,
  summarizeJiraWorklogHistory,
  type WorklogSummary,
  type WorklogSummaryFilter,
} from "./worklog-history.js";

interface GlobalFlags {
  readonly apiRoot?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly port?: string;
  readonly tokenStore?: string;
  readonly hints?: boolean;
}

interface JsonFlags {
  readonly json?: boolean;
}

interface FieldsDiscoverFlags extends JsonFlags {
  readonly search?: string;
}

interface FieldsUpdateFlags extends JsonFlags {
  readonly field?: string[];
  readonly fieldFile?: string[];
}

interface IssuesFlags extends JsonFlags {
  readonly max?: string;
}

interface IssueFlags extends JsonFlags {
  readonly imageDir?: string;
  readonly images?: boolean;
  readonly maxImageBytes?: string;
  readonly maxImages?: string;
}

interface TransitionFlags {
  readonly id?: string;
}

interface AssignFlags extends JsonFlags {
  readonly accountId?: string;
  readonly me?: boolean;
  readonly to?: string;
}

interface DescribeFlags extends JsonFlags {
  readonly adfFile?: string;
  readonly append?: boolean;
  readonly force?: boolean;
  readonly notifyUsers?: boolean;
  readonly print?: boolean;
  readonly text?: string;
  readonly textFile?: string;
}

interface SummaryFlags extends JsonFlags {
  readonly notifyUsers?: boolean;
}

interface CommentFlags extends JsonFlags {
  readonly adfFile?: string;
  readonly text?: string;
  readonly textFile?: string;
}

interface WorklogFlags {
  readonly comment?: string;
  readonly minutes?: string;
  readonly started?: string;
}

interface WorklogsFlags extends JsonFlags {
  readonly day?: string;
  readonly from?: string;
  readonly groupBy?: string;
  readonly issue?: string;
  readonly month?: string;
  readonly to?: string;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("jira")
    .description("Jira Cloud CLI that reuses the JiraOps OAuth token store")
    .version(readPackageVersion(), "-V, --version", "Print the jira package version")
    .option("--api-root <url>", "Jira API root for Atlassian Cloud or tests")
    .option("--token-store <path>", "Path to the shared jira-oauth-client token store")
    .option("--client-id <id>", "Atlassian OAuth app client ID")
    .option("--client-secret <secret>", "Atlassian OAuth app client secret")
    .option("--port <number>", "OAuth callback port")
    .option("--no-hints", "Suppress local custom field hint footers");

  addStatusCommand(program);
  addConnectCommand(program);
  addDisconnectCommand(program);
  addLogoutCommand(program);
  addTokenCommand(program);
  addIssuesCommand(program);
  addIssueCommand(program);
  addLinksCommand(program);
  addTransitionsCommand(program);
  addTransitionCommand(program);
  addAssignCommand(program);
  addDescribeCommand(program);
  addSummaryCommand(program);
  addCommentCommand(program);
  addWorklogCommand(program);
  addWorklogsCommand(program);
  addFieldsCommand(program);

  await program.parseAsync([...argv]);
}

function addStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show shared Jira token connection status")
    .option("--json", "Print JSON output", false)
    .action(async (flags: JsonFlags): Promise<void> => {
      const status = await getJiraConnectionStatus(toAuthOptions(program));
      if (flags.json === true || status.cloudId === null) {
        writeOutput(flags.json === true ? status : formatConnectionStatus(status));
        return;
      }
      await writeOutputWithOptionalHint(program, status.cloudId, formatConnectionStatus(status), false);
    });
}

function addConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Run Jira OAuth and save tokens to the shared token store")
    .option("--json", "Print JSON output", false)
    .action(async (flags: JsonFlags): Promise<void> => {
      const tokens = await connectJira(toAuthOptions(program));
      const status = {
        connected: true,
        cloudId: tokens.cloudId,
        cloudName: tokens.cloudName,
        usable: true,
      };
      await writeOutputWithOptionalHint(
        program,
        tokens.cloudId,
        flags.json === true ? status : formatConnectionStatus(status),
        flags.json === true,
      );
    });
}

function addDisconnectCommand(program: Command): void {
  program
    .command("disconnect")
    .description("Remove the shared Jira OAuth token store")
    .action(async (): Promise<void> => {
      await clearStoredJiraConnection(program);
      process.stdout.write("Disconnected from Jira.\n");
    });
}

function addLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Remove the shared Jira OAuth token store")
    .action(async (): Promise<void> => {
      await clearStoredJiraConnection(program);
      process.stdout.write("Logged out from Jira.\n");
    });
}

function addTokenCommand(program: Command): void {
  program
    .command("token")
    .description("Print the current access token for scripts")
    .action(async (): Promise<void> => {
      const tokens = await resolveTokens(program);
      process.stdout.write(`${tokens.accessToken}\n`);
    });
}

function addIssuesCommand(program: Command): void {
  program
    .command("issues")
    .description("List Jira issues assigned to the connected user")
    .option("--max <number>", "Maximum issue count")
    .option("--json", "Print JSON output", false)
    .action(async (flags: IssuesFlags): Promise<void> => {
      const requestOptions = await toAssignedIssuesOptions(program, flags);
      const issues = await fetchAssignedJiraIssues(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? issues : formatIssues(issues),
        flags.json === true,
      );
    });
}

function addIssueCommand(program: Command): void {
  program
    .command("issue")
    .description("Show one Jira issue")
    .argument("<key>", "Jira issue key")
    .option("--json", "Print JSON output", false)
    .option("--no-images", "Do not download inline Jira images")
    .option("--image-dir <path>", "Directory for saved inline Jira images")
    .option("--max-image-bytes <number>", "Maximum bytes per saved Jira image")
    .option("--max-images <number>", "Maximum inline Jira images to save")
    .action(async (issueKey: string, flags: IssueFlags): Promise<void> => {
      const requestOptions = await toIssueDetailOptions(program, issueKey, flags);
      const detail = await fetchJiraIssueDetail(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? detail : formatIssueDetail(detail),
        flags.json === true,
      );
    });
}

function addLinksCommand(program: Command): void {
  program
    .command("links")
    .description("List Jira remote links for one issue")
    .argument("<key>", "Jira issue key")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: JsonFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const links = await fetchJiraIssueRemoteLinks(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? links : formatIssueLinks(links),
        flags.json === true,
      );
    });
}

function addTransitionsCommand(program: Command): void {
  program
    .command("transitions")
    .description("List available transitions for one issue")
    .argument("<key>", "Jira issue key")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: JsonFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const transitions = await fetchJiraIssueTransitions(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? transitions : formatIssueTransitions(transitions),
        flags.json === true,
      );
    });
}

function addTransitionCommand(program: Command): void {
  program
    .command("transition")
    .description("Apply a transition to one Jira issue")
    .argument("<key>", "Jira issue key")
    .requiredOption("--id <id>", "Jira transition ID")
    .action(async (issueKey: string, flags: TransitionFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      await transitionJiraIssue({
        ...requestOptions,
        transitionId: requireText(flags.id, "--id <id>"),
      });
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        `Transition applied to ${issueKey}.`,
        false,
      );
    });
}

function addAssignCommand(program: Command): void {
  program
    .command("assign")
    .description("Assign one Jira issue after deterministic assignee resolution")
    .argument("<key>", "Jira issue key")
    .option("--me", "Assign to the connected Jira account", false)
    .option("--to <name-or-query>", "Find an active issue-assignable user by display-name query")
    .option("--account-id <account-id>", "Assign to a verified issue-assignable account ID")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: AssignFlags): Promise<void> => {
      try {
        const requestOptions = await toIssueRequestOptions(program, issueKey);
        const resolution = await resolveAssigneeForFlags(requestOptions, flags);
        await assignJiraIssue({ ...requestOptions, accountId: resolution.assignee.accountId });
        const result = {
          issueKey,
          assignee: {
            accountId: resolution.assignee.accountId,
            displayName: resolution.assignee.displayName,
          },
          resolution: resolution.source,
        };
        await writeOutputWithOptionalHint(
          program,
          requestOptions.cloudId,
          flags.json === true ? result : `Assigned ${issueKey} to ${resolution.assignee.displayName}.`,
          flags.json === true,
        );
      } catch (error: unknown) {
        if (error instanceof JiraAssigneeAmbiguityError) {
          writeAssignmentError(error, flags.json === true);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}

async function resolveAssigneeForFlags(
  requestOptions: JiraRequestOptions & { readonly issueKey: string },
  flags: AssignFlags,
): Promise<JiraAssigneeResolution> {
  const selector = parseAssignSelector(flags);
  if (selector.kind === "me") {
    const currentUser = await fetchJiraCurrentUser(requestOptions);
    if (!currentUser.active) {
      throw new Error("The current Jira user is inactive; no assignment was changed.");
    }
    const candidates = await searchJiraAssignableUsers({ ...requestOptions, accountId: currentUser.accountId });
    return resolveAssignableUserByAccountId(requestOptions.issueKey, currentUser.accountId, candidates, "me");
  }
  const candidates = await searchJiraAssignableUsers({
    ...requestOptions,
    ...(selector.kind === "to" ? { query: selector.value } : { accountId: selector.value }),
  });
  return selector.kind === "to"
    ? resolveAssignableUserByQuery(requestOptions.issueKey, selector.value, candidates)
    : resolveAssignableUserByAccountId(requestOptions.issueKey, selector.value, candidates, "account-id");
}

function parseAssignSelector(flags: AssignFlags): { readonly kind: "me" } | { readonly kind: "to" | "account-id"; readonly value: string } {
  const selectors = [
    ...(flags.me === true ? ["--me"] : []),
    ...(flags.to === undefined ? [] : ["--to <name-or-query>"]),
    ...(flags.accountId === undefined ? [] : ["--account-id <account-id>"]),
  ];
  if (selectors.length !== 1) {
    throw new Error("Exactly one assignee selector is required: --me, --to <name-or-query>, or --account-id <account-id>.");
  }
  if (flags.me === true) {
    return { kind: "me" };
  }
  if (flags.to !== undefined) {
    return { kind: "to", value: requireText(flags.to, "--to <name-or-query>") };
  }
  return { kind: "account-id", value: requireText(flags.accountId, "--account-id <account-id>") };
}

function writeAssignmentError(error: JiraAssigneeAmbiguityError, isJson: boolean): void {
  if (isJson) {
    writeErrorOutput({
      error: "ambiguous_assignee",
      issueKey: error.issueKey,
      query: error.query,
      message: "Multiple active assignable Jira users matched; no assignment was changed.",
      candidates: error.candidates.map((candidate) => ({
        accountId: candidate.accountId,
        displayName: candidate.displayName,
      })),
    });
    return;
  }
  writeErrorOutput(formatAssigneeAmbiguity(error));
}

function formatAssigneeAmbiguity(error: JiraAssigneeAmbiguityError): string {
  return [
    `Multiple active assignable Jira users match "${error.query}"; no assignment was changed.`,
    `${error.candidates.length.toString()} candidates:`,
    ...error.candidates.map((candidate) => `${candidate.displayName}\t${candidate.accountId}`),
    `Retry with: jira assign ${error.issueKey} --account-id <account-id>`,
  ].join("\n");
}

function addDescribeCommand(program: Command): void {
  program
    .command("describe")
    .description("Print or update one Jira issue description as raw ADF")
    .argument("<key>", "Jira issue key")
    .option("--text <text>", "Plain text description body")
    .option("--text-file <path>", "Read a plain text description body from a file")
    .option("--adf-file <path>", "Read a raw ADF JSON description body from a file")
    .option("--print", "Print the current raw description ADF JSON without updating the issue", false)
    .option("--append", "Append to the current description instead of replacing it", false)
    .option("--force", "Allow plain text replacement of a media-bearing description", false)
    .option("--no-notify-users", "Suppress Jira user notifications for the update")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: DescribeFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      if (flags.print === true) {
        assertNoJiraAdfBodySource(flags);
        const description = await fetchJiraIssueDescriptionAdf(requestOptions);
        writeOutput(formatDescriptionPrintOutput(issueKey, description, flags.json === true));
        return;
      }

      const bodyInput = await readJiraAdfBodyInput(flags);
      await updateJiraIssueDescription({
        ...requestOptions,
        ...notifyUsersOption(flags),
        description: bodyInput.document,
        force: flags.force === true,
        inputKind: bodyInput.inputKind,
        mode: flags.append === true ? "append" : "replace",
      });
      const result = { issueKey, updated: ["description"] };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatJiraIssueDescriptionUpdated(issueKey),
        flags.json === true,
      );
    });
}

function formatDescriptionPrintOutput(
  issueKey: string,
  description: unknown,
  isJson: boolean,
): unknown {
  if (isJson) {
    return { issueKey, description };
  }
  if (description !== null) {
    return description;
  }
  throw new Error(`Jira issue ${issueKey} has no description ADF to print. Use --json to receive a null description.`);
}

function addSummaryCommand(program: Command): void {
  program
    .command("summary")
    .description("Update one Jira issue summary")
    .argument("<key>", "Jira issue key")
    .argument("<summary>", "New Jira issue summary")
    .option("--no-notify-users", "Suppress Jira user notifications for the update")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, summary: string, flags: SummaryFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      await updateJiraIssueSummary({
        ...requestOptions,
        ...notifyUsersOption(flags),
        summary: requireText(summary, "<summary>"),
      });
      const result = { issueKey, updated: ["summary"] };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatJiraIssueSummaryUpdated(issueKey),
        flags.json === true,
      );
    });
}

function addCommentCommand(program: Command): void {
  program
    .command("comment")
    .description("Add a Jira issue comment from plain text or raw ADF")
    .argument("<key>", "Jira issue key")
    .option("--text <text>", "Plain text comment body")
    .option("--text-file <path>", "Read a plain text comment body from a file")
    .option("--adf-file <path>", "Read a raw ADF JSON comment body from a file")
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: CommentFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const bodyInput = await readJiraAdfBodyInput(flags);
      const comment = await addJiraIssueComment({
        ...requestOptions,
        body: bodyInput.document,
      });
      const result = { issueKey, commentId: comment.id };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? result : formatJiraIssueCommentAdded(issueKey),
        flags.json === true,
      );
    });
}

function addWorklogCommand(program: Command): void {
  program
    .command("worklog")
    .description("Add a Jira worklog entry")
    .argument("<key>", "Jira issue key")
    .requiredOption("--minutes <number>", "Positive worklog minutes")
    .option("--comment <text>", "Optional worklog comment")
    .option("--started <date>", "Jira worklog start timestamp")
    .action(async (issueKey: string, flags: WorklogFlags): Promise<void> => {
      const worklogOptions = await toWorklogOptions(program, issueKey, flags);
      await addJiraIssueWorklog(worklogOptions);
      await appendJiraWorklogHistory({
        issueKey: worklogOptions.issueKey,
        minutes: worklogOptions.minutes,
        started: worklogOptions.started,
        ...(worklogOptions.comment === undefined ? {} : { comment: worklogOptions.comment }),
      }).catch((): void => {
        process.stderr.write(
          "Warning: Jira worklog was added, but local history could not be updated.\n",
        );
      });
      await writeOutputWithOptionalHint(
        program,
        worklogOptions.cloudId,
        `Worklog added to ${issueKey}.`,
        false,
      );
    });
}

function addWorklogsCommand(program: Command): void {
  program
    .command("worklogs")
    .description("Summarize local Jira worklog history without calling Jira")
    .option("--day <YYYY-MM-DD>", "Summarize one started day")
    .option("--issue <key>", "Summarize one Jira issue key")
    .option("--month <YYYYMM>", "Summarize one started month")
    .option("--from <YYYY-MM-DD>", "Start date for a started-date range")
    .option("--to <YYYY-MM-DD>", "End date for a started-date range")
    .option("--group-by <day|issue>", "Group human and JSON totals", "issue")
    .option("--json", "Print JSON output", false)
    .action(async (flags: WorklogsFlags): Promise<void> => {
      const groupBy = parseWorklogsGroupBy(flags.groupBy);
      const summary = await summarizeJiraWorklogHistory(toWorklogsFilter(flags), groupBy);
      writeOutput(flags.json === true ? summary : formatWorklogSummary(summary));
    });
}


function addFieldsCommand(program: Command): void {
  const fields = program.command("fields").description("Discover, pin, and update Jira custom fields");

  fields.command("discover")
    .description("Refresh the custom field snapshot from Jira Cloud")
    .option("--search <query>", "Filter displayed fields after saving the full snapshot")
    .option("--json", "Print JSON output", false)
    .action(async (flags: FieldsDiscoverFlags): Promise<void> => {
      const tokens = await resolveTokens(program);
      const requestOptions = toRequestOptionsFromTokens(program, tokens);
      const discovered = await fetchJiraCustomFields(requestOptions);
      const snapshot = createCustomFieldSnapshot({
        cloudId: tokens.cloudId,
        cloudName: tokens.cloudName,
        fields: discovered.fields,
        totalFromApi: discovered.totalFromApi,
      });
      await writeCustomFieldSnapshot(snapshot);
      const displayed = flags.search === undefined
        ? snapshot.fields
        : searchCustomFields(snapshot.fields, flags.search);
      writeOutput(flags.json === true ? snapshot : formatCustomFieldDiscovery(snapshot, displayed));
    });

  fields.command("search")
    .description("Search the cached Jira custom field snapshot without calling Jira")
    .argument("<query>", "Search query")
    .option("--json", "Print JSON output", false)
    .action(async (query: string, flags: JsonFlags): Promise<void> => {
      const tokens = await resolveTokens(program);
      const snapshot = await requireSnapshot(tokens.cloudId);
      const matches = searchCustomFields(snapshot.fields, query);
      writeOutput(flags.json === true ? matches : formatCustomFieldRows(matches));
    });

  fields.command("pinned")
    .description("List pinned Jira custom fields")
    .option("--json", "Print JSON output", false)
    .action(async (flags: JsonFlags): Promise<void> => {
      const tokens = await resolveTokens(program);
      const pinned = await readPinnedCustomFields(tokens.cloudId);
      writeOutput(
        flags.json === true
          ? (pinned ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName))
          : formatPinnedCustomFields(pinned),
      );
    });

  fields.command("pin")
    .description("Pin a custom field by exact Jira display name")
    .argument("<field-name>", "Jira field display name")
    .action(async (fieldName: string): Promise<void> => {
      const tokens = await resolveTokens(program);
      const snapshot = await requireSnapshot(tokens.cloudId);
      const matches = resolveFieldByDisplayName(snapshot.fields, fieldName);
      if (matches.length !== 1) {
        throw fieldResolutionError(fieldName, matches.length, "custom field snapshot");
      }
      const current = await readPinnedCustomFields(tokens.cloudId)
        ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName);
      const field = firstResolvedField(matches, fieldName);
      if (current.fields.some((item) => item.id === field.id)) {
        process.stdout.write(`Custom field "${field.name}" is already pinned.\n`);
        return;
      }
      await writePinnedCustomFields({
        ...current,
        updatedAt: new Date().toISOString(),
        fields: [...current.fields, { id: field.id, name: field.name, schema: field.schema }],
      });
      process.stdout.write(`Pinned custom field "${field.name}".\n`);
    });

  fields.command("unpin")
    .description("Unpin a custom field by exact Jira display name")
    .argument("<field-name>", "Pinned Jira field display name")
    .action(async (fieldName: string): Promise<void> => {
      const tokens = await resolveTokens(program);
      const current = await readPinnedCustomFields(tokens.cloudId)
        ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName);
      const matches = resolveFieldByDisplayName(current.fields, fieldName);
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `Pinned field "${fieldName}" was not found.`
            : `Pinned field name "${fieldName}" is ambiguous.`,
        );
      }
      const field = firstResolvedField(matches, fieldName);
      await writePinnedCustomFields({
        ...current,
        updatedAt: new Date().toISOString(),
        fields: current.fields.filter((item) => item.id !== field.id),
      });
      process.stdout.write(`Unpinned custom field "${field.name}".\n`);
    });

  fields.command("update")
    .description("Update pinned custom fields on one Jira issue")
    .argument("<key>", "Jira issue key")
    .option("--field <name=value>", "Display-name field update", collectOption, [])
    .option("--field-file <name=path>", "Read a field value from a file", collectOption, [])
    .option("--json", "Print JSON output", false)
    .action(async (issueKey: string, flags: FieldsUpdateFlags): Promise<void> => {
      const requestOptions = await toIssueRequestOptions(program, issueKey);
      const pinned = await readPinnedCustomFields(requestOptions.cloudId);
      if (pinned === null || pinned.fields.length === 0) {
        throw new Error("No pinned Jira custom fields. Run `jira fields pin <field-name>` first.");
      }
      const values = await collectFieldValueInputs(flags.field ?? [], flags.fieldFile ?? []);
      const editableFields = await fetchJiraIssueEditMetadata(requestOptions);
      const update = buildIssueFieldUpdate({
        editableFields,
        issueKey,
        pinnedFields: pinned.fields,
        values,
      });
      await updateJiraIssueFields({ ...requestOptions, fields: update.fields });
      const result = { issueKey, updatedFields: update.names };
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true
          ? result
          : `Updated custom fields on ${issueKey}: ${update.names.join(", ")}.`,
        flags.json === true,
      );
    });
}

async function toAssignedIssuesOptions(
  program: Command,
  flags: IssuesFlags,
): Promise<FetchAssignedJiraIssuesOptions> {
  const requestOptions = await toRequestOptions(program);
  const maxResults = parseOptionalPositiveInteger(flags.max, "--max <number>");
  return maxResults === undefined ? requestOptions : { ...requestOptions, maxResults };
}

async function toWorklogOptions(
  program: Command,
  issueKey: string,
  flags: WorklogFlags,
): Promise<AddJiraIssueWorklogOptions & { readonly started: string }> {
  const requestOptions = await toIssueRequestOptions(program, issueKey);
  const minutes = parseRequiredPositiveInteger(flags.minutes, "--minutes <number>");
  const started = normalizeWorklogStarted(flags.started, new Date());
  return {
    ...requestOptions,
    minutes,
    started,
    ...(flags.comment === undefined ? {} : { comment: flags.comment }),
  };
}

async function toIssueDetailOptions(
  program: Command,
  issueKey: string,
  flags: IssueFlags,
): Promise<FetchJiraIssueDetailOptions> {
  const requestOptions = await toIssueRequestOptions(program, issueKey);
  const maxImageBytes = parseOptionalPositiveInteger(
    flags.maxImageBytes,
    "--max-image-bytes <number>",
  );
  const maxImages = parseOptionalPositiveInteger(flags.maxImages, "--max-images <number>");
  return {
    ...requestOptions,
    downloadImages: flags.images !== false,
    ...(flags.imageDir === undefined ? {} : { imageOutputDir: flags.imageDir }),
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
    ...(maxImages === undefined ? {} : { maxImages }),
  };
}

async function toIssueRequestOptions(
  program: Command,
  issueKey: string,
): Promise<JiraRequestOptions & { readonly issueKey: string }> {
  return {
    ...(await toRequestOptions(program)),
    issueKey,
  };
}

async function toRequestOptions(program: Command): Promise<JiraRequestOptions> {
  return toRequestOptionsFromTokens(program, await resolveTokens(program));
}

function toRequestOptionsFromTokens(program: Command, tokens: JiraTokens): JiraRequestOptions {
  const flags = program.opts<GlobalFlags>();
  const apiRoot = resolveApiRoot(flags);
  return {
    accessToken: tokens.accessToken,
    cloudId: tokens.cloudId,
    ...(apiRoot === undefined ? {} : { apiRoot }),
  };
}

async function resolveTokens(program: Command): Promise<JiraTokens> {
  return await requireStoredOrRefreshJiraTokens(toAuthOptions(program));
}

async function clearStoredJiraConnection(program: Command): Promise<void> {
  await disconnectJira(toAuthOptions(program));
}

function toAuthOptions(program: Command): JiraAuthOptions {
  const flags = program.opts<GlobalFlags>();
  const port = parseOptionalPositiveInteger(flags.port, "--port <number>");
  return {
    ...(flags.clientId === undefined ? {} : { clientId: flags.clientId }),
    ...(flags.clientSecret === undefined ? {} : { clientSecret: flags.clientSecret }),
    ...(port === undefined ? {} : { port }),
    ...(flags.tokenStore === undefined ? {} : { tokenStorePath: flags.tokenStore }),
  };
}

function resolveApiRoot(flags: GlobalFlags): string | undefined {
  return flags.apiRoot ?? process.env["SAPTOOLS_JIRA_API_ROOT"];
}

function normalizeWorklogStarted(raw: string | undefined, now: Date): string {
  if (raw === undefined) {
    return formatJiraDate(now);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/u.test(raw)) {
    return raw;
  }
  return Number.isNaN(new Date(raw).getTime()) ? formatJiraDate(now) : raw;
}

function toWorklogsFilter(flags: WorklogsFlags): WorklogSummaryFilter {
  return {
    ...(flags.day === undefined ? {} : { day: flags.day }),
    ...(flags.from === undefined ? {} : { from: flags.from }),
    ...(flags.issue === undefined ? {} : { issueKey: flags.issue }),
    ...(flags.month === undefined ? {} : { month: flags.month }),
    ...(flags.to === undefined ? {} : { to: flags.to }),
  };
}

function parseWorklogsGroupBy(raw: string | undefined): "day" | "issue" {
  if (raw === undefined || raw === "issue") {
    return "issue";
  }
  if (raw === "day") {
    return "day";
  }
  throw new Error("--group-by <day|issue> must be day or issue");
}

function notifyUsersOption(flags: { readonly notifyUsers?: boolean }): { readonly notifyUsers?: boolean } {
  return flags.notifyUsers === false ? { notifyUsers: false } : {};
}

function formatWorklogSummary(summary: WorklogSummary): string {
  const lines = [
    `Total: ${summary.minutes.toString()} minutes (${summary.hours} hours)`,
    `Entries: ${summary.entries.length.toString()}`,
  ];
  if (summary.groups.length === 0) {
    return [...lines, "No local Jira worklog history found."].join("\n");
  }
  return [
    ...lines,
    `Grouped by ${summary.groupBy}:`,
    ...summary.groups.map((group) => `${group.key}\t${group.minutes.toString()} minutes\t${group.hours} hours`),
  ].join("\n");
}

function parseRequiredPositiveInteger(raw: string | undefined, label: string): number {
  const parsed = parseOptionalPositiveInteger(raw, label);
  if (parsed === undefined) {
    throw new Error(`required option '${label}'`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${label} must be a positive integer`);
}

function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`required option '${label}'`);
  }

  return value;
}


async function requireSnapshot(cloudId: string): Promise<CustomFieldSnapshot> {
  const snapshot = await readCustomFieldSnapshot(cloudId);
  if (snapshot === null) {
    throw new Error("No custom field snapshot found. Run `jira fields discover` first.");
  }
  return snapshot;
}

function emptyPinnedConfig(cloudId: string, cloudName: string): PinnedCustomFieldConfig {
  return {
    version: 1 as const,
    cloudId,
    cloudName,
    updatedAt: new Date(0).toISOString(),
    fields: [],
  };
}

function fieldResolutionError(fieldName: string, count: number, source: string): Error {
  return new Error(count === 0
    ? `No exact display-name match for "${fieldName}" in ${source}. Run \`jira fields discover --search <text>\` or \`jira fields search <text>\` to inspect available fields, then retry with the correct display name.`
    : `Multiple exact display-name matches for "${fieldName}" in ${source}. Run \`jira fields discover --search <text>\` or \`jira fields search <text>\` to inspect available fields, then retry with the correct display name.`);
}

function firstResolvedField<T extends { readonly name: string }>(matches: readonly T[], fieldName: string): T {
  const field = matches[0];
  if (field === undefined) {
    throw new Error(`No exact display-name match for "${fieldName}".`);
  }
  return field;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function writeOutputWithOptionalHint(
  program: Command,
  cloudId: string,
  value: unknown,
  isJson: boolean,
): Promise<void> {
  if (isJson) {
    writeOutput(value);
    return;
  }

  const flags = program.opts<GlobalFlags>();
  const hint = flags.hints === false
    ? ""
    : formatPinnedCustomFieldHint(await readPinnedCustomFields(cloudId));
  writeOutput(typeof value === "string" && hint.length > 0 ? `${value}\n\n${hint}` : value);
}

function writeOutput(value: unknown): void {
  process.stdout.write(
    typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function writeErrorOutput(value: unknown): void {
  process.stderr.write(
    typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function maskSensitiveText(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("[REDACTED]"), text);
}

interface PackageMetadata {
  readonly version: string;
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPackageMetadata(parsed) ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly version?: unknown }).version === "string" &&
    (value as PackageMetadata).version.length > 0
  );
}

try {
  await main(process.argv);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [
    process.env["JIRA_CLIENT_SECRET"] ?? "",
    process.env["JIRA_CLIENT_ID"] ?? "",
  ];
  process.stderr.write(`Error: ${maskSensitiveText(message, secrets)}\n`);
  process.exit(1);
}
