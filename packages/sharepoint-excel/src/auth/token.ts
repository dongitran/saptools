import process from "node:process";

import type { FetchLike } from "../graph/client.js";
import type { AccessTokenInfo, SharePointCredentials } from "../types.js";
import { DEFAULT_AUTH_BASE, ENV_AUTH_BASE } from "../types.js";

export interface AcquireTokenOptions {
  readonly authBase?: string;
  readonly scope?: string;
  readonly fetchFn?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

const DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

function resolveAuthBase(options: AcquireTokenOptions): string {
  if (options.authBase !== undefined && options.authBase.length > 0) {
    return options.authBase.replace(/(?<!\/)\/+$/, "");
  }
  const fromEnv = (options.env ?? process.env)[ENV_AUTH_BASE];
  return fromEnv === undefined || fromEnv.length === 0
    ? DEFAULT_AUTH_BASE
    : fromEnv.replace(/(?<!\/)\/+$/, "");
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Token response missing field: ${field}`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Token response missing numeric field: ${field}`);
  }
  return value;
}

function parseTokenResponse(text: string, status: number): TokenResponse {
  try {
    return JSON.parse(text) as TokenResponse;
  } catch (err) {
    throw new Error(`Failed to parse token response (HTTP ${status.toString()})`, { cause: err });
  }
}

function throwIfTokenError(response: Response, parsed: TokenResponse): void {
  if (response.ok && typeof parsed.error !== "string") {
    return;
  }
  const code = typeof parsed.error === "string" ? parsed.error : "unknown_error";
  const description =
    typeof parsed.error_description === "string" && parsed.error_description.length > 0
      ? parsed.error_description
      : response.statusText;
  throw new Error(
    `Azure AD token request failed (HTTP ${response.status.toString()} ${code}): ${description}`,
  );
}

export async function acquireAppToken(
  credentials: SharePointCredentials,
  options: AcquireTokenOptions = {},
): Promise<AccessTokenInfo> {
  if (credentials.tenantId.length === 0) {
    throw new Error("tenantId is required");
  }
  if (credentials.clientId.length === 0) {
    throw new Error("clientId is required");
  }
  if (credentials.clientSecret.length === 0) {
    throw new Error("clientSecret is required");
  }

  const authBase = resolveAuthBase(options);
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${authBase}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: options.scope ?? DEFAULT_SCOPE,
  });

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const parsed = parseTokenResponse(await response.text(), response.status);
  throwIfTokenError(response, parsed);

  const scopeValue = typeof parsed.scope === "string" ? parsed.scope : undefined;
  const base = {
    accessToken: assertString(parsed.access_token, "access_token"),
    tokenType: assertString(parsed.token_type, "token_type"),
    expiresOn: Math.floor(Date.now() / 1000) + assertNumber(parsed.expires_in, "expires_in"),
  };
  return scopeValue === undefined ? base : { ...base, scope: scopeValue };
}
