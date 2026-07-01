export type CfHanaErrorCode =
  | "CONFIG"
  | "CREDENTIALS_NOT_FOUND"
  | "AMBIGUOUS_BINDING"
  | "CONNECTION"
  | "QUERY"
  | "READ_ONLY_VIOLATION"
  | "DESTRUCTIVE_BLOCKED"
  | "TIMEOUT"
  | "POOL_CLOSED";

export interface CfHanaErrorOptions {
  readonly cause?: unknown;
}

export interface QueryErrorOptions extends CfHanaErrorOptions {
  readonly sqlState?: string;
  readonly databaseCode?: number;
}

/** Base error for every failure surfaced by `@saptools/cf-hana`. */
export class CfHanaError extends Error {
  readonly code: CfHanaErrorCode;

  constructor(code: CfHanaErrorCode, message: string, options?: CfHanaErrorOptions) {
    super(message, options);
    this.name = "CfHanaError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No HANA credentials could be resolved for the requested selector. */
export class CredentialsNotFoundError extends CfHanaError {
  constructor(message: string, options?: CfHanaErrorOptions) {
    super("CREDENTIALS_NOT_FOUND", message, options);
    this.name = "CredentialsNotFoundError";
  }
}

/** A SQL statement failed on the HANA server. */
export class QueryError extends CfHanaError {
  readonly sqlState: string | undefined;
  readonly databaseCode: number | undefined;

  constructor(message: string, options?: QueryErrorOptions) {
    super("QUERY", message, options);
    this.name = "QueryError";
    this.sqlState = options?.sqlState;
    this.databaseCode = options?.databaseCode;
  }
}

function isDatabaseErrorShape(error: unknown): error is { readonly code?: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}

function safeDatabaseCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Extract a numeric HANA database error code from wrapped query failures. */
export function databaseCode(error: unknown): number | undefined {
  if (error instanceof QueryError) {
    return error.databaseCode ?? databaseCode(error.cause);
  }
  if (isDatabaseErrorShape(error)) {
    return safeDatabaseCode(error.code);
  }
  return undefined;
}

/** A write/DDL statement was issued on a read-only client. */
export class ReadOnlyViolationError extends CfHanaError {
  constructor(message: string, options?: CfHanaErrorOptions) {
    super("READ_ONLY_VIOLATION", message, options);
    this.name = "ReadOnlyViolationError";
  }
}

/** A destructive statement was blocked because it was not explicitly allowed. */
export class DestructiveStatementError extends CfHanaError {
  constructor(message: string, options?: CfHanaErrorOptions) {
    super("DESTRUCTIVE_BLOCKED", message, options);
    this.name = "DestructiveStatementError";
  }
}

/** Narrow an unknown thrown value to a human-readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
