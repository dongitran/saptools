import process from "node:process";

import { validateExpression } from "../../inspector/runtime.js";
import type { InspectorSession, InspectorSessionGroup } from "../../inspector/types.js";
import type { LogpointStreamResult } from "../../logpoint/stream.js";
import { streamLogpoint } from "../../logpoint/stream.js";
import { parseBreakpointSpec, parseRemoteRoot } from "../../pathMapper.js";
import { DEFAULT_STREAM_MAX_VALUE_LENGTH } from "../../snapshot/values.js";
import { CfInspectorError } from "../../types.js";
import type { LogCommandOptions } from "../commandTypes.js";
import { writeLogEvent } from "../output.js";
import { withTerminationSignal } from "../signals.js";
import { parsePositiveInt, resolveTargetWithCurrentCfTarget, withSessions } from "../target.js";
import {
  warnOnBoundBreakpointWithoutHit,
  warnOnMutationRisk,
  warnOnUnboundBreakpoints,
} from "../warnings.js";

export async function handleLog(opts: LogCommandOptions): Promise<void> {
  const target = await resolveTargetWithCurrentCfTarget(opts);
  const location = parseBreakpointSpec(opts.at);
  const remoteRoot = parseRemoteRoot(opts.remoteRoot);
  const durationSec = parsePositiveInt(opts.duration, "--duration");
  const maxEvents = parsePositiveInt(opts.maxEvents, "--max-events");
  const hitCount = parsePositiveInt(opts.hitCount, "--hit-count");
  const maxValueLength = parsePositiveInt(opts.maxValueLength, "--max-value-length")
    ?? DEFAULT_STREAM_MAX_VALUE_LENGTH;
  const expression = opts.expr.trim();
  if (expression.length === 0) {
    throw new CfInspectorError("INVALID_EXPRESSION", "--expr must not be empty");
  }
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;
  warnOnMutationRisk(expression, "log --expr");
  if (condition !== undefined) {
    warnOnMutationRisk(condition, "log --condition");
  }

  await withTerminationSignal(async (signal) => {
    await withSessions(target, async (group) => {
      const result = await runLogGroup(group, {
        location,
        expression,
        remoteRoot,
        ...(durationSec === undefined ? {} : { durationMs: durationSec * 1000 }),
        ...(maxEvents === undefined ? {} : { maxEvents }),
        ...(hitCount === undefined ? {} : { hitCount }),
        ...(condition === undefined ? {} : { condition }),
        maxValueLength,
        json: opts.json,
        signal,
      });
      writeLogSummary(result.stoppedReason, result.emitted, opts.json);
    }, undefined, signal);
  });
}

interface LogGroupOptions {
  readonly location: ReturnType<typeof parseBreakpointSpec>;
  readonly expression: string;
  readonly remoteRoot: ReturnType<typeof parseRemoteRoot>;
  readonly durationMs?: number;
  readonly maxEvents?: number;
  readonly hitCount?: number;
  readonly condition?: string;
  readonly maxValueLength: number;
  readonly json: boolean;
  readonly signal: AbortSignal;
}

interface LogGroupResult {
  readonly emitted: number;
  readonly stoppedReason: "duration" | "signal" | "transport-closed" | "max-events";
}

async function runLogGroup(
  group: InspectorSessionGroup,
  options: LogGroupOptions,
): Promise<LogGroupResult> {
  const controller = new AbortController();
  const tasks = new Set<Promise<LogpointStreamResult>>();
  const removedSessions = new Set<InspectorSession>();
  const results: LogpointStreamResult[] = [];
  let fatalError: unknown;
  let emitted = 0;
  let reason: LogGroupResult["stoppedReason"] = "signal";
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const finish = (nextReason: LogGroupResult["stoppedReason"]): void => {
    if (controller.signal.aborted) {
      return;
    }
    reason = nextReason;
    controller.abort();
    resolveStop?.();
  };
  const onSignal = (): void => {
    finish("signal");
  };
  options.signal.addEventListener("abort", onSignal, { once: true });
  if (options.signal.aborted) {
    finish("signal");
  }
  const timer = options.durationMs === undefined ? undefined : setTimeout(() => {
    finish("duration");
  }, options.durationMs);
  const startSession = (session: InspectorSession): void => {
    if (controller.signal.aborted) {
      return;
    }
    const task = (async (): Promise<LogpointStreamResult> => {
      await validateExpression(session, options.expression);
      if (options.condition !== undefined) {
        await validateExpression(session, options.condition);
      }
      return await streamLogpoint(session, {
        location: options.location,
        expression: options.expression,
        remoteRoot: options.remoteRoot,
        ...(options.hitCount === undefined ? {} : { hitCount: options.hitCount }),
        ...(options.condition === undefined ? {} : { condition: options.condition }),
        maxValueLength: options.maxValueLength,
        signal: controller.signal,
        onEvent: (event) => {
          if (controller.signal.aborted) {
            return;
          }
          emitted += 1;
          writeLogEvent({ ...event, isolate: session.isolate ?? { kind: "main" } }, options.json);
          if (options.maxEvents !== undefined && emitted >= options.maxEvents) {
            finish("max-events");
          }
        },
        onBreakpointSet: (handle) => {
          warnOnUnboundBreakpoints([handle]);
        },
      });
    })();
    tasks.add(task);
    void task.then(
      (result) => {
        results.push(result);
        if (result.stoppedReason === "transport-closed" && !removedSessions.has(session)) {
          finish("transport-closed");
        }
      },
      (error: unknown) => {
        fatalError = error;
        finish("transport-closed");
      },
    ).finally(() => {
      tasks.delete(task);
    });
  };
  const detach = group.onSession(startSession);
  const detachRemoved = group.onSessionRemoved((session) => {
    removedSessions.add(session);
  });
  try {
    await stopped;
    await Promise.allSettled([...tasks]);
  } finally {
    detach();
    detachRemoved();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal.removeEventListener("abort", onSignal);
  }
  if (emitted === 0 && isZeroHitStop(reason)) {
    warnOnBoundBreakpointWithoutHit(results.map((result) => result.handle));
  }
  if (fatalError !== undefined) {
    throw fatalError instanceof Error ? fatalError : new Error("Unknown logpoint fan-out failure");
  }
  return { emitted, stoppedReason: reason };
}

function isZeroHitStop(reason: LogGroupResult["stoppedReason"]): boolean {
  return reason === "duration" || reason === "signal";
}

function writeLogSummary(stoppedReason: string, emitted: number, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ stopped: stoppedReason, emitted })}\n`);
    return;
  }
  process.stderr.write(
    `Stopped (${stoppedReason}); emitted ${emitted.toString()} log ${emitted === 1 ? "entry" : "entries"}.\n`,
  );
}
