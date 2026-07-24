import process from "node:process";

import type { Command } from "commander";

import { requireStoredOrRefreshJiraTokens } from "./auth.js";
import { readPinnedCustomFields } from "./custom-field-store.js";
import { formatPinnedCustomFieldHint } from "./format.js";
import type { JiraAuthOptions, JiraRequestOptions, JiraTokens } from "./types.js";

export interface GlobalFlags {
  readonly apiRoot?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly hints?: boolean;
  readonly port?: string;
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
  return toRequestOptionsFromTokens(program, await resolveTokens(program));
}

export function toRequestOptionsFromTokens(
  program: Command,
  tokens: JiraTokens,
): JiraRequestOptions {
  const apiRoot = resolveApiRoot(program.opts<GlobalFlags>());
  return {
    accessToken: tokens.accessToken,
    cloudId: tokens.cloudId,
    ...(apiRoot === undefined ? {} : { apiRoot }),
  };
}

export async function resolveTokens(program: Command): Promise<JiraTokens> {
  return await requireStoredOrRefreshJiraTokens(toAuthOptions(program));
}

export function toAuthOptions(program: Command): JiraAuthOptions {
  const flags = program.opts<GlobalFlags>();
  const port = parseOptionalPositiveInteger(flags.port, "--port <number>");
  return {
    ...(flags.clientId === undefined ? {} : { clientId: flags.clientId }),
    ...(flags.clientSecret === undefined ? {} : { clientSecret: flags.clientSecret }),
    ...(port === undefined ? {} : { port }),
    ...(flags.tokenStore === undefined ? {} : { tokenStorePath: flags.tokenStore }),
  };
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

function resolveApiRoot(flags: GlobalFlags): string | undefined {
  return flags.apiRoot ?? process.env["SAPTOOLS_JIRA_API_ROOT"];
}
