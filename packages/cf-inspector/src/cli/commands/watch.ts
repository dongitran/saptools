import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  resume,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "../../inspector/index.js";
import type { InspectorSession } from "../../inspector/types.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { CfInspectorError } from "../../types.js";
import type { BreakpointHandle, BreakpointLocation, RemoteRootSetting, WatchEvent } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_BREAKPOINT_TIMEOUT_SEC } from "../commandTypes.js";
import type { Target, WatchCommandOptions } from "../commandTypes.js";
import { writeJson, writeWatchEvent } from "../output.js";
import { parsePositiveInt, resolveTarget, withSession } from "../target.js";
import { warnOnUnboundBreakpoints } from "../warnings.js";

interface PreparedWatchCommand {
  readonly target: Target;
  readonly breakpoints: readonly BreakpointLocation[];
  readonly captures: readonly string[];
  readonly remoteRoot: RemoteRootSetting;
  readonly perHitTimeoutMs: number;
  readonly durationMs?: number;
  readonly maxEvents?: number;
  readonly maxValueLength?: number;
  readonly condition?: string;
  readonly hitCount?: number;
  readonly stackDepth?: number;
  readonly stackCaptures: readonly string[];
}

type WatchStopReason = "duration" | "signal" | "max-events" | "transport-closed";

export async function handleWatch(opts: WatchCommandOptions): Promise<void> {
  const prepared = prepareWatchCommand(opts);
  const abort = new AbortController();
  const onSig = (): void => {
    abort.abort();
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  let stoppedReason: WatchStopReason = "signal";
  let emitted = 0;
  try {
    await withSession(prepared.target, async (session) => {
      const result = await runWatchLoop(session, prepared, opts, abort.signal);
      stoppedReason = result.stoppedReason;
      emitted = result.emitted;
    });
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
  writeWatchSummary(stoppedReason, emitted, opts.json);
}

function prepareWatchCommand(opts: WatchCommandOptions): PreparedWatchCommand {
  const target = resolveTarget(opts);
  if (opts.bp.length === 0) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      "At least one --bp <file:line> is required.",
    );
  }
  const perHitTimeoutSec = parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_BREAKPOINT_TIMEOUT_SEC;
  const durationSec = parsePositiveInt(opts.duration, "--duration");
  const maxEvents = parsePositiveInt(opts.maxEvents, "--max-events");
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length");
  const hitCount = parsePositiveInt(opts.hitCount, "--hit-count");
  const stackDepth = parsePositiveInt(opts.stackDepth, "--stack-depth");
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;
  return {
    target,
    breakpoints: opts.bp.map((spec) => parseBreakpointSpec(spec)),
    captures: parseCaptureList(opts.capture),
    remoteRoot: parseRemoteRoot(opts.remoteRoot),
    perHitTimeoutMs: perHitTimeoutSec * 1000,
    ...(durationSec === undefined ? {} : { durationMs: durationSec * 1000 }),
    ...(maxEvents === undefined ? {} : { maxEvents }),
    ...(maxValueLength === undefined ? {} : { maxValueLength }),
    ...(condition === undefined ? {} : { condition }),
    ...(hitCount === undefined ? {} : { hitCount }),
    ...(stackDepth === undefined ? {} : { stackDepth }),
    stackCaptures: parseCaptureList(opts.stackCaptures),
  };
}

interface WatchLoopResult {
  readonly emitted: number;
  readonly stoppedReason: WatchStopReason;
}

async function runWatchLoop(
  session: InspectorSession,
  command: PreparedWatchCommand,
  opts: WatchCommandOptions,
  signal: AbortSignal,
): Promise<WatchLoopResult> {
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

  const deadline = computeDeadline(command.durationMs);
  let emitted = 0;
  const state: { stopped: boolean; reason: WatchStopReason } = { stopped: false, reason: "signal" };

  const setStop = (reason: WatchStopReason): void => {
    if (state.stopped) {
      return;
    }
    state.reason = reason;
    state.stopped = true;
  };

  const transportClosed = waitForTransportClose(session);
  transportClosed.promise.then(() => {
    setStop("transport-closed");
  }).catch(() => {
    /* swallowed: best-effort signal */
  });

  try {
    while (!state.stopped) {
      if (signal.aborted) {
        setStop("signal");
        break;
      }
      const remainingMs = remainingForLoop(deadline, command.perHitTimeoutMs);
      if (remainingMs <= 0) {
        setStop("duration");
        break;
      }
      const pause = await waitForNextWatchPause(session, handles, remainingMs, signal);
      if (pause === "signal") {
        setStop("signal");
        break;
      }
      if (pause === "timeout") {
        if (deadline !== undefined && performance.now() >= deadline) {
          setStop("duration");
          break;
        }
        continue;
      }
      const event = await captureWatchEvent(session, command, pause, emitted + 1, opts);
      emitted += 1;
      writeWatchEvent(event, opts.json);
      try {
        await resume(session);
      } catch {
        process.stderr.write("[cf-inspector] warning: Debugger.resume failed during watch.\n");
        setStop("transport-closed");
        break;
      }
      if (command.maxEvents !== undefined && emitted >= command.maxEvents) {
        setStop("max-events");
        break;
      }
    }
  } finally {
    transportClosed.cancel();
  }

  return { emitted, stoppedReason: state.reason };
}

function computeDeadline(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined) {
    return undefined;
  }
  return performance.now() + durationMs;
}

function remainingForLoop(deadline: number | undefined, perHitTimeoutMs: number): number {
  if (deadline === undefined) {
    return perHitTimeoutMs;
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(remaining, perHitTimeoutMs);
}

interface TransportClosedHandle {
  readonly promise: Promise<void>;
  cancel(): void;
}

function waitForTransportClose(session: InspectorSession): TransportClosedHandle {
  let cancelled = false;
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const off = session.client.onClose(() => {
    if (!cancelled) {
      resolve?.();
    }
  });
  return {
    promise,
    cancel: (): void => {
      cancelled = true;
      off();
      resolve?.();
    },
  };
}

async function waitForNextWatchPause(
  session: InspectorSession,
  handles: readonly BreakpointHandle[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof waitForPause>> | "signal" | "timeout"> {
  if (signal.aborted) {
    return "signal";
  }
  try {
    return await waitForPause(session, {
      timeoutMs,
      breakpointIds: handles.map((h) => h.breakpointId),
      unmatchedPausePolicy: "wait-for-resume",
    });
  } catch (err: unknown) {
    if (err instanceof CfInspectorError) {
      if (err.code === "BREAKPOINT_NOT_HIT") {
        return "timeout";
      }
      if (err.code === "UNRELATED_PAUSE_TIMEOUT") {
        return "timeout";
      }
    }
    throw err;
  }
}

async function captureWatchEvent(
  session: InspectorSession,
  command: PreparedWatchCommand,
  pause: Awaited<ReturnType<typeof waitForPause>>,
  hit: number,
  opts: WatchCommandOptions,
): Promise<WatchEvent> {
  const snapshot = await captureSnapshot(session, pause, {
    captures: command.captures,
    includeScopes: opts.includeScopes === true,
    ...(command.maxValueLength === undefined ? {} : { maxValueLength: command.maxValueLength }),
    ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
    stackCaptures: command.stackCaptures,
  });
  const at = formatLocation(command, snapshot.topFrame);
  const base: WatchEvent = {
    ts: new Date().toISOString(),
    at,
    hit,
    reason: snapshot.reason,
    hitBreakpoints: snapshot.hitBreakpoints,
    captures: snapshot.captures,
  };
  const withFrame = snapshot.topFrame === undefined ? base : { ...base, topFrame: snapshot.topFrame };
  const withStack = snapshot.stack === undefined ? withFrame : { ...withFrame, stack: snapshot.stack };
  return snapshot.exception === undefined ? withStack : { ...withStack, exception: snapshot.exception };
}

function formatLocation(
  command: PreparedWatchCommand,
  topFrame: { url?: string; line: number } | undefined,
): string {
  if (topFrame?.url !== undefined) {
    return `${topFrame.url}:${topFrame.line.toString()}`;
  }
  const first = command.breakpoints[0];
  if (first === undefined) {
    return "(unknown)";
  }
  return `${first.file}:${first.line.toString()}`;
}

function writeWatchSummary(reason: WatchStopReason, emitted: number, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ stopped: reason, emitted })}\n`);
    return;
  }
  process.stderr.write(
    `Stopped (${reason}); emitted ${emitted.toString()} watch ${emitted === 1 ? "event" : "events"}.\n`,
  );
}

export const internalsForTesting = {
  formatLocation,
  computeDeadline,
  remainingForLoop,
  prepareWatchCommand,
  writeJson,
};
