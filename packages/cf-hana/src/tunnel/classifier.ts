import { CfHanaError } from "../errors.js";

const CONNECT_TIMEOUT_MESSAGE = "HANA connection timed out";
const OPEN_CONNECTION_CODE = "EHDBOPENCONN";
const MAX_CAUSE_DEPTH = 5;

function causeCode(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { readonly code?: unknown }).code
    : undefined;
}

function causeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { readonly cause?: unknown }).cause
    : undefined;
}

function hasOpenConnectionCause(cause: unknown, depth: number): boolean {
  if (depth > MAX_CAUSE_DEPTH) {
    return false;
  }
  if (causeCode(cause) === OPEN_CONNECTION_CODE) {
    return true;
  }
  return hasOpenConnectionCause(causeOf(cause), depth + 1);
}

/**
 * True only for a failure to establish the initial HANA socket — never for
 * an authentication, privilege, or query failure (all reached structurally
 * after a socket already opened), and never for the unrelated query-phase
 * timeout that shares the same `TIMEOUT` code as the connect-phase one.
 */
export function isConnectivityFailure(error: unknown): boolean {
  if (!(error instanceof CfHanaError)) {
    return false;
  }
  if (error.code === "TIMEOUT") {
    return error.message.includes(CONNECT_TIMEOUT_MESSAGE);
  }
  if (error.code !== "CONNECTION") {
    return false;
  }
  return hasOpenConnectionCause(error.cause, 0);
}
