import { JiraOAuthClient } from "jira-oauth-client";

import {
  hasJiraApiToken,
  JIRA_API_TOKEN_REQUIRED_MESSAGE,
  resolveJiraApiTokenCredential,
} from "./api-token.js";
import { bearerAuthorizationHeader } from "./jira-http.js";
import {
  clearJiraTokenStore,
  readJiraTokens,
  writeJiraTokens,
} from "./token-store.js";
import type {
  JiraAuthOptions,
  JiraConnectionStatus,
  JiraCredential,
  JiraOAuthClientLike,
  JiraOAuthClientOptions,
  JiraTokens,
} from "./types.js";
import { buildJiraCloudBaseUrl } from "./urls.js";

const TOKEN_REFRESH_SAFETY_WINDOW_MS = 60_000;

export function isJiraTokenUsable(tokens: JiraTokens, nowMs = Date.now()): boolean {
  const expiresAtMs = tokens.issuedAt + tokens.expiresIn * 1000;
  return expiresAtMs - TOKEN_REFRESH_SAFETY_WINDOW_MS > nowMs;
}

/**
 * Picks the credential every Jira request uses. A configured Atlassian API token wins over the
 * shared OAuth token store, because an operator who exports one is asking for that identity.
 */
export async function resolveJiraCredential(
  options: JiraAuthOptions = {},
): Promise<JiraCredential> {
  const apiTokenCredential = selectJiraApiTokenCredential(options);
  if (apiTokenCredential !== null) {
    return apiTokenCredential;
  }

  const tokens = await requireStoredOrRefreshJiraTokens(options);
  return toJiraOAuthCredential(tokens, options.apiRoot);
}

export function toJiraOAuthCredential(tokens: JiraTokens, apiRoot?: string): JiraCredential {
  return {
    authMode: "oauth",
    authorization: bearerAuthorizationHeader(tokens.accessToken),
    baseUrl: buildJiraCloudBaseUrl(tokens.cloudId, apiRoot),
    cloudId: tokens.cloudId,
    cloudName: tokens.cloudName,
    email: null,
    siteUrl: null,
  };
}

/**
 * True when Jira requests would authenticate with an API token instead of the OAuth store.
 *
 * Deliberately a total predicate: it asks only whether a token is configured, so a half-configured
 * token still reads as "preferred" and its validation error surfaces from the command that uses it
 * rather than from an unrelated caller such as the warning after a successful `jira connect`.
 */
export function isJiraApiTokenPreferred(options: JiraAuthOptions = {}): boolean {
  return (options.authMode ?? "auto") !== "oauth" && hasJiraApiToken(options.apiToken);
}

export async function getJiraConnectionStatus(
  options: JiraAuthOptions = {},
): Promise<JiraConnectionStatus> {
  const apiTokenCredential = selectJiraApiTokenCredential(options);
  if (apiTokenCredential !== null) {
    return toJiraConnectionStatus(apiTokenCredential, true);
  }

  const tokens = await readJiraTokens(options.tokenStorePath);
  return tokens === null
    ? disconnectedJiraStatus()
    : toJiraConnectionStatus(toJiraOAuthCredential(tokens, options.apiRoot), isJiraTokenUsable(tokens));
}

export async function getStoredOrRefreshJiraTokens(
  options: JiraAuthOptions = {},
): Promise<JiraTokens | null> {
  const storedTokens = await readJiraTokens(options.tokenStorePath);
  if (storedTokens === null) {
    return null;
  }

  if (isJiraTokenUsable(storedTokens)) {
    return storedTokens;
  }

  const client = await createOAuthClient(options);
  const refreshedTokens = await client.refresh(storedTokens.refreshToken);
  await writeJiraTokens(refreshedTokens, options.tokenStorePath);
  return refreshedTokens;
}

export async function requireStoredOrRefreshJiraTokens(
  options: JiraAuthOptions = {},
): Promise<JiraTokens> {
  const tokens = await getStoredOrRefreshJiraTokens(options);
  if (tokens === null) {
    throw new Error(
      "Jira token is required. Run `jira connect` first, reuse JiraOps' shared token store, or set JIRA_API_TOKEN for Atlassian API token auth.",
    );
  }

  return tokens;
}

export async function connectJira(options: JiraAuthOptions = {}): Promise<JiraTokens> {
  const client = await createOAuthClient(options);
  const tokens = await client.authenticate();
  await writeJiraTokens(tokens, options.tokenStorePath);
  return tokens;
}

export async function disconnectJira(
  options: Pick<JiraAuthOptions, "tokenStorePath"> = {},
): Promise<void> {
  await clearJiraTokenStore(options.tokenStorePath);
}

/**
 * Resolves the API token credential subject to the selected mode. `--auth oauth` skips it
 * entirely; `--auth api-token` refuses to fall back when nothing is configured.
 */
function selectJiraApiTokenCredential(options: JiraAuthOptions): JiraCredential | null {
  const mode = options.authMode ?? "auto";
  if (mode === "oauth") {
    return null;
  }

  const credential = resolveJiraApiTokenCredential(options.apiToken, options.apiRoot);
  if (credential === null && mode === "api-token") {
    throw new Error(JIRA_API_TOKEN_REQUIRED_MESSAGE);
  }
  return credential;
}

/**
 * Projects a credential onto the printable status shape. It deliberately drops `authorization`,
 * so no bearer token or Basic credential can reach `jira status` or `jira connect` output.
 */
export function toJiraConnectionStatus(
  credential: JiraCredential,
  usable: boolean,
): JiraConnectionStatus {
  return {
    authMode: credential.authMode,
    baseUrl: credential.baseUrl,
    connected: true,
    cloudId: credential.cloudId,
    cloudName: credential.cloudName,
    email: credential.email,
    siteUrl: credential.siteUrl,
    usable,
  };
}

function disconnectedJiraStatus(): JiraConnectionStatus {
  return {
    authMode: null,
    baseUrl: null,
    connected: false,
    cloudId: null,
    cloudName: null,
    email: null,
    siteUrl: null,
    usable: false,
  };
}

async function createOAuthClient(options: JiraAuthOptions): Promise<JiraOAuthClientLike> {
  const clientOptions = toOAuthClientOptions(options);
  return options.clientFactory === undefined
    ? new JiraOAuthClient(clientOptions)
    : await options.clientFactory(clientOptions);
}

function toOAuthClientOptions(options: JiraAuthOptions): JiraOAuthClientOptions {
  return {
    ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
    ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.scopes === undefined ? {} : { scopes: [...options.scopes] }),
    ...(options.tokenStorePath === undefined ? {} : { tokenStorePath: options.tokenStorePath }),
    ...(options.urls === undefined ? {} : { urls: options.urls }),
  };
}
