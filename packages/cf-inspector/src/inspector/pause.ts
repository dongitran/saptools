import { performance } from "node:perf_hooks";

import { CfInspectorError } from "../types.js";
import type { PauseEvent } from "../types.js";

import { pauseDetail, toPauseEvent } from "./conversions.js";
import type { CdpPauseParams, InspectorSession, WaitForPauseOptions } from "./types.js";

function pauseMatches(
  pause: PauseEvent,
  breakpointIds: readonly string[] | undefined,
  pauseReasons: readonly string[] | undefined,
): boolean {
  if (pauseReasons !== undefined && pauseReasons.length > 0) {
    return pauseReasons.includes(pause.reason);
  }
  if (breakpointIds === undefined || breakpointIds.length === 0) {
    return true;
  }
  return pause.hitBreakpoints.some((id) => breakpointIds.includes(id));
}

function remainingUntil(deadlineMs: number): number {
  return Math.max(0, deadlineMs - performance.now());
}

function hasResumedSincePause(session: InspectorSession, pause: PauseEvent): boolean {
  const pauseAt = pause.receivedAtMs;
  const resumedAt = session.debuggerState.lastResumedAtMs;
  return pauseAt !== undefined && resumedAt !== undefined && resumedAt >= pauseAt;
}

function throwBreakpointTimeout(timeoutMs: number): never {
  throw new CfInspectorError(
    "BREAKPOINT_NOT_HIT",
    `Timed out waiting for matching Debugger.paused after ${timeoutMs.toString()}ms`,
  );
}

function throwUnrelatedPauseTimeout(pause: PauseEvent, timeoutMs: number): never {
  throw new CfInspectorError(
    "UNRELATED_PAUSE_TIMEOUT",
    `Target stayed paused by another debugger event before this command's breakpoint could hit within ${timeoutMs.toString()}ms`,
    pauseDetail(pause),
  );
}

async function waitForUnmatchedPauseToResume(
  session: InspectorSession,
  pause: PauseEvent,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> {
  if (hasResumedSincePause(session, pause)) {
    return;
  }
  const remainingMs = remainingUntil(deadlineMs);
  if (remainingMs <= 0) {
    throwUnrelatedPauseTimeout(pause, timeoutMs);
  }
  try {
    await session.client.waitFor("Debugger.resumed", { timeoutMs: remainingMs });
    session.debuggerState.lastResumedAtMs = performance.now();
  } catch (err: unknown) {
    if (err instanceof CfInspectorError && err.code === "BREAKPOINT_NOT_HIT") {
      throwUnrelatedPauseTimeout(pause, timeoutMs);
    }
    throw err;
  }
}

async function handleUnmatchedPause(
  session: InspectorSession,
  pause: PauseEvent,
  options: WaitForPauseOptions,
  deadlineMs: number,
): Promise<void> {
  if (options.unmatchedPausePolicy === "fail") {
    throw new CfInspectorError(
      "UNRELATED_PAUSE",
      "Target paused before this command's breakpoint was reached",
      pauseDetail(pause),
    );
  }
  if (hasResumedSincePause(session, pause)) {
    return;
  }
  options.onUnmatchedPause?.(pause);
  await waitForUnmatchedPauseToResume(session, pause, deadlineMs, options.timeoutMs);
}

export async function waitForPause(
  session: InspectorSession,
  options: WaitForPauseOptions,
): Promise<PauseEvent> {
  const deadlineMs = performance.now() + options.timeoutMs;
  const buffer = session.pauseBuffer;
  while (buffer.length > 0 || remainingUntil(deadlineMs) > 0) {
    while (buffer.length > 0) {
      const buffered = buffer.shift();
      if (buffered === undefined) {
        continue;
      }
      if (pauseMatches(buffered, options.breakpointIds, options.pauseReasons)) {
        return buffered;
      }
      await handleUnmatchedPause(session, buffered, options, deadlineMs);
    }
    const pause = await waitForLivePause(session, options, deadlineMs);
    if (pauseMatches(pause, options.breakpointIds, options.pauseReasons)) {
      return pause;
    }
    await handleUnmatchedPause(session, pause, options, deadlineMs);
  }
  throwBreakpointTimeout(options.timeoutMs);
}

async function waitForLivePause(
  session: InspectorSession,
  options: WaitForPauseOptions,
  deadlineMs: number,
): Promise<PauseEvent> {
  const remainingMs = remainingUntil(deadlineMs);
  if (remainingMs <= 0) {
    throwBreakpointTimeout(options.timeoutMs);
  }
  session.pauseWaitGate.active = true;
  let receivedAtMs: number | undefined;
  let params: CdpPauseParams;
  try {
    params = await session.client.waitFor<CdpPauseParams>("Debugger.paused", {
      timeoutMs: remainingMs,
      predicate: (): boolean => {
        receivedAtMs = performance.now();
        return true;
      },
    });
  } finally {
    session.pauseWaitGate.active = false;
  }
  return toPauseEvent(params, receivedAtMs ?? performance.now(), session.scripts);
}
