import { CfDebuggerError } from "./types.js";

export const CLEANUP_FAILURE_EXIT_CODE = 70;

export class CleanupFailureError extends AggregateError {
  public constructor(errors: readonly unknown[], cause: unknown) {
    super(
      errors,
      "Debugger startup failed and resource cleanup was incomplete",
      { cause },
    );
    this.name = "CleanupFailureError";
  }
}

function requestedCliExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, "cliExitCode");
  return value === 130 || value === 143 ? value : undefined;
}

export function hasTunnelTerminationFailure(error: unknown): boolean {
  if (error instanceof CfDebuggerError) {
    return error.code === "TUNNEL_TERMINATION_FAILED";
  }
  return error instanceof AggregateError &&
    error.errors.some((nested: unknown) => hasTunnelTerminationFailure(nested));
}

function hasCleanupFailure(error: unknown): boolean {
  return error instanceof CleanupFailureError ||
    hasTunnelTerminationFailure(error);
}

export function cliErrorExitCode(error: unknown): number {
  const requested = requestedCliExitCode(error);
  if (requested !== undefined) {
    return requested;
  }
  if (error instanceof CfDebuggerError && error.code === "ABORTED") {
    return 130;
  }
  return hasCleanupFailure(error) ? CLEANUP_FAILURE_EXIT_CODE : 1;
}

export function stopAllExitCode(
  errors: readonly Error[],
): number | undefined {
  if (errors.length === 0) {
    return undefined;
  }
  return errors.some((error) => hasTunnelTerminationFailure(error))
    ? CLEANUP_FAILURE_EXIT_CODE
    : 1;
}
