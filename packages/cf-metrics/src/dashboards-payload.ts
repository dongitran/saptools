import { extractFirstJsonObject } from "./cf.js";
import { CfMetricsError, type CfMetricsErrorCode } from "./errors.js";
import type { DashboardsCredentialPayload } from "./types.js";

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
  code: CfMetricsErrorCode = "CREDENTIALS_NOT_FOUND",
): unknown {
  let text: string;
  try {
    text = extractFirstJsonObject(stdout);
  } catch {
    throw new CfMetricsError(code, `Could not find a JSON object in the ${contextLabel}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CfMetricsError(
      code,
      `Could not parse the ${contextLabel} as JSON (parse error details omitted — the source may contain sensitive fields).`,
    );
  }
}

/**
 * Narrow an arbitrary parsed service-key payload to a usable dashboards
 * credential; the caller attributes it to an instance.
 *
 * Two shapes are accepted: the credential fields at the top level (what the
 * v3 `/details` endpoint's `credentials` object holds once the caller has
 * unwrapped it, and what `cf service-key` printed through CLI v7), and the
 * same fields nested under a `credentials` key, which is how CLI v8's
 * `cf service-key` prints them. The minting path reads `cf service-key`
 * directly, so without the second shape a freshly minted key looked empty.
 */
export function extractDashboardsCredential(
  payload: unknown,
  source: string,
): DashboardsCredentialPayload | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const nested = payload["credentials"];
  const fields = payload["dashboards-endpoint"] === undefined && isRecord(nested) ? nested : payload;
  const endpoint = fields["dashboards-endpoint"];
  const username = fields["dashboards-username"];
  const password = fields["dashboards-password"];
  if (typeof endpoint !== "string" || typeof username !== "string" || typeof password !== "string") {
    return undefined;
  }
  if (endpoint.length === 0 || username.length === 0 || password.length === 0) {
    return undefined;
  }
  return { dashboardsEndpoint: endpoint, username, password, source };
}
