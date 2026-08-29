import { extractFirstJsonObject } from "./cf.js";
import { CfOtelError, type CfOtelErrorCode } from "./errors.js";
import type { DashboardsCredential } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON payload that may contain secrets (a service-key response, an
 * instance's params blob) without ever surfacing the underlying parser's own
 * error message: V8's `JSON.parse` can quote a verbatim snippet of the
 * source text next to a malformed token, and for these specific payloads
 * that snippet can be a credential value sitting right next to it.
 */
export function parseCredentialJson(
  stdout: string,
  contextLabel: string,
  code: CfOtelErrorCode = "CREDENTIALS_NOT_FOUND",
): unknown {
  let text: string;
  try {
    text = extractFirstJsonObject(stdout);
  } catch {
    throw new CfOtelError(code, `Could not find a JSON object in the ${contextLabel}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CfOtelError(
      code,
      `Could not parse the ${contextLabel} as JSON (parse error details omitted — the source may contain sensitive fields).`,
    );
  }
}

/** Narrow an arbitrary parsed service-key payload to a usable dashboards credential. */
export function extractDashboardsCredential(
  payload: unknown,
  source: string,
): DashboardsCredential | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const endpoint = payload["dashboards-endpoint"];
  const username = payload["dashboards-username"];
  const password = payload["dashboards-password"];
  if (typeof endpoint !== "string" || typeof username !== "string" || typeof password !== "string") {
    return undefined;
  }
  if (endpoint.length === 0 || username.length === 0 || password.length === 0) {
    return undefined;
  }
  return { dashboardsEndpoint: endpoint, username, password, source };
}
