import { CfDebuggerError } from "../types.js";

import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  MAX_STARTUP_TIMEOUT_MS,
} from "./constants.js";

export interface StartupDeadline {
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  dispose(): void;
}

export function resolveStartupTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      `Startup timeout must be an integer from 1 to ${MAX_STARTUP_TIMEOUT_MS.toString()} milliseconds.`,
    );
  }
  return timeoutMs;
}

export function remainingStartupMs(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now());
}

export function startupTimeoutError(timeoutMs: number, phase: string): CfDebuggerError {
  return new CfDebuggerError(
    "STARTUP_TIMEOUT",
    `Debugger startup exceeded its ${(timeoutMs / 1000).toString()}s deadline during ${phase}.`,
  );
}

export function createStartupDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): StartupDeadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  const timer = setTimeout(() => {
    controller.abort(startupTimeoutError(timeoutMs, "startup"));
  }, timeoutMs);
  timer.unref();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted === true) {
    controller.abort(callerSignal.reason);
  }

  return {
    expiresAt,
    signal: controller.signal,
    timeoutMs,
    dispose: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function throwIfStartupAborted(
  signal: AbortSignal | undefined,
  expiresAt: number,
  timeoutMs: number,
  phase: string,
): void {
  if (remainingStartupMs(expiresAt) === 0) {
    throw startupTimeoutError(timeoutMs, phase);
  }
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
}
