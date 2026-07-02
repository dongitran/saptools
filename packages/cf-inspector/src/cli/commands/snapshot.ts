import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  resume,
  runSetupEvals,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "../../inspector/index.js";
import type { InspectorSession } from "../../inspector/types.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { CfInspectorError } from "../../types.js";
import type { BreakpointLocation, RemoteRootSetting, SnapshotResult } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_BREAKPOINT_TIMEOUT_SEC } from "../commandTypes.js";
import type { SnapshotCommandOptions, Target } from "../commandTypes.js";
import { writeHumanSnapshot, writeJson, writeProgress } from "../output.js";
import { parsePositiveInt, resolveTargetWithCurrentCfTarget, withSession } from "../target.js";
import type { ProgressReporter } from "../target.js";
import {
  roundDurationMs,
  warnOnUnboundBreakpoints,
  warnOnUnmatchedPause,
  withPausedDuration,
} from "../warnings.js";

interface PreparedSnapshotCommand {
  readonly target: Target;
  readonly setupEvals: readonly string[];
  readonly breakpoints: readonly BreakpointLocation[];
  readonly captures: readonly string[];
  readonly remoteRoot: RemoteRootSetting;
  readonly timeoutMs: number;
  readonly maxValueLength?: number;
  readonly condition?: string;
  readonly hitCount?: number;
  readonly stackDepth?: number;
  readonly stackCaptures: readonly string[];
}

export async function handleSnapshot(opts: SnapshotCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts, { useTimeoutForTunnel: false });
  const prepared = prepareSnapshotCommand(opts, target);
  const reportProgress = opts.quiet === true ? undefined : writeProgress;
  const result = await runSnapshotCommand(prepared, opts, reportProgress);
  if (opts.json) {
    writeJson(result);
  } else {
    writeHumanSnapshot(result);
  }
  reportProgress?.("Snapshot complete.");
}

function prepareSnapshotCommand(opts: SnapshotCommandOptions, target: Target): PreparedSnapshotCommand {
  if (opts.bp.length === 0) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      "At least one --bp <file:line> is required.",
    );
  }
  const timeoutSec = parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_BREAKPOINT_TIMEOUT_SEC;
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length");
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;
  const hitCount = parsePositiveInt(opts.hitCount, "--hit-count");
  const stackDepth = parsePositiveInt(opts.stackDepth, "--stack-depth");
  const setupEvals = parseSetupEvals(opts.setupEval);
  return {
    target,
    setupEvals,
    breakpoints: opts.bp.map((spec) => parseBreakpointSpec(spec)),
    captures: parseCaptureList(opts.capture),
    remoteRoot: parseRemoteRoot(opts.remoteRoot),
    timeoutMs: timeoutSec * 1000,
    ...(condition === undefined ? {} : { condition }),
    ...(maxValueLength === undefined ? {} : { maxValueLength }),
    ...(hitCount === undefined ? {} : { hitCount }),
    ...(stackDepth === undefined ? {} : { stackDepth }),
    stackCaptures: parseCaptureList(opts.stackCaptures),
  };
}

async function runSnapshotCommand(
  command: PreparedSnapshotCommand,
  opts: SnapshotCommandOptions,
  reportProgress?: ProgressReporter,
): Promise<SnapshotResult> {
  return await withSession(command.target, async (session): Promise<SnapshotResult> => {
    return await runSnapshotOnSession(session, command, opts, reportProgress);
  }, reportProgress);
}

async function runSnapshotOnSession(
  session: InspectorSession,
  command: PreparedSnapshotCommand,
  opts: SnapshotCommandOptions,
  reportProgress?: ProgressReporter,
): Promise<SnapshotResult> {
  if (command.setupEvals.length > 0) {
    const setupCount = command.setupEvals.length;
    reportProgress?.(`Running ${setupCount.toString()} setup ${setupCount === 1 ? "evaluation" : "evaluations"}...`);
    await runSetupEvals(session, command.setupEvals);
    reportProgress?.("Setup evaluation complete.");
  }

  if (command.condition !== undefined) {
    reportProgress?.("Validating the breakpoint condition...");
    await validateExpression(session, command.condition);
    reportProgress?.("Breakpoint condition is valid.");
  }
  const breakpointCount = command.breakpoints.length;
  reportProgress?.(
    `Setting ${breakpointCount.toString()} ${breakpointCount === 1 ? "breakpoint" : "breakpoints"}...`,
  );
  const handles = await setCommandBreakpoints(session, command);
  const resolvedCount = handles.reduce(
    (total, handle) => total + handle.resolvedLocations.length,
    0,
  );
  reportProgress?.(
    `Breakpoint setup complete: ${resolvedCount.toString()} resolved ${resolvedCount === 1 ? "location" : "locations"}.`,
  );
  warnOnUnboundBreakpoints(handles);
  reportProgress?.(
    `Waiting up to ${(command.timeoutMs / 1000).toString()}s for a breakpoint hit...`,
  );
  const pause = await waitForCommandPause(session, opts, handles, command.timeoutMs);
  const captureCount = command.captures.length;
  reportProgress?.(
    `Breakpoint hit; capturing ${captureCount.toString()} ${captureCount === 1 ? "expression" : "expressions"}...`,
  );
  const pausedStartedAt = pause.receivedAtMs ?? performance.now();
  const snapshot = await captureSnapshot(session, pause, {
    captures: command.captures,
    includeScopes: opts.includeScopes === true,
    ...(command.maxValueLength === undefined ? {} : { maxValueLength: command.maxValueLength }),
    ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
    stackCaptures: command.stackCaptures,
  });
  if (opts.keepPaused === true) {
    reportProgress?.("Snapshot captured; leaving the target paused as requested.");
    return withPausedDuration(snapshot, null);
  }
  reportProgress?.("Snapshot captured; resuming the target...");
  return await resumeAfterSnapshot(session, snapshot, pausedStartedAt, reportProgress);
}

async function setCommandBreakpoints(
  session: Parameters<typeof setBreakpoint>[0],
  command: PreparedSnapshotCommand,
): Promise<readonly Awaited<ReturnType<typeof setBreakpoint>>[]> {
  return await Promise.all(
    command.breakpoints.map((bp) =>
      setBreakpoint(session, {
        file: bp.file,
        line: bp.line,
        remoteRoot: command.remoteRoot,
        ...(command.condition === undefined ? {} : { condition: command.condition }),
        ...(command.hitCount === undefined ? {} : { hitCount: command.hitCount }),
      }),
    ),
  );
}

async function waitForCommandPause(
  session: Parameters<typeof waitForPause>[0],
  opts: SnapshotCommandOptions,
  handles: readonly Awaited<ReturnType<typeof setBreakpoint>>[],
  timeoutMs: number,
): ReturnType<typeof waitForPause> {
  let warnedUnmatchedPause = false;
  return await waitForPause(session, {
    timeoutMs,
    breakpointIds: handles.map((h) => h.breakpointId),
    unmatchedPausePolicy: opts.failOnUnmatchedPause === true ? "fail" : "wait-for-resume",
    onUnmatchedPause: (unmatchedPause) => {
      if (warnedUnmatchedPause || opts.failOnUnmatchedPause === true) {
        return;
      }
      warnedUnmatchedPause = true;
      warnOnUnmatchedPause(unmatchedPause);
    },
  });
}

async function resumeAfterSnapshot(
  session: Parameters<typeof resume>[0],
  snapshot: Awaited<ReturnType<typeof captureSnapshot>>,
  pausedStartedAt: number,
  reportProgress?: ProgressReporter,
): Promise<SnapshotResult> {
  try {
    await resume(session);
    reportProgress?.("Target resumed.");
    return withPausedDuration(snapshot, roundDurationMs(performance.now() - pausedStartedAt));
  } catch {
    process.stderr.write(
      "[cf-inspector] warning: Debugger.resume failed after snapshot; pausedDurationMs is unknown.\n",
    );
    return withPausedDuration(snapshot, null);
  }
}

function parseSetupEvals(raw: unknown): readonly string[] {
  const values: readonly unknown[] = Array.isArray(raw) ? raw : [];
  return values
    .filter((expr): expr is string => typeof expr === "string" && expr.trim().length > 0)
    .map((expr) => expr.trim());
}

export const internalsForTesting = {
  parseSetupEvals,
  prepareSnapshotCommand,
  runSnapshotCommand,
  runSnapshotOnSession,
};
