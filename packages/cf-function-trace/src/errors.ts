export type TraceDataErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_RUN_ID"
  | "INVALID_RUNTIME_FILE"
  | "INVALID_SELECTOR"
  | "FUNCTION_NOT_FOUND"
  | "AMBIGUOUS_FUNCTION"
  | "UNSUPPORTED_ASYNC_FUNCTION"
  | "SCRIPT_NOT_FOUND"
  | "AMBIGUOUS_SCRIPT"
  | "INVALID_ARTIFACT"
  | "RUN_NOT_FOUND"
  | "STATE_NOT_FOUND"
  | "STATE_HASH_MISMATCH"
  | "RUN_STORAGE_LIMIT"
  | "REMOTE_IMPACT_NOT_CONFIRMED"
  | "SSH_NOT_ENABLED"
  | "TRACE_TIMEOUT"
  | "MAX_STEPS"
  | "MAX_PAUSED_TIME"
  | "BREAKPOINT_NOT_HIT"
  | "TRACE_ABORTED"
  | "CLEANUP_FAILED";

export interface ErrorCandidate {
  readonly selector?: string;
  readonly url?: string;
  readonly startLine?: number;
}

export class TraceDataError extends Error {
  public readonly code: TraceDataErrorCode;
  public readonly candidates?: readonly ErrorCandidate[];
  public override readonly cause?: unknown;

  public constructor(
    code: TraceDataErrorCode,
    message: string,
    candidates?: readonly ErrorCandidate[],
    cause?: unknown,
  ) {
    super(message);
    this.name = "TraceDataError";
    this.code = code;
    if (candidates !== undefined) {
      this.candidates = candidates;
    }
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
