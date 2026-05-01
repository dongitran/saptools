import { removeBreakpoint, setBreakpoint } from "../inspector/breakpoints.js";
import type { InspectorSession } from "../inspector/types.js";
import type { BreakpointHandle, BreakpointLocation, RemoteRootSetting } from "../types.js";

import { buildLogpointCondition, generateSentinel } from "./condition.js";
import { asString, parseLogEvent } from "./events.js";
import type { ConsoleAPICalledParams, LogpointEvent } from "./events.js";

export interface LogpointStreamOptions {
  readonly location: BreakpointLocation;
  readonly expression: string;
  readonly remoteRoot?: RemoteRootSetting;
  readonly durationMs?: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: LogpointEvent) => void;
  readonly onBreakpointSet?: (handle: BreakpointHandle) => void;
}

export interface LogpointStreamResult {
  readonly handle: BreakpointHandle;
  readonly sentinel: string;
  readonly emitted: number;
  readonly stoppedReason: "duration" | "signal" | "transport-closed";
}

export async function streamLogpoint(
  session: InspectorSession,
  options: LogpointStreamOptions,
): Promise<LogpointStreamResult> {
  const sentinel = generateSentinel();
  const condition = buildLogpointCondition(sentinel, options.expression);
  let emitted = 0;
  const offEvent = session.client.on("Runtime.consoleAPICalled", (raw) => {
    const event = toLogpointEvent(raw, sentinel, options.location);
    if (event === undefined) {
      return;
    }
    emitted += 1;
    options.onEvent(event);
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
    const reason = await waitForStop(session, options);
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
): Promise<LogpointStreamResult["stoppedReason"]> {
  return await new Promise<LogpointStreamResult["stoppedReason"]>((resolve) => {
    let settled = false;
    const finish = (reason: LogpointStreamResult["stoppedReason"]): void => {
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
    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      offClose();
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}
