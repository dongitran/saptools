import {
  DEFAULT_STREAM_MAX_VALUE_LENGTH,
  limitValueLength,
  textTruncationFields,
} from "../snapshot/values.js";
import type { BreakpointLocation, InspectorIsolate } from "../types.js";

export interface LogpointEvent {
  readonly ts: string;
  readonly at: string;
  readonly value?: string;
  readonly error?: string;
  readonly raw?: string;
  readonly truncated?: true;
  readonly originalLength?: number;
  readonly isolate?: InspectorIsolate;
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
  maxValueLength = DEFAULT_STREAM_MAX_VALUE_LENGTH,
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
    const limited = limitValueLength(payload.slice("!err:".length), maxValueLength);
    return {
      ts,
      at,
      error: limited.text,
      ...textTruncationFields(limited),
    };
  }
  return parsePayload(ts, at, payload, maxValueLength);
}

function parsePayload(
  ts: string,
  at: string,
  payload: string,
  maxValueLength: number,
): LogpointEvent {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "string") {
      return buildValueEvent(ts, at, parsed, maxValueLength);
    }
    return buildValueEvent(ts, at, JSON.stringify(parsed), maxValueLength);
  } catch {
    return buildValueEvent(ts, at, payload, maxValueLength, true);
  }
}

function buildValueEvent(
  ts: string,
  at: string,
  value: string,
  maxValueLength: number,
  includeRaw = false,
): LogpointEvent {
  const limited = limitValueLength(value, maxValueLength);
  return {
    ts,
    at,
    value: limited.text,
    ...(includeRaw ? { raw: limited.text } : {}),
    ...textTruncationFields(limited),
  };
}
