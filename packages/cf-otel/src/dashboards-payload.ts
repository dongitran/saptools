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

/**
 * Narrow an arbitrary parsed service-key payload to a usable dashboards
 * credential.
 *
 * Two shapes are accepted. The credential fields can sit at the top level,
 * which is what `cf service-key` printed through CLI v7 and what a
 * VCAP_SERVICES entry's `credentials` object holds once the caller has
 * unwrapped it; or they can be nested under a `credentials` key, which is how
 * CLI v8 prints them (`DisplayJSON` of a struct whose only field is
 * `credentials`). Both `tryServiceKeys` and the minting path read
 * `cf service-key` directly, so without the second shape every `--service-key`
 * lookup came back empty and a freshly minted key looked empty too — the
 * latter only after SAML had already been disabled on a shared instance.
 *
 * The top level wins when it carries the fields, so an already-unwrapped
 * payload is never re-interpreted through a `credentials` key that happens to
 * mean something else.
 */
export function extractDashboardsCredential(
  payload: unknown,
  source: string,
): DashboardsCredential | undefined {
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
