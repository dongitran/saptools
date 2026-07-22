import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  BreakpointFanout,
  resume,
  setPauseOnExceptions,
} from "../../inspector/index.js";
import type { InspectorSession, PauseOnExceptionsState } from "../../inspector/index.js";
import { parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { DEFAULT_MAX_VALUE_LENGTH } from "../../snapshot/values.js";
import { CfInspectorError } from "../../types.js";
import type { RemoteRootSetting, SnapshotResult } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_EXCEPTION_TIMEOUT_SEC } from "../commandTypes.js";
import type { ExceptionCommandOptions, Target } from "../commandTypes.js";
import { writeHumanSnapshot, writeJson } from "../output.js";
import { withTerminationSignal } from "../signals.js";
import { parsePositiveInt, resolveTargetWithCurrentCfTarget, withSessions } from "../target.js";
import { roundDurationMs, warnOnCaptureMutationRisk, withPausedDuration } from "../warnings.js";

const VALID_PAUSE_TYPES: readonly PauseOnExceptionsState[] = ["uncaught", "caught", "all"];

interface PreparedExceptionCommand {
  readonly target: Target;
  readonly state: PauseOnExceptionsState;
  readonly captures: readonly string[];
  readonly remoteRoot: RemoteRootSetting;
  readonly timeoutMs: number;
  readonly maxValueLength: number;
  readonly stackDepth?: number;
  readonly stackCaptures: readonly string[];
  readonly throwOnSideEffect: boolean;
}

export async function handleException(opts: ExceptionCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts, { useTimeoutForTunnel: false });
  const prepared = prepareExceptionCommand(opts, target);
  warnOnCaptureMutationRisk(
    [...prepared.captures, ...prepared.stackCaptures],
    opts.allowMutation === true,
  );
  const result = await withTerminationSignal(async (signal) =>
    await runExceptionCommand(prepared, opts, signal));
  if (opts.json) {
    writeJson(result);
  } else {
    writeHumanSnapshot(result);
  }
}

function prepareExceptionCommand(opts: ExceptionCommandOptions, target: Target): PreparedExceptionCommand {
  const stateRaw = (opts.type ?? "uncaught").trim().toLowerCase();
  if (!VALID_PAUSE_TYPES.includes(stateRaw as PauseOnExceptionsState)) {
    throw new CfInspectorError(
      "INVALID_PAUSE_TYPE",
      `--type must be one of ${VALID_PAUSE_TYPES.join(", ")} (received "${stateRaw}")`,
    );
  }
  const timeoutSec = parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_EXCEPTION_TIMEOUT_SEC;
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length")
    ?? DEFAULT_MAX_VALUE_LENGTH;
  const stackDepth = parsePositiveInt(opts.stackDepth, "--stack-depth");
  return {
    target,
    state: stateRaw as PauseOnExceptionsState,
    captures: parseCaptureList(opts.capture),
    remoteRoot: parseRemoteRoot(opts.remoteRoot),
    timeoutMs: timeoutSec * 1000,
    maxValueLength,
    ...(stackDepth === undefined ? {} : { stackDepth }),
    stackCaptures: parseCaptureList(opts.stackCaptures),
    throwOnSideEffect: opts.allowMutation !== true,
  };
}

async function runExceptionCommand(
  command: PreparedExceptionCommand,
  opts: ExceptionCommandOptions,
  signal?: AbortSignal,
): Promise<SnapshotResult> {
  return await withSessions(command.target, async (group): Promise<SnapshotResult> => {
    const fanout = new BreakpointFanout(group, async (session) => {
      await setPauseOnExceptions(session, command.state);
      return { handles: [] };
    }, ["exception", "promiseRejection"]);
    let winner: InspectorSession | undefined;
    let preserveWinner = false;
    try {
      await fanout.ready();
      const hit = await fanout.waitForFirst(command.timeoutMs, {
        pauseReasons: ["exception", "promiseRejection"],
        unmatchedPausePolicy: "wait-for-resume",
      }, signal);
      winner = hit.session;
      const pause = hit.pause;
      const pausedStartedAt = pause.receivedAtMs ?? performance.now();
      const snapshot = await captureSnapshot(hit.session, pause, {
        captures: command.captures,
        includeScopes: opts.includeScopes === true,
        maxValueLength: command.maxValueLength,
        ...(command.stackDepth === undefined ? {} : { stackDepth: command.stackDepth }),
        stackCaptures: command.stackCaptures,
        throwOnSideEffect: command.throwOnSideEffect,
      });
      if (opts.keepPaused === true) {
        preserveWinner = true;
        return { ...withPausedDuration(snapshot, null), isolate: hit.session.isolate ?? { kind: "main" } };
      }
      const result = await resumeAfterException(hit.session, snapshot, pausedStartedAt);
      return { ...result, isolate: hit.session.isolate ?? { kind: "main" } };
    } finally {
      await Promise.allSettled(group.list().map(async (session) => {
        await disablePauseOnExceptionsBestEffort(session);
      }));
      await fanout.cleanup(2_000, preserveWinner ? winner : undefined);
    }
  }, undefined, signal);
}

async function resumeAfterException(
  session: InspectorSession,
  snapshot: Awaited<ReturnType<typeof captureSnapshot>>,
  pausedStartedAt: number,
): Promise<SnapshotResult> {
  try {
    await resume(session);
    return withPausedDuration(snapshot, roundDurationMs(performance.now() - pausedStartedAt));
  } catch {
    process.stderr.write(
      "[cf-inspector] warning: Debugger.resume failed after exception capture; pausedDurationMs is unknown.\n",
    );
    return withPausedDuration(snapshot, null);
  }
}

async function disablePauseOnExceptionsBestEffort(session: InspectorSession): Promise<void> {
  try {
    await setPauseOnExceptions(session, "none");
  } catch {
    // best-effort: tunnel may be gone
  }
}

export const internalsForTesting = {
  prepareExceptionCommand,
};
