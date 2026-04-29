import { randomBytes } from "node:crypto";

import { removeBreakpoint, setBreakpoint } from "./inspector.js";
import type { InspectorSession } from "./inspector.js";
import type { BreakpointHandle, BreakpointLocation, RemoteRootSetting } from "./types.js";

const SENTINEL_PREFIX = "__CFI_LOG_";
const SENTINEL_SUFFIX = "__";

export interface LogpointEvent {
  readonly ts: string;
  readonly at: string;
  readonly value?: string;
  readonly error?: string;
  readonly raw?: string;
}

export interface LogpointStreamOptions {
  readonly location: BreakpointLocation;
  readonly expression: string;
  readonly remoteRoot?: RemoteRootSetting;
  readonly durationMs?: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: LogpointEvent) => void;
}

export interface LogpointStreamResult {
  readonly handle: BreakpointHandle;
  readonly sentinel: string;
  /** Emitted log count, including parse errors that kept the sentinel. */
  readonly emitted: number;
  readonly stoppedReason: "duration" | "signal" | "transport-closed";
}

/**
 * Serialize a CDP-side IIFE that runs the user's expression as a "logpoint":
 * never pauses (always returns false), tags each emitted log with a unique
 * sentinel so we can distinguish our logs from app traffic, and wraps both the
 * user expression and JSON.stringify in try/catch so a thrown expression still
 * surfaces an error event instead of silently breaking the breakpoint.
 *
 * Exported for unit testing — the wire format is part of the contract.
 */
export function buildLogpointCondition(sentinel: string, expression: string): string {
  // sentinel embedded as a JS string literal; expression wrapped in parens.
  // The IIFE returns false so V8 never pauses the inspectee.
  return [
    "(function(){",
    `var s=${JSON.stringify(sentinel)};`,
    "try{",
    `var v=(${expression});`,
    "var r=typeof v==='string'?v:JSON.stringify(v);",
    "console.log(s, r);",
    "}catch(e){",
    "console.log(s, '!err:'+(e&&e.message?e.message:String(e)));",
    "}",
    "return false;",
    "})()",
  ].join("");
}

interface CdpRemoteObject {
  type?: unknown;
  value?: unknown;
}

interface ConsoleAPICalledParams {
  type?: unknown;
  args?: unknown;
  timestamp?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readArg(arg: unknown, index: number): string | undefined {
  if (typeof arg !== "object" || arg === null) {
    return undefined;
  }
  const candidate = arg as CdpRemoteObject;
  if (candidate.type === "string" && typeof candidate.value === "string") {
    return candidate.value;
  }
  // Other primitives — coerce via String() only on confirmed-primitive types.
  const isPrimitiveType =
    candidate.type === "number" ||
    candidate.type === "boolean" ||
    candidate.type === "bigint";
  const isPrimitiveValue =
    typeof candidate.value === "number" ||
    typeof candidate.value === "boolean" ||
    typeof candidate.value === "bigint";
  if (isPrimitiveType && isPrimitiveValue) {
    return String(candidate.value);
  }
  // For first arg, only string sentinel matters; for second we handle below.
  return index === 0 ? undefined : "";
}

function parseLogEvent(
  rawArgs: unknown,
  sentinel: string,
  location: BreakpointLocation,
  timestamp: number | undefined,
): LogpointEvent | undefined {
  if (!Array.isArray(rawArgs) || rawArgs.length < 2) {
    return undefined;
  }
  const tag = readArg(rawArgs[0], 0);
  if (tag !== sentinel) {
    return undefined;
  }
  const payload = readArg(rawArgs[1], 1) ?? "";
  const ts = new Date(typeof timestamp === "number" ? timestamp : Date.now()).toISOString();
  const at = `${location.file}:${location.line.toString()}`;
  if (payload.startsWith("!err:")) {
    return { ts, at, error: payload.slice("!err:".length) };
  }
  // Distinguish JSON-encoded vs already-string values by trying to parse;
  // unparseable strings are emitted as raw to preserve whatever the user logged.
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "string") {
      return { ts, at, value: parsed };
    }
    return { ts, at, value: JSON.stringify(parsed) };
  } catch {
    return { ts, at, value: payload, raw: payload };
  }
}

function generateSentinel(): string {
  return `${SENTINEL_PREFIX}${randomBytes(8).toString("hex")}${SENTINEL_SUFFIX}`;
}

export async function streamLogpoint(
  session: InspectorSession,
  options: LogpointStreamOptions,
): Promise<LogpointStreamResult> {
  const sentinel = generateSentinel();
  const condition = buildLogpointCondition(sentinel, options.expression);
  const handle = await setBreakpoint(session, {
    file: options.location.file,
    line: options.location.line,
    ...(options.remoteRoot === undefined ? {} : { remoteRoot: options.remoteRoot }),
    condition,
  });

  let emitted = 0;
  const offEvent = session.client.on("Runtime.consoleAPICalled", (raw) => {
    const params = raw as ConsoleAPICalledParams;
    if (asString(params.type) !== "log") {
      return;
    }
    const ts = typeof params.timestamp === "number" ? params.timestamp : undefined;
    const event = parseLogEvent(params.args, sentinel, options.location, ts);
    if (event === undefined) {
      return;
    }
    emitted += 1;
    options.onEvent(event);
  });

  const cleanup = async (): Promise<void> => {
    offEvent();
    try {
      await removeBreakpoint(session, handle.breakpointId);
    } catch {
      // best-effort: tunnel may be gone
    }
  };

  try {
    const reason = await waitForStop(session, options);
    return { handle, sentinel, emitted, stoppedReason: reason };
  } finally {
    await cleanup();
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

export const internalsForTesting = {
  buildLogpointCondition,
  parseLogEvent,
  generateSentinel,
  SENTINEL_PREFIX,
};
