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
  fetchJiraIssueDetail,
  fetchJiraIssueRemoteLinks,
  fetchJiraIssueTransitions,
  transitionJiraIssue,
} from "./client.js";
import {
  formatConnectionStatus,
  formatIssueDetail,
  formatIssueLinks,
  formatIssueTransitions,
  formatIssues,
} from "./format.js";
import type {
  AddJiraIssueWorklogOptions,
  FetchAssignedJiraIssuesOptions,
  FetchJiraIssueDetailOptions,
  JiraAuthOptions,
  JiraRequestOptions,
  JiraTokens,
} from "./types.js";

interface GlobalFlags {
  readonly apiRoot?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly port?: string;
  readonly tokenStore?: string;
}

interface JsonFlags {
  readonly json?: boolean;
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

interface WorklogFlags {
  readonly comment?: string;
  readonly minutes?: string;
  readonly started?: string;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("jira")
    .description("Jira Cloud CLI that reuses the JiraOps OAuth token store")
    .option("--api-root <url>", "Jira API root for Atlassian Cloud or tests")
    .option("--token-store <path>", "Path to the shared jira-oauth-client token store")
    .option("--client-id <id>", "Atlassian OAuth app client ID")
    .option("--client-secret <secret>", "Atlassian OAuth app client secret")
    .option("--port <number>", "OAuth callback port");

  addStatusCommand(program);
  addConnectCommand(program);
  addDisconnectCommand(program);
  addTokenCommand(program);
  addIssuesCommand(program);
  addIssueCommand(program);
  addLinksCommand(program);
  addTransitionsCommand(program);
  addTransitionCommand(program);
  addWorklogCommand(program);

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
      await disconnectJira(toAuthOptions(program));
      process.stdout.write("Disconnected from Jira.\n");
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
      writeOutput(flags.json === true ? issues : formatIssues(issues));
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
      writeOutput(flags.json === true ? detail : formatIssueDetail(detail));
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
      writeOutput(flags.json === true ? links : formatIssueLinks(links));
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
      writeOutput(flags.json === true ? transitions : formatIssueTransitions(transitions));
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
      process.stdout.write(`Transition applied to ${issueKey}.\n`);
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
      await addJiraIssueWorklog(await toWorklogOptions(program, issueKey, flags));
      process.stdout.write(`Worklog added to ${issueKey}.\n`);
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
): Promise<AddJiraIssueWorklogOptions> {
  const requestOptions = await toIssueRequestOptions(program, issueKey);
  const minutes = parseRequiredPositiveInteger(flags.minutes, "--minutes <number>");
  return {
    ...requestOptions,
    minutes,
    ...(flags.comment === undefined ? {} : { comment: flags.comment }),
    ...(flags.started === undefined ? {} : { started: flags.started }),
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
