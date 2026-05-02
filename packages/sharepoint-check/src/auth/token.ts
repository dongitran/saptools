import process from "node:process";

import type { FetchLike } from "../graph/client.js";
import type { AccessTokenInfo, SharePointCredentials } from "../types.js";
import { DEFAULT_AUTH_BASE, ENV_AUTH_BASE } from "../types.js";

export interface AcquireTokenOptions {
  readonly authBase?: string;
  readonly scope?: string;
  readonly fetchFn?: FetchLike;
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

function resolveAuthBase(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.replace(/\/+$/, "");
  }

  const fromEnv = process.env[ENV_AUTH_BASE];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv.replace(/\/+$/, "");
  }

  return DEFAULT_AUTH_BASE;
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

  const authBase = resolveAuthBase(options.authBase);
  const scope = options.scope ?? DEFAULT_SCOPE;
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${authBase}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`;

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope,
  });

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  const text = await response.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch (err) {
    throw new Error(
      `Failed to parse token response (HTTP ${response.status.toString()}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  if (!response.ok || typeof parsed.error === "string") {
    const code = typeof parsed.error === "string" ? parsed.error : "unknown_error";
    const description =
      typeof parsed.error_description === "string" && parsed.error_description.length > 0
        ? parsed.error_description
        : response.statusText;
    throw new Error(
      `Azure AD token request failed (HTTP ${response.status.toString()} ${code}): ${description}`,
    );
  }

  const accessToken = assertString(parsed.access_token, "access_token");
  const tokenType = assertString(parsed.token_type, "token_type");
  const expiresIn = assertNumber(parsed.expires_in, "expires_in");
  const scopeValue = typeof parsed.scope === "string" ? parsed.scope : undefined;

  const info: AccessTokenInfo =
    scopeValue === undefined
      ? {
          accessToken,
          tokenType,
          expiresOn: Math.floor(Date.now() / 1000) + expiresIn,
        }
      : {
          accessToken,
          tokenType,
          expiresOn: Math.floor(Date.now() / 1000) + expiresIn,
          scope: scopeValue,
        };

  return info;
}
