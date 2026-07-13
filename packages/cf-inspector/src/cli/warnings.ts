import process from "node:process";

import { CfInspectorError } from "../types.js";
import type { BreakpointHandle, PauseEvent, SnapshotCaptureResult, SnapshotResult } from "../types.js";

import { looksLikeMutation } from "./captureParser.js";

export function warnOnCaptureMutationRisk(
  expressions: readonly string[],
  allowMutation: boolean,
): void {
  const riskyCount = expressions.filter(looksLikeMutation).length;
  if (riskyCount === 0) {
    return;
  }
  const suffix = allowMutation
    ? "will run without the V8 side-effect guard because --allow-mutation was passed."
    : "will be checked by the V8 side-effect guard and blocked unless V8 proves them safe; pass --allow-mutation to run them unrestricted.";
  process.stderr.write(
    `[cf-inspector] warning: ${riskyCount.toString()} capture ` +
      `${riskyCount === 1 ? "expression looks" : "expressions look"} mutation-capable and ${suffix}\n`,
  );
}

export function enforceNativeConditionMutationPolicy(
  expression: string,
  allowMutation: boolean,
  context: string,
): void {
  if (!looksLikeMutation(expression)) {
    return;
  }
  if (!allowMutation) {
    throw new CfInspectorError(
      "MUTATION_NOT_ALLOWED",
      `${context} looks mutation-capable. Native breakpoint conditions cannot be protected by V8's side-effect guard; pass --allow-mutation to arm it explicitly.`,
    );
  }
  process.stderr.write(
    `[cf-inspector] warning: ${context} looks mutation-capable and will run as a native breakpoint condition; native conditions cannot be side-effect-gated.\n`,
  );
}

export function warnOnMutationRisk(expression: string, context: string): void {
  if (!looksLikeMutation(expression)) {
    return;
  }
  process.stderr.write(
    `[cf-inspector] warning: ${context} looks mutation-capable and will execute against the live inspectee without a side-effect guard.\n`,
  );
}

export function warnOnUnboundBreakpoints(handles: readonly BreakpointHandle[]): void {
  for (const handle of handles) {
    if (handle.resolvedLocations.length === 0) {
      const tsHint = handle.file.endsWith(".ts")
        ? " Hint: Source TS breakpoints may not bind. Try inspecting loaded scripts with list-scripts and target the compiled .js file instead."
        : "";
      process.stderr.write(
        `[cf-inspector] warning: breakpoint ${handle.file}:${handle.line.toString()} ` +
          `did not bind to any loaded script. Check the path or pass --remote-root. ` +
          `Use 'list-scripts' to inspect what V8 currently has loaded.${tsHint}\n`,
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
