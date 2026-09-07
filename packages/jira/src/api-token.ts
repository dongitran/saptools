import process from "node:process";

import { z } from "zod";

import { basicAuthorizationHeader, encodeBasicCredential } from "./jira-http.js";
import type { JiraApiTokenOptions, JiraCredential, JiraEnvironment } from "./types.js";
import { buildJiraCloudBaseUrl, DEFAULT_JIRA_API_ROOT, trimTrailingSlash } from "./urls.js";

/** Where the Atlassian API token is created. Quoted in every configuration error. */
export const JIRA_API_TOKEN_PAGE_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

export const JIRA_API_TOKEN_ENV_VARS = ["JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN"] as const;
export const JIRA_EMAIL_ENV_VARS = ["JIRA_EMAIL", "ATLASSIAN_EMAIL"] as const;
export const JIRA_SITE_URL_ENV_VARS = ["JIRA_SITE_URL", "JIRA_BASE_URL"] as const;
export const JIRA_CLOUD_ID_ENV_VARS = ["JIRA_CLOUD_ID"] as const;

export const JIRA_API_TOKEN_REQUIRED_MESSAGE = [
  "An Atlassian API token is required.",
  `Set ${JIRA_API_TOKEN_ENV_VARS[0]} and ${JIRA_EMAIL_ENV_VARS[0]}, plus`,
  `${JIRA_SITE_URL_ENV_VARS[0]} (classic token) or ${JIRA_CLOUD_ID_ENV_VARS[0]} (scoped token).`,
  `Create a token at ${JIRA_API_TOKEN_PAGE_URL}`,
].join(" ");

/** Rejects header injection through a credential that carries CR, LF, or any other control byte. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

interface Setting {
  readonly label: string;
  readonly value: string;
}

interface JiraApiTokenInput {
  readonly apiToken: Setting;
  readonly cloudId: Setting | null;
  readonly email: Setting | null;
  readonly siteUrl: Setting | null;
}

const emailSchema = z.email();
const urlSchema = z.url();

/**
 * Builds the Basic credential when the environment supplies an API token.
 *
 * Returns `null` only when no token is configured at all. A token with missing or malformed
 * companions throws instead of falling back, so a misconfiguration can never silently act as a
 * different Jira identity.
 */
export function resolveJiraApiTokenCredential(
  options: JiraApiTokenOptions = {},
  apiRoot: string = DEFAULT_JIRA_API_ROOT,
): JiraCredential | null {
  const input = readJiraApiTokenInput(options);
  return input === null ? null : toApiTokenCredential(input, apiRoot);
}

export function hasJiraApiToken(options: JiraApiTokenOptions = {}): boolean {
  return readJiraApiTokenInput(options) !== null;
}

/**
 * Every string that must never reach stdout or stderr: the raw tokens and the base64 credentials
 * derived from them, so a leaked `Authorization` header value is masked too.
 */
export function jiraApiTokenSecrets(env: JiraEnvironment = process.env): readonly string[] {
  const tokens = collectEnvValues(env, JIRA_API_TOKEN_ENV_VARS);
  const emails = collectEnvValues(env, JIRA_EMAIL_ENV_VARS);
  const encoded = tokens.flatMap((token) =>
    emails.map((email) => encodeBasicCredential(email, token)),
  );
  return [...tokens, ...encoded];
}

function readJiraApiTokenInput(options: JiraApiTokenOptions): JiraApiTokenInput | null {
  const env = options.env ?? process.env;
  const apiToken = readSetting(options.apiToken, "the apiToken option", env, JIRA_API_TOKEN_ENV_VARS);
  if (apiToken === null) {
    return null;
  }

  return {
    apiToken,
    cloudId: readSetting(options.cloudId, "--cloud-id", env, JIRA_CLOUD_ID_ENV_VARS),
    email: readSetting(options.email, "the email option", env, JIRA_EMAIL_ENV_VARS),
    siteUrl: readSetting(options.siteUrl, "--site-url", env, JIRA_SITE_URL_ENV_VARS),
  };
}

interface ApiTokenTarget {
  readonly baseUrl: string;
  readonly cloudId: string;
  readonly cloudName: string;
}

function toApiTokenCredential(input: JiraApiTokenInput, apiRoot: string): JiraCredential {
  const apiToken = requireCleanSecret(input.apiToken);
  const email = requireEmail(input.email, input.apiToken.label);
  const siteUrl = input.siteUrl === null ? null : requireSiteUrl(input.siteUrl);
  const cloudId = input.cloudId === null ? null : requireCleanSecret(input.cloudId);
  const target = resolveApiTokenTarget(siteUrl, cloudId, apiRoot, input.apiToken.label);

  return {
    authMode: "api-token",
    authorization: basicAuthorizationHeader(email, apiToken),
    baseUrl: target.baseUrl,
    cloudId: target.cloudId,
    cloudName: target.cloudName,
    email,
    siteUrl,
  };
}

/**
 * A classic API token answers only on its own site; a scoped API token answers only on the
 * Atlassian gateway. The configured target therefore picks the base URL outright.
 */
function resolveApiTokenTarget(
  siteUrl: string | null,
  cloudId: string | null,
  apiRoot: string,
  tokenLabel: string,
): ApiTokenTarget {
  if (siteUrl !== null) {
    const host = siteHostKey(siteUrl);
    return { baseUrl: siteUrl, cloudId: cloudId ?? host, cloudName: host };
  }
  if (cloudId !== null) {
    return { baseUrl: buildJiraCloudBaseUrl(cloudId, apiRoot), cloudId, cloudName: cloudId };
  }
  throw missingTargetError(tokenLabel);
}

function requireCleanSecret(setting: Setting): string {
  const value = setting.value;
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${setting.label} must not contain control characters. Re-copy the value.`);
  }
  return value;
}

function requireEmail(setting: Setting | null, tokenLabel: string): string {
  if (setting === null) {
    throw new Error(
      `${JIRA_EMAIL_ENV_VARS[0]} is required when ${tokenLabel} is set. Atlassian API tokens authenticate over HTTP Basic as "email:token".`,
    );
  }
  const email = requireCleanSecret(setting);
  if (!emailSchema.safeParse(email).success) {
    throw new Error(
      `${setting.label} must be the Atlassian account email address that owns the API token, for example fred@example.com.`,
    );
  }
  return email;
}

function requireSiteUrl(setting: Setting): string {
  const normalized = normalizeJiraSiteUrl(requireCleanSecret(setting));
  if (normalized === null) {
    throw new Error(
      `${setting.label} must be an http(s) URL such as https://your-domain.atlassian.net.`,
    );
  }
  return normalized;
}

function missingTargetError(tokenLabel: string): Error {
  return new Error(
    [
      `${JIRA_SITE_URL_ENV_VARS[0]} or ${JIRA_CLOUD_ID_ENV_VARS[0]} is required when ${tokenLabel} is set.`,
      `Use ${JIRA_SITE_URL_ENV_VARS[0]}=https://your-domain.atlassian.net for a classic API token,`,
      `or ${JIRA_CLOUD_ID_ENV_VARS[0]} for a scoped API token, which only answers on ${DEFAULT_JIRA_API_ROOT}/<cloud-id>.`,
    ].join(" "),
  );
}

/** Keeps any path prefix (test servers use one) but drops the query, hash, and trailing slash. */
export function normalizeJiraSiteUrl(raw: string): string | null {
  if (!urlSchema.safeParse(raw).success) {
    return null;
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  return trimTrailingSlash(`${url.origin}${url.pathname}`);
}

function siteHostKey(siteUrl: string): string {
  return new URL(siteUrl).host;
}

function readSetting(
  override: string | undefined,
  overrideLabel: string,
  env: JiraEnvironment,
  names: readonly string[],
): Setting | null {
  const overridden = override?.trim() ?? "";
  if (overridden.length > 0) {
    return { label: overrideLabel, value: overridden };
  }
  for (const name of names) {
    const value = env[name]?.trim() ?? "";
    if (value.length > 0) {
      return { label: name, value };
    }
  }
  return null;
}

function collectEnvValues(env: JiraEnvironment, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const value = env[name]?.trim() ?? "";
    return value.length === 0 ? [] : [value];
  });
}
