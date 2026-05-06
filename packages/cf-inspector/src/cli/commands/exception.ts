import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  resume,
  setPauseOnExceptions,
  waitForPause,
} from "../../inspector/index.js";
import type { InspectorSession, PauseOnExceptionsState } from "../../inspector/index.js";
import { parseRemoteRoot } from "../../pathMapper.js";
import { captureSnapshot } from "../../snapshot/capture.js";
import { CfInspectorError } from "../../types.js";
import type { RemoteRootSetting, SnapshotResult } from "../../types.js";
import { parseCaptureList } from "../captureParser.js";
import { DEFAULT_EXCEPTION_TIMEOUT_SEC } from "../commandTypes.js";
import type { ExceptionCommandOptions, Target } from "../commandTypes.js";
import { writeHumanSnapshot, writeJson } from "../output.js";
import { parsePositiveInt, resolveTarget, withSession } from "../target.js";
import { roundDurationMs, withPausedDuration } from "../warnings.js";

const VALID_PAUSE_TYPES: readonly PauseOnExceptionsState[] = ["uncaught", "caught", "all"];

interface PreparedExceptionCommand {
  readonly target: Target;
  readonly state: PauseOnExceptionsState;
  readonly captures: readonly string[];
  readonly remoteRoot: RemoteRootSetting;
  readonly timeoutMs: number;
  readonly maxValueLength?: number;
  readonly stackDepth?: number;
  readonly stackCaptures: readonly string[];
}

export async function handleException(opts: ExceptionCommandOptions): Promise<void> {
  const prepared = prepareExceptionCommand(opts);
  const result = await runExceptionCommand(prepared, opts);
  if (opts.json) {
    writeJson(result);
  } else {
    writeHumanSnapshot(result);
  }
}

function prepareExceptionCommand(opts: ExceptionCommandOptions): PreparedExceptionCommand {
  const target = resolveTarget(opts);
  const stateRaw = (opts.type ?? "uncaught").trim().toLowerCase();
  if (!VALID_PAUSE_TYPES.includes(stateRaw as PauseOnExceptionsState)) {
    throw new CfInspectorError(
      "INVALID_PAUSE_TYPE",
      `--type must be one of ${VALID_PAUSE_TYPES.join(", ")} (received "${stateRaw}")`,
    );
  }
  const timeoutSec = parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_EXCEPTION_TIMEOUT_SEC;
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length");
  const stackDepth = parsePositiveInt(opts.stackDepth, "--stack-depth");
  return {
    target,
    state: stateRaw as PauseOnExceptionsState,
    captures: parseCaptureList(opts.capture),
    remoteRoot: parseRemoteRoot(opts.remoteRoot),
    timeoutMs: timeoutSec * 1000,
    ...(maxValueLength === undefined ? {} : { maxValueLength }),
    ...(stackDepth === undefined ? {} : { stackDepth }),
    stackCaptures: parseCaptureList(opts.stackCaptures),
  };
}

async function runExceptionCommand(
  command: PreparedExceptionCommand,
  opts: ExceptionCommandOptions,
): Promise<SnapshotResult> {
  return await withSession(command.target, async (session): Promise<SnapshotResult> => {
    await setPauseOnExceptions(session, command.state);
    try {
      const pause = await waitForPause(session, {
        timeoutMs: command.timeoutMs,
        pauseReasons: ["exception", "promiseRejection"],
        unmatchedPausePolicy: "wait-for-resume",
      });
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
      return await resumeAfterException(session, snapshot, pausedStartedAt);
    } finally {
      await disablePauseOnExceptionsBestEffort(session);
    }
  });
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
