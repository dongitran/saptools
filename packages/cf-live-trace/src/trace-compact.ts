import type { StoredTraceEvent } from "./trace-store.js";

export type TraceBodyFormat = "empty" | "json" | "xml" | "html" | "form" | "text" | "binary" | "unknown";

export interface CompactTraceEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly instance: string;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly requestBodyFormat: TraceBodyFormat;
  readonly responseBodyFormat: TraceBodyFormat;
  readonly requestBodyPreview: string;
  readonly requestBodyPreviewRemainingChars: number;
  readonly responseBodyPreview: string;
  readonly responseBodyPreviewRemainingChars: number;
  readonly requestBodyTruncated: boolean;
  readonly responseBodyTruncated: boolean;
  readonly droppedBeforeEvent: number;
  readonly source: "runtime-http";
  readonly traceId: string;
  readonly correlationId: string | null;
}

const COMPACT_BODY_PREVIEW_CHARS = 128;

export function detectBodyFormat(body: string, headers: Record<string, string>): TraceBodyFormat {
  if (body.length === 0) {
    return "empty";
  }
  const contentType = headerValue(headers, "content-type").toLowerCase();
  if (contentType.includes("json")) {
    return "json";
  }
  if (contentType.includes("html")) {
    return "html";
  }
  if (contentType.includes("xml")) {
    return "xml";
  }
  if (contentType.includes("x-www-form-urlencoded")) {
    return "form";
  }
  if (contentType.includes("octet-stream")) {
    return "binary";
  }
  return detectBodyFormatFromText(body, contentType);
}

export function compactTraceEvent(record: StoredTraceEvent): CompactTraceEvent {
  const event = record.event;
  const requestBody = compactBody(event.requestBodyPreview);
  const responseBody = compactBody(event.responseBodyPreview);
  return {
    id: event.id,
    sessionId: record.sessionId,
    requestId: record.requestId,
    timestamp: event.timestamp,
    instance: event.instance,
    method: event.method,
    path: event.path,
    url: event.url,
    normalizedUrl: event.normalizedUrl,
    status: event.status,
    durationMs: event.durationMs,
    requestBytes: event.requestBytes,
    responseBytes: event.responseBytes,
    requestBodyFormat: record.requestBodyFormat,
    responseBodyFormat: record.responseBodyFormat,
    requestBodyPreview: requestBody.preview,
    requestBodyPreviewRemainingChars: requestBody.remainingChars,
    responseBodyPreview: responseBody.preview,
    responseBodyPreviewRemainingChars: responseBody.remainingChars,
    requestBodyTruncated: event.requestBodyTruncated,
    responseBodyTruncated: event.responseBodyTruncated,
    droppedBeforeEvent: event.droppedBeforeEvent,
    source: event.source,
    traceId: event.traceId,
    correlationId: event.correlationId,
  };
}

function headerValue(headers: Record<string, string>, name: string): string {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return "";
}

function detectBodyFormatFromText(body: string, contentType: string): TraceBodyFormat {
  const trimmed = body.trim();
  if (isJsonText(trimmed)) {
    return "json";
  }
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html(?:\s|>)/i.test(trimmed)) {
    return "html";
  }
  if (/^<\?xml(?:\s|>)/i.test(trimmed) || /^<[A-Za-z_][\w:.-]*(?:\s|>|\/>)/.test(trimmed)) {
    return "xml";
  }
  if (contentType.startsWith("text/")) {
    return "text";
  }
  if (hasBinaryControlChars(body)) {
    return "binary";
  }
  return "text";
}

function isJsonText(text: string): boolean {
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(text) as unknown;
    return true;
  } catch {
    return false;
  }
}

function hasBinaryControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      return true;
    }
  }
  return false;
}

function compactBody(body: string): { readonly preview: string; readonly remainingChars: number } {
  if (body.length <= COMPACT_BODY_PREVIEW_CHARS) {
    return { preview: body, remainingChars: 0 };
  }
  return {
    preview: body.slice(0, COMPACT_BODY_PREVIEW_CHARS),
    remainingChars: body.length - COMPACT_BODY_PREVIEW_CHARS,
  };
}
