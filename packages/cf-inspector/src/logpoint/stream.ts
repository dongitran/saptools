import { removeBreakpoint, setBreakpoint } from "../inspector/breakpoints.js";
import type { InspectorSession } from "../inspector/types.js";
import { CfInspectorError } from "../types.js";
import type { BreakpointHandle, BreakpointLocation, RemoteRootSetting } from "../types.js";

import { buildLogpointCondition, generateSentinel } from "./condition.js";
import { asString, parseLogEvent } from "./events.js";
import type { ConsoleAPICalledParams, LogpointEvent } from "./events.js";

export type LogpointStopReason =
  | "duration"
  | "signal"
  | "transport-closed"
  | "max-events";

export interface LogpointStreamOptions {
  readonly location: BreakpointLocation;
  readonly expression: string;
  readonly remoteRoot?: RemoteRootSetting;
  readonly durationMs?: number;
  readonly maxEvents?: number;
  readonly hitCount?: number;
  readonly condition?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: LogpointEvent) => void;
  readonly onBreakpointSet?: (handle: BreakpointHandle) => void;
}

export interface LogpointStreamResult {
  readonly handle: BreakpointHandle;
  readonly sentinel: string;
  readonly emitted: number;
  readonly stoppedReason: LogpointStopReason;
}

function validateMaxEvents(maxEvents: number | undefined): number | undefined {
  if (maxEvents === undefined) {
    return undefined;
  }
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      `maxEvents must be a positive integer, received: ${maxEvents.toString()}`,
    );
  }
  return maxEvents;
}

function validateHitCount(hitCount: number | undefined): number | undefined {
  if (hitCount === undefined) {
    return undefined;
  }
  if (!Number.isInteger(hitCount) || hitCount <= 0) {
    throw new CfInspectorError(
      "INVALID_HIT_COUNT",
      `hitCount must be a positive integer, received: ${hitCount.toString()}`,
    );
  }
  return hitCount;
}

export async function streamLogpoint(
  session: InspectorSession,
  options: LogpointStreamOptions,
): Promise<LogpointStreamResult> {
  const maxEvents = validateMaxEvents(options.maxEvents);
  const hitCount = validateHitCount(options.hitCount);
  const sentinel = generateSentinel();
  const condition = buildLogpointCondition(sentinel, options.expression, {
    ...(options.condition === undefined ? {} : { predicate: options.condition }),
    ...(hitCount === undefined ? {} : { hitCount }),
  });
  let emitted = 0;
  let maxEventsReached = false;
  let stopMaxEvents: (() => void) | undefined;
  const offEvent = session.client.on("Runtime.consoleAPICalled", (raw) => {
    if (maxEventsReached) {
      return;
    }
    const event = toLogpointEvent(raw, sentinel, options.location);
    if (event === undefined) {
      return;
    }
    emitted += 1;
    try {
      options.onEvent(event);
    } catch {
      // A throwing onEvent must not stop the stream or skip the max-events
      // check below — that would cause us to overshoot the cap on every throw.
    }
    if (maxEvents !== undefined && emitted >= maxEvents) {
      maxEventsReached = true;
      stopMaxEvents?.();
    }
  });

  let handle: BreakpointHandle;
  try {
    handle = await setBreakpoint(session, {
      file: options.location.file,
      line: options.location.line,
      ...(options.remoteRoot === undefined ? {} : { remoteRoot: options.remoteRoot }),
      condition,
    });
  } catch (err: unknown) {
    offEvent();
    throw err;
  }
  options.onBreakpointSet?.(handle);

  try {
    const reason = await waitForStop(session, options, (signal) => {
      stopMaxEvents = signal;
      if (maxEventsReached) {
        signal();
      }
    });
    return { handle, sentinel, emitted, stoppedReason: reason };
  } finally {
    offEvent();
    await removeBreakpointBestEffort(session, handle.breakpointId);
  }
}

function toLogpointEvent(
  raw: unknown,
  sentinel: string,
  location: BreakpointLocation,
): LogpointEvent | undefined {
  const params = raw as ConsoleAPICalledParams;
  if (asString(params.type) !== "log") {
    return undefined;
  }
  const ts = typeof params.timestamp === "number" ? params.timestamp : undefined;
  return parseLogEvent(params.args, sentinel, location, ts);
}

async function removeBreakpointBestEffort(
  session: InspectorSession,
  breakpointId: string,
): Promise<void> {
  try {
    await removeBreakpoint(session, breakpointId);
  } catch {
    // best-effort: tunnel may be gone
  }
}

async function waitForStop(
  session: InspectorSession,
  options: LogpointStreamOptions,
  registerMaxEventsSignal: (signal: () => void) => void,
): Promise<LogpointStopReason> {
  return await new Promise<LogpointStopReason>((resolve) => {
    let settled = false;
    const finish = (reason: LogpointStopReason): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(reason);
    };
    const timer = options.durationMs === undefined
      ? undefined
      : setTimeout(() => {
          finish("duration");
        }, options.durationMs);
    const offClose = session.client.onClose(() => {
      finish("transport-closed");
    });
    const onAbort = (): void => {
      finish("signal");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      finish("signal");
    }
    registerMaxEventsSignal(() => {
      finish("max-events");
    });
    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      offClose();
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}
