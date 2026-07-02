import { readFileSync } from "node:fs";
import process from "node:process";

import { Command } from "commander";

import {
  connectJira,
  disconnectJira,
  getJiraConnectionStatus,
  requireStoredOrRefreshJiraTokens,
} from "./auth.js";
import {
  addJiraIssueWorklog,
  fetchAssignedJiraIssues,
  fetchJiraCustomFields,
  fetchJiraIssueDetail,
  fetchJiraIssueEditMetadata,
  fetchJiraIssueRemoteLinks,
  fetchJiraIssueTransitions,
  transitionJiraIssue,
  updateJiraIssueFields,
} from "./client.js";
import { readCustomFieldSnapshot, readPinnedCustomFields, writeCustomFieldSnapshot, writePinnedCustomFields } from "./custom-field-store.js";
import { buildIssueFieldUpdate, collectFieldValueInputs } from "./custom-field-values.js";
import { createCustomFieldSnapshot, resolveFieldByDisplayName, searchCustomFields } from "./custom-fields.js";
import type { CustomFieldSnapshot, PinnedCustomFieldConfig } from "./custom-fields.js";
import {
  formatConnectionStatus,
  formatIssueDetail,
  formatIssueLinks,
  formatIssueTransitions,
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

interface FieldsDiscoverFlags extends JsonFlags { readonly search?: string; }
interface FieldsUpdateFlags extends JsonFlags { readonly field?: string[]; readonly fieldFile?: string[]; }

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
      writeOutput(flags.json === true ? status : formatConnectionStatus(status));
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
      writeOutput(flags.json === true ? status : formatConnectionStatus(status));
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
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, flags.json === true ? issues : formatIssues(issues), flags.json === true);
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
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, flags.json === true ? detail : formatIssueDetail(detail), flags.json === true);
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
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, flags.json === true ? links : formatIssueLinks(links), flags.json === true);
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
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, flags.json === true ? transitions : formatIssueTransitions(transitions), flags.json === true);
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
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, `Transition applied to ${issueKey}.`, false);
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
      await writeOutputWithOptionalHint(program, worklogOptions.cloudId, `Worklog added to ${issueKey}.`, false);
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
      const requestOptions = await toRequestOptions(program);
      const discovered = await fetchJiraCustomFields(requestOptions);
      const snapshot = createCustomFieldSnapshot({ cloudId: tokens.cloudId, cloudName: tokens.cloudName, fields: discovered.fields, totalFromApi: discovered.totalFromApi });
      await writeCustomFieldSnapshot(snapshot);
      const displayed = flags.search === undefined ? snapshot.fields : searchCustomFields(snapshot.fields, flags.search);
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
      writeOutput(flags.json === true ? (pinned ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName)) : formatPinnedCustomFields(pinned));
    });

  fields.command("pin")
    .description("Pin a custom field by exact Jira display name")
    .argument("<field-name>", "Jira field display name")
    .action(async (fieldName: string): Promise<void> => {
      const tokens = await resolveTokens(program);
      const snapshot = await requireSnapshot(tokens.cloudId);
      const matches = resolveFieldByDisplayName(snapshot.fields, fieldName);
      if (matches.length !== 1) {throw fieldResolutionError(fieldName, matches.length, "custom field snapshot");}
      const current = await readPinnedCustomFields(tokens.cloudId) ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName);
      const field = firstResolvedField(matches, fieldName);
      if (current.fields.some((item) => item.id === field.id)) { process.stdout.write(`Custom field "${field.name}" is already pinned.\n`); return; }
      await writePinnedCustomFields({ ...current, updatedAt: new Date().toISOString(), fields: [...current.fields, { id: field.id, name: field.name, schema: field.schema }] });
      process.stdout.write(`Pinned custom field "${field.name}".\n`);
    });

  fields.command("unpin")
    .description("Unpin a custom field by exact Jira display name")
    .argument("<field-name>", "Pinned Jira field display name")
    .action(async (fieldName: string): Promise<void> => {
      const tokens = await resolveTokens(program);
      const current = await readPinnedCustomFields(tokens.cloudId) ?? emptyPinnedConfig(tokens.cloudId, tokens.cloudName);
      const matches = resolveFieldByDisplayName(current.fields, fieldName);
      if (matches.length !== 1) {throw new Error(matches.length === 0 ? `Pinned field "${fieldName}" was not found.` : `Pinned field name "${fieldName}" is ambiguous.`);}
      const field = firstResolvedField(matches, fieldName);
      await writePinnedCustomFields({ ...current, updatedAt: new Date().toISOString(), fields: current.fields.filter((item) => item.id !== field.id) });
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
      if (pinned === null || pinned.fields.length === 0) {throw new Error("No pinned Jira custom fields. Run `jira fields pin <field-name>` first.");}
      const values = await collectFieldValueInputs(flags.field ?? [], flags.fieldFile ?? []);
      const editableFields = await fetchJiraIssueEditMetadata(requestOptions);
      const update = buildIssueFieldUpdate({ editableFields, issueKey, pinnedFields: pinned.fields, values });
      await updateJiraIssueFields({ ...requestOptions, fields: update.fields });
      const result = { issueKey, updatedFields: update.names };
      await writeOutputWithOptionalHint(program, requestOptions.cloudId, flags.json === true ? result : `Updated custom fields on ${issueKey}: ${update.names.join(", ")}.`, flags.json === true);
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
  const flags = program.opts<GlobalFlags>();
  const tokens = await resolveTokens(program);
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
  if (snapshot === null) {throw new Error("No custom field snapshot found. Run `jira fields discover` first.");}
  return snapshot;
}

function emptyPinnedConfig(cloudId: string, cloudName: string): PinnedCustomFieldConfig {
  return { version: 1 as const, cloudId, cloudName, updatedAt: new Date(0).toISOString(), fields: [] };
}

function fieldResolutionError(fieldName: string, count: number, source: string): Error {
  return new Error(count === 0
    ? `No exact display-name match for "${fieldName}" in ${source}. Run \`jira fields discover --search <text>\` or \`jira fields search <text>\` to inspect available fields, then retry with the correct display name.`
    : `Multiple exact display-name matches for "${fieldName}" in ${source}. Run \`jira fields discover --search <text>\` or \`jira fields search <text>\` to inspect available fields, then retry with the correct display name.`);
}

function firstResolvedField<T extends { readonly name: string }>(matches: readonly T[], fieldName: string): T {
  const field = matches[0];
  if (field === undefined) {throw new Error(`No exact display-name match for "${fieldName}".`);}
  return field;
}

function collectOption(value: string, previous: string[]): string[] { return [...previous, value]; }

async function writeOutputWithOptionalHint(program: Command, cloudId: string, value: unknown, isJson: boolean): Promise<void> {
  if (isJson) { writeOutput(value); return; }
  const flags = program.opts<GlobalFlags>();
  const hint = flags.hints === false ? "" : formatPinnedCustomFieldHint(await readPinnedCustomFields(cloudId));
  writeOutput(typeof value === "string" && hint.length > 0 ? `${value}\n\n${hint}` : value);
}

function writeOutput(value: unknown): void {
  process.stdout.write(
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
