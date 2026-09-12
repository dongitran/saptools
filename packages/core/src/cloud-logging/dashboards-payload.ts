function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the first `{...}` JSON object embedded in noisy `cf` CLI stdout
 * (progress lines, "OK", etc. can surround the actual payload).
 */
function extractFirstJsonObject(stdout: string): string {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error("no JSON object found");
  }
  let depth = 0;
  for (let i = start; i < stdout.length; i += 1) {
    if (stdout[i] === "{") {
      depth += 1;
    } else if (stdout[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return stdout.slice(start, i + 1);
      }
    }
  }
  throw new Error("unterminated JSON object");
}

/**
 * Parse a JSON payload that may contain secrets (a service-key response, an
 * instance's params blob) without ever surfacing the underlying parser's own
 * error message: V8's `JSON.parse` can quote a verbatim snippet of the
 * source text next to a malformed token, and for these specific payloads
 * that snippet can be a credential value sitting right next to it.
 */
export function parseCredentialJson(stdout: string, contextLabel: string): unknown {
  let text: string;
  try {
    text = extractFirstJsonObject(stdout);
  } catch {
    throw new Error(`Could not find a JSON object in the ${contextLabel}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Could not parse the ${contextLabel} as JSON (parse error details omitted — the source may contain sensitive fields).`,
    );
  }
}

/**
 * Narrow an arbitrary parsed service-key/binding payload to a usable
 * dashboards credential.
 *
 * Two shapes are accepted: the credential fields at the top level (what the
 * v3 `/details` endpoint's `credentials` object holds once the caller has
 * unwrapped it, and what `cf service-key` printed through CLI v7), and the
 * same fields nested under a `credentials` key, which is how CLI v8's
 * `cf service-key` prints them. The top level wins when both are present, so
 * an already-unwrapped payload is never re-interpreted through a nested
 * `credentials` key that happens to mean something else.
 */
export function extractDashboardsCredential(
  payload: unknown,
  source: string,
): { readonly dashboardsEndpoint: string; readonly username: string; readonly password: string; readonly source: string } | undefined {
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
