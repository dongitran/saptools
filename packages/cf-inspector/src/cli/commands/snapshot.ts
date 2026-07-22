import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  BreakpointFanout,
  resume,
  runSetupEvals,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "../../inspector/index.js";
import type { InspectorSession } from "../../inspector/types.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { DEFAULT_MAX_VALUE_LENGTH } from "../../snapshot/values.js";
import { CfInspectorError } from "../../types.js";
import type { BreakpointLocation, RemoteRootSetting, SnapshotResult } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_BREAKPOINT_TIMEOUT_SEC } from "../commandTypes.js";
import type { SnapshotCommandOptions, Target } from "../commandTypes.js";
import { writeHumanSnapshot, writeJson, writeProgress } from "../output.js";
import { withTerminationSignal } from "../signals.js";
import { parsePositiveInt, resolveTargetWithCurrentCfTarget, withSessions } from "../target.js";
import type { ProgressReporter } from "../target.js";
import {
  enforceNativeConditionMutationPolicy,
  roundDurationMs,
  warnOnCaptureMutationRisk,
  warnOnBoundBreakpointWithoutHit,
  warnOnMutationRisk,
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
  readonly maxValueLength: number;
  readonly condition?: string;
  readonly hitCount?: number;
  readonly stackDepth?: number;
  readonly stackCaptures: readonly string[];
  readonly throwOnSideEffect: boolean;
}

export async function handleSnapshot(opts: SnapshotCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts, { useTimeoutForTunnel: false });
  const prepared = prepareSnapshotCommand(opts, target);
  warnOnCaptureMutationRisk(
    [...prepared.captures, ...prepared.stackCaptures],
    opts.allowMutation === true,
  );
  for (const expression of prepared.setupEvals) {
    warnOnMutationRisk(expression, "snapshot --setup-eval");
  }
  const reportProgress = opts.quiet === true ? undefined : writeProgress;
  const result = await withTerminationSignal(async (signal) =>
    await runSnapshotCommand(prepared, opts, reportProgress, signal));
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
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length")
    ?? DEFAULT_MAX_VALUE_LENGTH;
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;
  const hitCount = parsePositiveInt(opts.hitCount, "--hit-count");
  const stackDepth = parsePositiveInt(opts.stackDepth, "--stack-depth");
  const setupEvals = parseSetupEvals(opts.setupEval);
  enforceNativeConditionMutationPolicy(
    condition ?? "",
    opts.allowMutation === true,
    "snapshot --condition",
  );
  return {
    target,
    setupEvals,
    breakpoints: opts.bp.map((spec) => parseBreakpointSpec(spec)),
    captures: parseCaptureList(opts.capture),
    remoteRoot: parseRemoteRoot(opts.remoteRoot),
    timeoutMs: timeoutSec * 1000,
    ...(condition === undefined ? {} : { condition }),
    maxValueLength,
    ...(hitCount === undefined ? {} : { hitCount }),
    ...(stackDepth === undefined ? {} : { stackDepth }),
    stackCaptures: parseCaptureList(opts.stackCaptures),
    throwOnSideEffect: opts.allowMutation !== true,
  };
}

async function runSnapshotCommand(
  command: PreparedSnapshotCommand,
  opts: SnapshotCommandOptions,
  reportProgress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<SnapshotResult> {
  return await withSessions(command.target, async (group): Promise<SnapshotResult> => {
    if (command.setupEvals.length > 0) {
      const setupCount = command.setupEvals.length;
      reportProgress?.(
        `Running ${setupCount.toString()} setup ${setupCount === 1 ? "evaluation" : "evaluations"}...`,
      );
    }
    if (command.condition !== undefined) {
      reportProgress?.("Validating the breakpoint condition...");
    }
    const breakpointCount = command.breakpoints.length;
    reportProgress?.(
      `Setting ${breakpointCount.toString()} ${breakpointCount === 1 ? "breakpoint" : "breakpoints"}...`,
    );
    const fanout = new BreakpointFanout(group, async (session, trackHandle) => {
      await prepareSnapshotSession(session, command);
      return { handles: await setCommandBreakpoints(session, command, trackHandle) };
    });
    let winner: InspectorSession | undefined;
    let preserveWinner = false;
    try {
      await fanout.ready();
      if (command.setupEvals.length > 0) {
        reportProgress?.("Setup evaluation complete.");
      }
      if (command.condition !== undefined) {
        reportProgress?.("Breakpoint condition is valid.");
      }
      const outcomes = fanout.availableOutcomes();
      reportBreakpointOutcomes(outcomes, reportProgress);
      reportProgress?.(
        `Waiting up to ${(command.timeoutMs / 1000).toString()}s for a breakpoint hit...`,
      );
      const hit = await fanout.waitForFirst(command.timeoutMs, {
        unmatchedPausePolicy: opts.failOnUnmatchedPause === true ? "fail" : "wait-for-resume",
        ...(opts.failOnUnmatchedPause === true ? {} : { onUnmatchedPause: warnOnUnmatchedPause }),
      }, signal);
      winner = hit.session;
      const captureCount = command.captures.length;
      reportProgress?.(
        `Breakpoint hit; capturing ${captureCount.toString()} ${captureCount === 1 ? "expression" : "expressions"}...`,
      );
      const result = await captureSnapshotResult(hit.session, hit.pause, command, opts, reportProgress);
      preserveWinner = opts.keepPaused === true;
      return { ...result, isolate: hit.session.isolate ?? { kind: "main" } };
    } catch (error: unknown) {
      if (error instanceof CfInspectorError && (
        error.code === "BREAKPOINT_NOT_HIT" || error.code === "UNRELATED_PAUSE_TIMEOUT"
      )) {
        const outcomes = fanout.availableOutcomes();
        warnOnBoundBreakpointWithoutHit(outcomes.flatMap((outcome) => outcome.setup.handles));
      }
      throw error;
    } finally {
      const cleanup = await fanout.cleanup(2_000, preserveWinner ? winner : undefined);
      reportProgress?.(
        `Breakpoint cleanup: cleared ${cleanup.cleared.toString()} of ${cleanup.attempted.toString()}; resumed ${cleanup.resumed.toString()} paused losing isolates.`,
      );
    }
  }, reportProgress, signal);
}

async function prepareSnapshotSession(
  session: InspectorSession,
  command: PreparedSnapshotCommand,
): Promise<void> {
  if (command.setupEvals.length > 0) {
    await runSetupEvals(session, command.setupEvals);
  }
  if (command.condition !== undefined) {
    await validateExpression(session, command.condition);
  }
}

function reportBreakpointOutcomes(
  outcomes: readonly {
    readonly session: InspectorSession;
    readonly setup: { readonly handles: readonly Awaited<ReturnType<typeof setBreakpoint>>[] };
  }[],
  reportProgress?: ProgressReporter,
): void {
  for (const outcome of outcomes) {
    warnOnUnboundBreakpoints(outcome.setup.handles);
  }
  const boundSessions = outcomes.filter((outcome) =>
    outcome.setup.handles.some((handle) => handle.resolvedLocations.length > 0)).length;
  const locations = outcomes.reduce((total, outcome) => total + outcome.setup.handles.reduce(
    (sessionTotal, handle) => sessionTotal + handle.resolvedLocations.length,
    0,
  ), 0);
  if (outcomes.length === 1) {
    reportProgress?.(
      `Breakpoint setup complete: ${locations.toString()} resolved ${locations === 1 ? "location" : "locations"}.`,
    );
    return;
  }
  reportProgress?.(
    `Breakpoint setup complete: sessions=${outcomes.length.toString()} boundSessions=${boundSessions.toString()} resolvedLocations=${locations.toString()}.`,
  );
}

async function captureSnapshotResult(
  session: InspectorSession,
  pause: Awaited<ReturnType<typeof waitForPause>>,
  command: PreparedSnapshotCommand,
  opts: SnapshotCommandOptions,
  reportProgress?: ProgressReporter,
): Promise<SnapshotResult> {
  const pausedStartedAt = pause.receivedAtMs ?? performance.now();
  const snapshot = await captureSnapshot(session, pause, {
    captures: command.captures,
    includeScopes: opts.includeScopes === true,
    maxValueLength: command.maxValueLength,
    ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
    stackCaptures: command.stackCaptures,
    throwOnSideEffect: command.throwOnSideEffect,
  });
  if (opts.keepPaused === true) {
    return withPausedDuration(snapshot, null);
  }
  reportProgress?.("Snapshot captured; resuming the target...");
  return await resumeAfterSnapshot(session, snapshot, pausedStartedAt, reportProgress);
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
    maxValueLength: command.maxValueLength,
    ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
    stackCaptures: command.stackCaptures,
    throwOnSideEffect: command.throwOnSideEffect,
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
  onSet?: (handle: Awaited<ReturnType<typeof setBreakpoint>>) => void,
): Promise<readonly Awaited<ReturnType<typeof setBreakpoint>>[]> {
  return await Promise.all(
    command.breakpoints.map((bp) =>
      setBreakpoint(session, {
        file: bp.file,
        line: bp.line,
        remoteRoot: command.remoteRoot,
        ...(command.condition === undefined ? {} : { condition: command.condition }),
        ...(command.hitCount === undefined ? {} : { hitCount: command.hitCount }),
      }).then((handle) => {
        onSet?.(handle);
        return handle;
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
  try {
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
  } catch (error: unknown) {
    if (
      error instanceof CfInspectorError &&
      (error.code === "BREAKPOINT_NOT_HIT" || error.code === "UNRELATED_PAUSE_TIMEOUT")
    ) {
      warnOnBoundBreakpointWithoutHit(handles);
    }
    throw error;
  }
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
