import { Buffer } from "node:buffer";

import type { XsuaaCredentials } from "../types.js";

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

export interface FetchTokenOptions {
  readonly fetchImpl?: typeof fetch;
  readonly grantType?: "client_credentials";
}

export async function fetchClientCredentialsToken(
  creds: XsuaaCredentials,
  opts: FetchTokenOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL("/oauth/token", creds.url).toString();

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: opts.grantType ?? "client_credentials" });

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`XSUAA token request failed: ${res.status.toString()} ${text}`);
  }

  const parsed = (await res.json()) as OAuthTokenResponse;
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("XSUAA token response missing access_token");
  }
  return parsed.access_token;
}
