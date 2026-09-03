export type CfOtelErrorCode =
  | "CONFIG"
  | "TARGET_UNRESOLVED"
  | "CREDENTIALS_NOT_FOUND"
  | "SERVICE_INSTANCE_AMBIGUOUS"
  | "SERVICE_INSTANCE_NOT_FOUND"
  | "SAML_TOGGLE_FAILED"
  | "SAML_RESTORE_FAILED"
  | "OPENSEARCH_REQUEST_FAILED"
  | "MAPPING_LOOKUP_FAILED"
  | "TRACE_NOT_FOUND"
  | "RESULT_NOT_FOUND"
  | "RESULT_UNREADABLE"
  | "RESULT_STORE_NOT_WRITABLE";

export interface CfOtelErrorOptions {
  readonly cause?: unknown;
}

/** Base error for every failure surfaced by `@saptools/cf-otel`. */
export class CfOtelError extends Error {
  readonly code: CfOtelErrorCode;

  constructor(code: CfOtelErrorCode, message: string, options?: CfOtelErrorOptions) {
    super(message, options);
    this.name = "CfOtelError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No usable Cloud Logging dashboards credential could be resolved. */
export class CredentialsNotFoundError extends CfOtelError {
  constructor(message: string, options?: CfOtelErrorOptions) {
    super("CREDENTIALS_NOT_FOUND", message, options);
    this.name = "CredentialsNotFoundError";
  }
}

/**
 * The SAML restore step (re-enabling SSO after `--allow-mint-credential`)
 * failed. This must never be caught and swallowed: the shared Cloud Logging
 * instance is left with SSO disabled for every user until fixed manually.
 */
export class SamlRestoreFailedError extends CfOtelError {
  constructor(message: string, options?: CfOtelErrorOptions) {
    super("SAML_RESTORE_FAILED", message, options);
    this.name = "SamlRestoreFailedError";
  }
}

/** Narrow an unknown thrown value to a human-readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
