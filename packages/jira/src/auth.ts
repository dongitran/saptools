import { JiraOAuthClient } from "jira-oauth-client";

import {
  clearJiraTokenStore,
  readJiraTokens,
  writeJiraTokens,
} from "./token-store.js";
import type {
  JiraAuthOptions,
  JiraConnectionStatus,
  JiraOAuthClientLike,
  JiraOAuthClientOptions,
  JiraTokens,
} from "./types.js";

const TOKEN_REFRESH_SAFETY_WINDOW_MS = 60_000;

export function isJiraTokenUsable(tokens: JiraTokens, nowMs = Date.now()): boolean {
  const expiresAtMs = tokens.issuedAt + tokens.expiresIn * 1000;
  return expiresAtMs - TOKEN_REFRESH_SAFETY_WINDOW_MS > nowMs;
}

export async function getJiraConnectionStatus(
  options: Pick<JiraAuthOptions, "tokenStorePath"> = {},
): Promise<JiraConnectionStatus> {
  const tokens = await readJiraTokens(options.tokenStorePath);
  return tokens === null ? disconnectedJiraStatus() : connectedJiraStatus(tokens);
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
      "Jira token is required. Run `jira connect` first or reuse JiraOps' shared token store.",
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

function connectedJiraStatus(tokens: JiraTokens): JiraConnectionStatus {
  return {
    connected: true,
    cloudId: tokens.cloudId,
    cloudName: tokens.cloudName,
    usable: isJiraTokenUsable(tokens),
  };
}

function disconnectedJiraStatus(): JiraConnectionStatus {
  return {
    connected: false,
    cloudId: null,
    cloudName: null,
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
