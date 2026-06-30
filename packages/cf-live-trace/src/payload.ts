import { truncatePreview } from "./preview.js";
import type { DrainParseResult, LiveTraceEvent } from "./types.js";

export interface DrainParseOptions {
  readonly appId: string;
  readonly maxBodyBytes: number;
}

let fallbackEventId = 0;

export function parseDrainResult(payload: unknown, options: DrainParseOptions): DrainParseResult {
  if (!isRecord(payload)) {
    return { drainId: null, events: [], droppedCount: 0, queueSize: 0 };
  }
  const rawEvents = Array.isArray(payload["events"]) ? payload["events"] : [];
  return {
    drainId: readDrainId(payload["drainId"]),
    events: rawEvents
      .map((event) => parseRuntimeEvent(event, options))
      .filter((event): event is LiveTraceEvent => event !== null),
    droppedCount: readNonNegativeNumber(payload["droppedCount"]),
    queueSize: readNonNegativeNumber(payload["queueSize"]),
  };
}

function readDrainId(value: unknown): string | null {
  return typeof value === "string" && /^d\d+$/.test(value) ? value : null;
}

function parseRuntimeEvent(payload: unknown, options: DrainParseOptions): LiveTraceEvent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const rawUrl = readString(payload["url"]) ?? readString(payload["normalizedUrl"]) ?? readString(payload["path"]);
  if (rawUrl === null) {
    return null;
  }
  const requestBody = limitBodyPreview(readString(payload["requestBodyPreview"]) ?? "", options.maxBodyBytes);
  const responseBody = limitBodyPreview(readString(payload["responseBodyPreview"]) ?? "", options.maxBodyBytes);
  return buildEvent(payload, rawUrl, requestBody, responseBody, options);
}

function buildEvent(
  payload: Record<string, unknown>,
  rawUrl: string,
  requestBody: { readonly preview: string; readonly truncated: boolean },
  responseBody: { readonly preview: string; readonly truncated: boolean },
  options: DrainParseOptions,
): LiveTraceEvent {
  return {
    id: readString(payload["id"]) ?? nextFallbackEventId(),
    timestamp: readString(payload["timestamp"]) ?? new Date().toISOString(),
    appId: options.appId,
    instance: readString(payload["instance"]) ?? "0",
    method: (readString(payload["method"]) ?? "GET").toUpperCase(),
    path: readString(payload["path"]) ?? normalizePath(rawUrl),
    url: rawUrl,
    normalizedUrl: readString(payload["normalizedUrl"]) ?? normalizePath(rawUrl),
    status: readNullableNumber(payload["status"]),
    durationMs: readNullableNumber(payload["durationMs"]),
    requestBytes: readNonNegativeNumber(payload["requestBytes"]),
    responseBytes: readNonNegativeNumber(payload["responseBytes"]),
    requestHeaders: readHeaders(payload["requestHeaders"]),
    responseHeaders: readHeaders(payload["responseHeaders"]),
    requestBodyPreview: requestBody.preview,
    responseBodyPreview: responseBody.preview,
    requestBodyTruncated: payload["requestBodyTruncated"] === true || requestBody.truncated,
    responseBodyTruncated: payload["responseBodyTruncated"] === true || responseBody.truncated,
    droppedBeforeEvent: readNonNegativeNumber(payload["droppedBeforeEvent"]),
    source: "runtime-http",
    traceId: readString(payload["traceId"]) ?? readString(payload["id"]) ?? "",
    correlationId: readString(payload["correlationId"]),
  };
}

function readHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const header = readHeaderValue(rawValue);
    if (header !== null) {
      headers[key] = header;
    }
  }
  return headers;
}

function readHeaderValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }
  return null;
}

function limitBodyPreview(preview: string, maxChars: number): { readonly preview: string; readonly truncated: boolean } {
  return truncatePreview(preview, maxChars);
}

function normalizePath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://saptools.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nextFallbackEventId(): string {
  fallbackEventId += 1;
  return `runtime-${String(fallbackEventId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
