import type { BreakpointLocation } from "../types.js";

export interface LogpointEvent {
  readonly ts: string;
  readonly at: string;
  readonly value?: string;
  readonly error?: string;
  readonly raw?: string;
}

interface CdpRemoteObject {
  type?: unknown;
  value?: unknown;
}

export interface ConsoleAPICalledParams {
  type?: unknown;
  args?: unknown;
  timestamp?: unknown;
}

export function asString(value: unknown): string | undefined {
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
  return index === 0 ? undefined : "";
}

export function parseLogEvent(
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
  return parsePayload(ts, at, payload);
}

function parsePayload(ts: string, at: string, payload: string): LogpointEvent {
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
