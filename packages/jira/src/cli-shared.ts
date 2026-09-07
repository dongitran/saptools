import process from "node:process";

import type { Command } from "commander";

import { requireStoredOrRefreshJiraTokens, resolveJiraCredential } from "./auth.js";
import { readPinnedCustomFields } from "./custom-field-store.js";
import { formatPinnedCustomFieldHint } from "./format.js";
import type {
  JiraApiTokenOptions,
  JiraAuthModeSelection,
  JiraAuthOptions,
  JiraCredential,
  JiraRequestOptions,
  JiraTokens,
} from "./types.js";

export interface GlobalFlags {
  readonly apiRoot?: string;
  readonly auth?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly cloudId?: string;
  readonly hints?: boolean;
  readonly port?: string;
  readonly siteUrl?: string;
  readonly tokenStore?: string;
}

export async function toIssueRequestOptions(
  program: Command,
  issueKey: string,
): Promise<JiraRequestOptions & { readonly issueKey: string }> {
  return {
    ...(await toRequestOptions(program)),
    issueKey,
  };
}

export async function toRequestOptions(program: Command): Promise<JiraRequestOptions> {
  return toRequestOptionsFromCredential(await resolveCredential(program));
}

export function toRequestOptionsFromCredential(credential: JiraCredential): JiraRequestOptions {
  return {
    authorization: credential.authorization,
    baseUrl: credential.baseUrl,
    cloudId: credential.cloudId,
  };
}

export async function resolveCredential(program: Command): Promise<JiraCredential> {
  return await resolveJiraCredential(toAuthOptions(program));
}

/** OAuth-only path kept for `jira token`, which prints a bearer access token. */
export async function resolveTokens(program: Command): Promise<JiraTokens> {
  return await requireStoredOrRefreshJiraTokens(toAuthOptions(program));
}

export function toAuthOptions(program: Command): JiraAuthOptions {
  const flags = program.opts<GlobalFlags>();
  const port = parseOptionalPositiveInteger(flags.port, "--port <number>");
  const apiRoot = resolveApiRoot(flags);
  return {
    apiToken: toApiTokenOptions(flags),
    authMode: parseAuthMode(flags.auth),
    ...(apiRoot === undefined ? {} : { apiRoot }),
    ...(flags.clientId === undefined ? {} : { clientId: flags.clientId }),
    ...(flags.clientSecret === undefined ? {} : { clientSecret: flags.clientSecret }),
    ...(port === undefined ? {} : { port }),
    ...(flags.tokenStore === undefined ? {} : { tokenStorePath: flags.tokenStore }),
  };
}

export function parseAuthMode(raw: string | undefined): JiraAuthModeSelection {
  if (raw === undefined || raw === "auto" || raw === "api-token" || raw === "oauth") {
    return raw ?? "auto";
  }

  throw new Error("--auth <mode> must be auto, api-token, or oauth");
}

export function parseOptionalPositiveInteger(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${label} must be a positive integer`);
}

export async function writeOutputWithOptionalHint(
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

export function writeOutput(value: unknown): void {
  process.stdout.write(
    typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`,
  );
}

/** The API token itself is never a flag: flags leak into `ps` output and shell history. */
function toApiTokenOptions(flags: GlobalFlags): JiraApiTokenOptions {
  return {
    ...(flags.cloudId === undefined ? {} : { cloudId: flags.cloudId }),
    ...(flags.siteUrl === undefined ? {} : { siteUrl: flags.siteUrl }),
  };
}

function resolveApiRoot(flags: GlobalFlags): string | undefined {
  return flags.apiRoot ?? process.env["SAPTOOLS_JIRA_API_ROOT"];
}
