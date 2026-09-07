import { Buffer } from "node:buffer";

const AUTH_FAILURE_HINT = "Run `jira status` to see which Jira credentials are active.";

export function assertJiraResponseOk(response: Response, message: string): void {
  if (response.ok) {
    return;
  }

  throw new Error(`${message} ${describeJiraResponseFailure(response)}`);
}

export function readJiraHeaders(authorization: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: authorization,
  };
}

export function jsonJiraHeaders(authorization: string): Record<string, string> {
  return {
    ...readJiraHeaders(authorization),
    "Content-Type": "application/json",
  };
}

export function bearerAuthorizationHeader(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/** RFC 7617 credential for an Atlassian API token: base64 of `email:token`. */
export function encodeBasicCredential(email: string, apiToken: string): string {
  return Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
}

export function basicAuthorizationHeader(email: string, apiToken: string): string {
  return `Basic ${encodeBasicCredential(email, apiToken)}`;
}

/**
 * Only the status line is surfaced. Jira error bodies can carry site-specific detail that must
 * not reach the terminal, so they are never read here.
 */
function describeJiraResponseFailure(response: Response): string {
  const statusText = response.statusText.trim();
  const suffix = statusText.length === 0 ? "" : ` ${statusText}`;
  const status = `(HTTP ${response.status.toString()}${suffix})`;
  return response.status === 401 || response.status === 403
    ? `${status} ${AUTH_FAILURE_HINT}`
    : status;
}
