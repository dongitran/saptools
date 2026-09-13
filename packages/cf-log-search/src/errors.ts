export type CfLogSearchErrorCode =
  | "CONFIG"
  | "TARGET_UNRESOLVED"
  | "CREDENTIALS_NOT_FOUND"
  | "SERVICE_INSTANCE_AMBIGUOUS"
  | "SERVICE_INSTANCE_NOT_FOUND"
  | "OPENSEARCH_REQUEST_FAILED"
  | "RESULT_NOT_FOUND"
  | "RESULT_UNREADABLE"
  | "RESULT_STORE_NOT_WRITABLE";

export interface CfLogSearchErrorOptions {
  readonly cause?: unknown;
  readonly status?: number;
}

export class CfLogSearchError extends Error {
  readonly code: CfLogSearchErrorCode;
  readonly status: number | undefined;

  constructor(code: CfLogSearchErrorCode, message: string, options?: CfLogSearchErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CfLogSearchError";
    this.code = code;
    this.status = options?.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CredentialsNotFoundError extends CfLogSearchError {
  constructor(message: string, options?: CfLogSearchErrorOptions) {
    super("CREDENTIALS_NOT_FOUND", message, options);
    this.name = "CredentialsNotFoundError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
