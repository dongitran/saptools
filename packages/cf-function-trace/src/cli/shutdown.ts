import type { ProcessGuard } from "../process-guard.js";

export type FatalSignal = "SIGINT" | "SIGTERM";

export interface ShutdownController {
  /**
   * Call when the named signal arrives. Aborts in-flight work immediately so
   * the normal, already-tested cleanup path gets the first chance to run;
   * forces the guard's emergency cleanup and exits if that does not finish
   * within the grace period, or immediately on a repeated signal.
   */
  handleSignal(signalName: FatalSignal): void;
  /**
   * Call once the command's normal flow settles on its own, so a fast
   * graceful shutdown is not overridden by a pending forced-exit timer.
   */
  handleSettled(): void;
  /**
   * Call from an uncaughtException/unhandledRejection handler: no graceful
   * path exists for these, so the guard's cleanup runs and the process
   * exits immediately.
   */
  handleFatalError(): void;
}

export interface ShutdownControllerDependencies {
  readonly guard: ProcessGuard;
  readonly abort: () => void;
  readonly exit: (code: number) => void;
  readonly scheduleForceExit: (run: () => void, delayMs: number) => () => void;
  readonly gracePeriodMs?: number;
}

const DEFAULT_GRACE_PERIOD_MS = 10_000;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
const FATAL_ERROR_EXIT_CODE = 1;

export function createShutdownController(
  dependencies: ShutdownControllerDependencies,
): ShutdownController {
  const gracePeriodMs = dependencies.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  let receivedSignal: FatalSignal | undefined;
  let cancelForceExit: (() => void) | undefined;

  function forceExit(code: number): void {
    cancelForceExit?.();
    cancelForceExit = undefined;
    // Best-effort by construction (see ProcessGuard.runCleanup): this never
    // rejects, so there is no unhandled path to guard against here.
    void dependencies.guard.runCleanup().finally(() => {
      dependencies.exit(code);
    });
  }

  function handleSignal(signalName: FatalSignal): void {
    dependencies.abort();
    const code = SIGNAL_EXIT_CODES[signalName];
    if (receivedSignal !== undefined) {
      // A second signal means the caller (or an impatient operator) is done
      // waiting for a graceful shutdown; force it rather than risk a raw
      // SIGKILL leaving the debugger paused and the tunnel orphaned.
      forceExit(code);
      return;
    }
    receivedSignal = signalName;
    cancelForceExit = dependencies.scheduleForceExit(() => {
      forceExit(code);
    }, gracePeriodMs);
  }

  function handleSettled(): void {
    cancelForceExit?.();
    cancelForceExit = undefined;
  }

  function handleFatalError(): void {
    forceExit(FATAL_ERROR_EXIT_CODE);
  }

  return { handleSignal, handleSettled, handleFatalError };
}
