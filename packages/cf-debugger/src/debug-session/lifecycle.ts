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
  removeSession,
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
import { removeOwnedSessionCfHome } from "./session-home.js";

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

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + osConstants.signals[signal];
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
  const stopRequested = await hasSessionStopIntent(sessionId);
  const expected = isFinalizing() || stopRequested;
  if (stopRequested) {
    await clearSessionStopIntent(sessionId);
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
  await removeOwnedSessionCfHome(session.sessionId, session.cfHomeDir);
  await removeSession(session.sessionId);
  await clearSessionStopIntent(session.sessionId);
}

export function createTunnelLifecycle(
  session: ActiveSession,
  emit: StatusEmitter,
): TunnelLifecycle {
  let child: ChildProcess | undefined;
  let childIdentity: Promise<string | undefined> | undefined;
  let childFailed = false;
  let tunnelError: CfDebuggerError | undefined;
  let finalizing = false;
  let exitResolve: (code: number | null) => void = (_code) => {
    throw new Error("Tunnel exit resolver was used before initialization.");
  };
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  const observeChild = (tunnelChild: ChildProcess): void => {
    child = tunnelChild;
    childIdentity = tunnelChild.pid === undefined
      ? undefined
      : readProcessIdentity(tunnelChild.pid);
    attachTunnelEvents(
      session.sessionId,
      tunnelChild,
      exitResolve,
      (): boolean => finalizing,
      (): boolean => childFailed,
      (error): void => {
        if (!childFailed) {
          childFailed = true;
          tunnelError = error;
        }
      },
      emit,
    );
  };
  const verifyBeforeSignal: TerminationVerifier = async (signal): Promise<boolean> => {
    const tunnelChild = child;
    const childPid = tunnelChild?.pid;
    if (
      tunnelChild === undefined ||
      childPid === undefined ||
      !childIsOpen(tunnelChild)
    ) {
      return false;
    }
    const expectedIdentity = await childIdentity;
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
  };
  const finalize = async (emitStopped: boolean): Promise<void> => {
    finalizing = true;
    const termination = child === undefined
      ? "terminated"
      : await killProcessGroupOrProc(child, verifyBeforeSignal);
    const stillOwned = await expectedTunnelStillOwned(session, child);
    if (termination !== "terminated" || stillOwned === true || stillOwned === "unverified") {
      const stderr = child === undefined
        ? undefined
        : formatTunnelDiagnostics(getTunnelDiagnostics(child));
      throw new CfDebuggerError(
        "TUNNEL_TERMINATION_FAILED",
        `Tunnel for session ${session.sessionId} did not terminate cleanly; state and CF home were retained.`,
        stderr,
      );
    }
    await cleanupFinishedSession(session);
    if (emitStopped) {
      emitSafely(emit, "stopped");
    }
  };
  return {
    exitPromise,
    assertRunning: (): void => {
      if (
        child === undefined ||
        !childIsOpen(child) ||
        childFailed
      ) {
        throw new CfDebuggerError(
          "TUNNEL_NOT_READY",
          `SSH tunnel for session ${session.sessionId} exited before readiness could be committed.`,
          child === undefined
            ? undefined
            : formatTunnelDiagnostics(getTunnelDiagnostics(child)),
        );
      }
    },
    finalize,
    observeChild,
    failed: (): boolean => childFailed,
    error: (): CfDebuggerError | undefined => tunnelError,
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
