import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  resume,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "../../inspector/index.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { CfInspectorError } from "../../types.js";
import type { BreakpointLocation, RemoteRootSetting, SnapshotResult } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_BREAKPOINT_TIMEOUT_SEC } from "../commandTypes.js";
import type { SnapshotCommandOptions, Target } from "../commandTypes.js";
import { writeHumanSnapshot, writeJson } from "../output.js";
import { parsePositiveInt, resolveTarget, withSession } from "../target.js";
import {
  roundDurationMs,
  warnOnUnboundBreakpoints,
  warnOnUnmatchedPause,
  withPausedDuration,
} from "../warnings.js";

interface PreparedSnapshotCommand {
  readonly target: Target;
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
  const prepared = prepareSnapshotCommand(opts);
  const result = await runSnapshotCommand(prepared, opts);
  if (opts.json) {
    writeJson(result);
  } else {
    writeHumanSnapshot(result);
  }
}

function prepareSnapshotCommand(opts: SnapshotCommandOptions): PreparedSnapshotCommand {
  const target = resolveTarget(opts);
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
  return {
    target,
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
): Promise<SnapshotResult> {
  return await withSession(command.target, async (session): Promise<SnapshotResult> => {
    if (command.condition !== undefined) {
      await validateExpression(session, command.condition);
    }
    const handles = await Promise.all(
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
    warnOnUnboundBreakpoints(handles);
    const pause = await waitForCommandPause(session, opts, handles, command.timeoutMs);
    const pausedStartedAt = pause.receivedAtMs ?? performance.now();
    const snapshot = await captureSnapshot(session, pause, {
      captures: command.captures,
      includeScopes: opts.includeScopes === true,
      ...(command.maxValueLength === undefined ? {} : { maxValueLength: command.maxValueLength }),
      ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
      stackCaptures: command.stackCaptures,
    });
    if (opts.keepPaused === true) {
      return withPausedDuration(snapshot, null);
    }
    return await resumeAfterSnapshot(session, snapshot, pausedStartedAt);
  });
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
): Promise<SnapshotResult> {
  try {
    await resume(session);
    return withPausedDuration(snapshot, roundDurationMs(performance.now() - pausedStartedAt));
  } catch {
    process.stderr.write(
      "[cf-inspector] warning: Debugger.resume failed after snapshot; pausedDurationMs is unknown.\n",
    );
    return withPausedDuration(snapshot, null);
  }
}
