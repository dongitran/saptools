export type CfMetricsErrorCode =
  | "CONFIG"
  | "TARGET_UNRESOLVED"
  | "CREDENTIALS_NOT_FOUND"
  | "SERVICE_INSTANCE_AMBIGUOUS"
  | "SERVICE_INSTANCE_NOT_FOUND"
  | "SAML_TOGGLE_FAILED"
  | "SAML_RESTORE_FAILED"
  | "OPENSEARCH_REQUEST_FAILED"
  | "MAPPING_LOOKUP_FAILED"
  | "METRIC_NOT_FOUND"
  | "RESULT_NOT_FOUND";

export interface CfMetricsErrorOptions {
  readonly cause?: unknown;
  /** HTTP status of the failed request, when the failure was an HTTP response rather than a transport or parsing problem. */
  readonly status?: number;
}

/** Base error for every failure surfaced by `@saptools/cf-metrics`. */
export class CfMetricsError extends Error {
  readonly code: CfMetricsErrorCode;
  readonly status: number | undefined;

  constructor(code: CfMetricsErrorCode, message: string, options?: CfMetricsErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CfMetricsError";
    this.code = code;
    this.status = options?.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No usable Cloud Logging dashboards credential could be resolved. */
export class CredentialsNotFoundError extends CfMetricsError {
  constructor(message: string, options?: CfMetricsErrorOptions) {
    super("CREDENTIALS_NOT_FOUND", message, options);
    this.name = "CredentialsNotFoundError";
  }
}

/**
 * The SAML restore step (re-enabling SSO after `--allow-mint-credential`)
 * failed. This must never be caught and swallowed: the shared Cloud Logging
 * instance is left with SSO disabled for every user until fixed manually.
 */
export class SamlRestoreFailedError extends CfMetricsError {
  constructor(message: string, options?: CfMetricsErrorOptions) {
    super("SAML_RESTORE_FAILED", message, options);
    this.name = "SamlRestoreFailedError";
  }
}

/**
 * True when OpenSearch (via the Dashboards console-proxy) rejected the
 * credential itself — HTTP 401 or 403 — as opposed to a bad query, a timeout,
 * or a transport failure. The distinction matters because a rejected
 * credential is the one failure worth reacting to by discarding a cached
 * credential and discovering a fresh one; retrying anything else with new
 * credentials would just repeat the same failure.
 */
export function isAuthRejection(error: unknown): boolean {
  return error instanceof CfMetricsError && (error.status === 401 || error.status === 403);
}

/** Narrow an unknown thrown value to a human-readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
