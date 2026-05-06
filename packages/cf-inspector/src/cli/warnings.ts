import process from "node:process";

import type { BreakpointHandle, PauseEvent, SnapshotCaptureResult, SnapshotResult } from "../types.js";

export function warnOnUnboundBreakpoints(handles: readonly BreakpointHandle[]): void {
  for (const handle of handles) {
    if (handle.resolvedLocations.length === 0) {
      process.stderr.write(
        `[cf-inspector] warning: breakpoint ${handle.file}:${handle.line.toString()} ` +
          `did not bind to any loaded script. Check the path or pass --remote-root. ` +
          `Use 'list-scripts' to inspect what V8 currently has loaded.\n`,
      );
    }
  }
}

export function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 1000) / 1000;
}

export function warnOnUnmatchedPause(pause: PauseEvent): void {
  const reason = pause.reason.length > 0 ? pause.reason : "unknown";
  process.stderr.write(
    `[cf-inspector] warning: target is paused by another debugger event ` +
      `(${reason} at ${formatPauseLocation(pause)}); waiting for it to resume...\n`,
  );
}

export function withPausedDuration(
  snapshot: SnapshotCaptureResult,
  pausedDurationMs: number | null,
): SnapshotResult {
  const base: SnapshotResult = {
    reason: snapshot.reason,
    hitBreakpoints: snapshot.hitBreakpoints,
    capturedAt: snapshot.capturedAt,
    pausedDurationMs,
    captures: snapshot.captures,
  };
  const withFrame = snapshot.topFrame === undefined ? base : { ...base, topFrame: snapshot.topFrame };
  const withStack = snapshot.stack === undefined ? withFrame : { ...withFrame, stack: snapshot.stack };
  return snapshot.exception === undefined ? withStack : { ...withStack, exception: snapshot.exception };
}

function formatPauseLocation(pause: PauseEvent): string {
  const top = pause.callFrames[0];
  if (top === undefined) {
    return "(no call frame)";
  }
  const url = top.url !== undefined && top.url.length > 0 ? top.url : "(unknown)";
  return `${url}:${(top.lineNumber + 1).toString()}:${(top.columnNumber + 1).toString()}`;
}
