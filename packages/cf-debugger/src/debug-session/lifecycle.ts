import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

import {
  formatTunnelDiagnostics,
  getTunnelDiagnostics,
} from "../cf.js";
import { CleanupFailureError } from "../cli-errors.js";
import { inspectPortOwnership } from "../port.js";
import {
  clearSessionStopIntent,
  hasSessionStopIntent,
  inspectSessionStateStopIntent,
  updateSessionStatus,
} from "../state.js";
import type {
  ActiveSession,
  DebuggerHandle,
  SessionStatus,
} from "../types.js";
import { CfDebuggerError } from "../types.js";

import {
  inspectProcessIdentity,
  readProcessIdentity,
} from "./process-identity.js";
import { killProcessGroupOrProc } from "./processes.js";
import type { TerminationVerifier } from "./processes.js";
import { forgetSessionThenCleanupHome } from "./session-cleanup.js";

type StatusEmitter = (status: SessionStatus, message?: string) => void;
const handleLifecycles = new WeakMap<DebuggerHandle, TunnelLifecycle>();

function childIsOpen(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export interface TunnelLifecycle {
  readonly exitPromise: Promise<number | null>;
  readonly assertRunning: () => void;
  readonly finalize: (emitStopped: boolean) => Promise<void>;
  readonly observeChild: (child: ChildProcess) => void;
  readonly failed: () => boolean;
  readonly error: () => CfDebuggerError | undefined;
}

interface TunnelLifecycleState {
  child: ChildProcess | undefined;
  childIdentity: Promise<string | undefined> | undefined;
  childFailed: boolean;
  tunnelError: CfDebuggerError | undefined;
  finalizing: boolean;
  exitResolve: (code: number | null) => void;
}

interface InitializedTunnelLifecycle {
  readonly exitPromise: Promise<number | null>;
  readonly state: TunnelLifecycleState;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signum = osConstants.signals[signal];
  return typeof signum === "number" && Number.isFinite(signum)
    ? 128 + signum
    : 1;
}

function unexpectedExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (signal !== null) {
    return signalExitCode(signal);
  }
  return code === null || code === 0 ? 1 : code;
}

function emitSafely(
  emit: StatusEmitter,
  status: SessionStatus,
  message?: string,
): void {
  try {
    emit(status, message);
  } catch {
    // Status observers are informational and must never defeat owned-resource cleanup.
  }
}

function ignoreCleanupFailure(): void {
  // Stop-intent cleanup is best-effort after the owning lifecycle has ended.
}

async function runCleanupActions(
  actions: readonly (() => void | Promise<void>)[],
  aggregateMessage: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, aggregateMessage);
  }
}

async function handleTunnelClose(
  sessionId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  child: ChildProcess,
  resolveExit: (code: number | null) => void,
  isFinalizing: () => boolean,
  hasFailed: () => boolean,
  markFailed: (error: CfDebuggerError) => void,
  emit: StatusEmitter,
): Promise<void> {
  const stopRequested = isFinalizing()
    ? false
    : await hasExpectedStopSignal(sessionId);
  const expected = isFinalizing() || stopRequested;
  if (stopRequested) {
    await clearSessionStopIntent(sessionId).catch(ignoreCleanupFailure);
  }
  if (!expected && !hasFailed()) {
    const detail = signal === null
      ? code === null
        ? "no exit status"
        : `exit code ${code.toString()}`
      : `signal ${signal}`;
    const diagnostics = formatTunnelDiagnostics(getTunnelDiagnostics(child));
    const error = new CfDebuggerError(
      "TUNNEL_EXITED",
      `SSH tunnel ended unexpectedly with ${detail}.`,
      diagnostics,
    );
    markFailed(error);
    emitSafely(emit, "error", error.message);
  }
  resolveExit(expected && !hasFailed() ? 0 : unexpectedExitCode(code, signal));
}

async function hasExpectedStopSignal(sessionId: string): Promise<boolean> {
  let sidecarRequested = false;
  try {
    sidecarRequested = await hasSessionStopIntent(sessionId);
  } catch {
    // The state record is an independent compatibility and error fallback.
  }
  try {
    const verdict = await inspectSessionStateStopIntent(sessionId);
    return verdict === "requested" ||
      (verdict === "missing" && sidecarRequested);
  } catch {
    return false;
  }
}

function attachTunnelEvents(
  sessionId: string,
  child: ChildProcess,
  resolveExit: (code: number | null) => void,
  isFinalizing: () => boolean,
  hasFailed: () => boolean,
  markFailed: (error: CfDebuggerError) => void,
  emit: StatusEmitter,
): void {
  child.once("close", (code, signal) => {
    void handleTunnelClose(
      sessionId,
      code,
      signal,
      child,
      resolveExit,
      isFinalizing,
      hasFailed,
      markFailed,
      emit,
    ).catch((error: unknown) => {
      const failure = new CfDebuggerError(
        "TUNNEL_EXITED",
        `SSH tunnel ended and its stop intent could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
        formatTunnelDiagnostics(getTunnelDiagnostics(child)),
      );
      markFailed(failure);
      emitSafely(emit, "error", failure.message);
      resolveExit(unexpectedExitCode(code, signal));
    });
  });
  child.once("error", (error: Error) => {
    const failure = new CfDebuggerError(
      "TUNNEL_EXITED",
      error.message,
      formatTunnelDiagnostics(getTunnelDiagnostics(child)),
    );
    markFailed(failure);
    emitSafely(emit, "error", failure.message);
  });
}

async function expectedTunnelStillOwned(
  session: ActiveSession,
  child: ChildProcess | undefined,
): Promise<boolean | "unverified"> {
  const childPid = child?.pid;
  if (childPid === undefined) {
    return false;
  }
  const ownership = await inspectPortOwnership(session.localPort, childPid);
  return ownership.status === "unverified"
    ? "unverified"
    : ownership.status === "owned";
}

async function cleanupFinishedSession(session: ActiveSession): Promise<void> {
  const cleanup = await forgetSessionThenCleanupHome(session);
  await clearSessionStopIntent(session.sessionId).catch(ignoreCleanupFailure);
  if (cleanup.homeStatus !== "removed") {
    throw new CfDebuggerError(
      "CF_HOME_CLEANUP_FAILED",
      cleanup.homeStatus === "retained"
        ? `Session state was removed, but owned CF home ${session.cfHomeDir} could not be deleted. ` +
          "It may contain a live CF refresh token; remove it manually or run `cf-debugger doctor --cleanup`."
        : `Session state was removed, but unowned CF home ${session.cfHomeDir} was not deleted.`,
    );
  }
}

function initializeTunnelLifecycle(): InitializedTunnelLifecycle {
  let exitResolve: (code: number | null) => void = (_code) => {
    throw new Error("Tunnel exit resolver was used before initialization.");
  };
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  return {
    exitPromise,
    state: {
      child: undefined,
      childIdentity: undefined,
      childFailed: false,
      tunnelError: undefined,
      finalizing: false,
      exitResolve,
    },
  };
}

function recordTunnelFailure(
  state: TunnelLifecycleState,
  error: CfDebuggerError,
): void {
  if (!state.childFailed) {
    state.childFailed = true;
    state.tunnelError = error;
  }
}

function observeTunnelChild(
  state: TunnelLifecycleState,
  sessionId: string,
  tunnelChild: ChildProcess,
  emit: StatusEmitter,
): void {
  state.child = tunnelChild;
  state.childIdentity = tunnelChild.pid === undefined
    ? undefined
    : readProcessIdentity(tunnelChild.pid);
  attachTunnelEvents(
    sessionId,
    tunnelChild,
    state.exitResolve,
    (): boolean => state.finalizing,
    (): boolean => state.childFailed,
    (error): void => {
      recordTunnelFailure(state, error);
    },
    emit,
  );
}

async function verifyTunnelBeforeSignal(
  state: TunnelLifecycleState,
  session: ActiveSession,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const tunnelChild = state.child;
  const childPid = tunnelChild?.pid;
  if (
    tunnelChild === undefined ||
    childPid === undefined ||
    !childIsOpen(tunnelChild)
  ) {
    return false;
  }
  const expectedIdentity = await state.childIdentity;
  if (expectedIdentity !== undefined) {
    return await inspectProcessIdentity(childPid, expectedIdentity) === "match" &&
      childIsOpen(tunnelChild);
  }
  if (signal === "SIGKILL") {
    return await expectedTunnelStillOwned(session, tunnelChild) === true;
  }
  // The still-open ChildProcess handle is the best available ownership proof
  // on platforms without a process birth token.
  return true;
}

function tunnelTerminationError(
  session: ActiveSession,
  child: ChildProcess | undefined,
): CfDebuggerError {
  const stderr = child === undefined
    ? undefined
    : formatTunnelDiagnostics(getTunnelDiagnostics(child));
  return new CfDebuggerError(
    "TUNNEL_TERMINATION_FAILED",
    `Tunnel for session ${session.sessionId} did not terminate cleanly; state and CF home were retained.`,
    stderr,
  );
}

async function finalizeTunnelLifecycle(
  state: TunnelLifecycleState,
  session: ActiveSession,
  emit: StatusEmitter,
  emitStopped: boolean,
): Promise<void> {
  state.finalizing = true;
  const verify: TerminationVerifier = async (signal): Promise<boolean> => {
    return await verifyTunnelBeforeSignal(state, session, signal);
  };
  const termination = state.child === undefined
    ? "terminated"
    : await killProcessGroupOrProc(state.child, verify);
  const stillOwned = await expectedTunnelStillOwned(session, state.child);
  if (termination !== "terminated" || stillOwned === true) {
    throw tunnelTerminationError(session, state.child);
  }
  if (stillOwned === "unverified" && emitStopped) {
    emitSafely(
      emit,
      "stopping",
      "Tunnel process termination was confirmed, but local port ownership could not be rechecked. " +
        "On macOS, install lsof to restore that diagnostic.",
    );
  }
  await cleanupFinishedSession(session);
  if (emitStopped) {
    emitSafely(emit, "stopped");
  }
}

function assertTunnelRunning(
  state: TunnelLifecycleState,
  session: ActiveSession,
): void {
  if (
    state.child !== undefined &&
    childIsOpen(state.child) &&
    !state.childFailed
  ) {
    return;
  }
  throw new CfDebuggerError(
    "TUNNEL_NOT_READY",
    `SSH tunnel for session ${session.sessionId} exited before readiness could be committed.`,
    state.child === undefined
      ? undefined
      : formatTunnelDiagnostics(getTunnelDiagnostics(state.child)),
  );
}

export function createTunnelLifecycle(
  session: ActiveSession,
  emit: StatusEmitter,
): TunnelLifecycle {
  const initialized = initializeTunnelLifecycle();
  const { state } = initialized;
  return {
    exitPromise: initialized.exitPromise,
    assertRunning: (): void => {
      assertTunnelRunning(state, session);
    },
    finalize: async (emitStopped): Promise<void> => {
      await finalizeTunnelLifecycle(state, session, emit, emitStopped);
    },
    observeChild: (child): void => {
      observeTunnelChild(state, session.sessionId, child, emit);
    },
    failed: (): boolean => state.childFailed,
    error: (): CfDebuggerError | undefined => state.tunnelError,
  };
}

export function createDebuggerHandle(
  session: ActiveSession,
  emit: StatusEmitter,
  lifecycle: TunnelLifecycle,
): DebuggerHandle {
  let disposePromise: Promise<void> | undefined;
  const handle: DebuggerHandle = {
    session,
    dispose: async (): Promise<void> => {
      const attempt = disposePromise ?? (async (): Promise<void> => {
        const reportLifecycle = !lifecycle.failed();
        await runCleanupActions([
          async (): Promise<void> => {
            if (reportLifecycle) {
              emitSafely(emit, "stopping");
              await updateSessionStatus(session.sessionId, "stopping");
            }
          },
          async (): Promise<void> => {
            await lifecycle.finalize(reportLifecycle);
          },
        ], "Debugger disposal failed");
      })();
      disposePromise = attempt;
      try {
        await attempt;
      } catch (error: unknown) {
        if (disposePromise === attempt) {
          disposePromise = undefined;
        }
        throw error;
      }
    },
    waitForExit: async (): Promise<number | null> => await lifecycle.exitPromise,
  };
  handleLifecycles.set(handle, lifecycle);
  return handle;
}

export function getDebuggerHandleTunnelError(
  handle: DebuggerHandle,
): CfDebuggerError | undefined {
  return handleLifecycles.get(handle)?.error();
}

export async function cleanupFailedStartup(
  error: unknown,
  lifecycle: TunnelLifecycle,
  emit: StatusEmitter,
): Promise<never> {
  emitSafely(emit, "error", error instanceof Error ? error.message : String(error));
  try {
    await lifecycle.finalize(false);
  } catch (cleanupError: unknown) {
    throw new CleanupFailureError(
      [error, cleanupError],
      cleanupError,
    );
  }
  throw error;
}
