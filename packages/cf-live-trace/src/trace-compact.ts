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
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "auth",
  "authorization",
  "client_secret",
  "oauth_code",
  "passwd",
  "password",
  "refresh_token",
  "sig",
  "signature",
  "token",
].map(normalizeQueryKey));

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
    url: redactSensitiveQueryValues(event.url),
    normalizedUrl: redactSensitiveQueryValues(event.normalizedUrl),
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
  let preview = "";
  let length = 0;
  for (const character of body) {
    if (length < COMPACT_BODY_PREVIEW_CHARS) {
      preview += character;
    }
    length += 1;
  }
  return {
    preview,
    remainingChars: Math.max(0, length - COMPACT_BODY_PREVIEW_CHARS),
  };
}

function redactSensitiveQueryValues(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex < 0) {
    return rawUrl;
  }
  const fragmentIndex = rawUrl.indexOf("#", queryIndex);
  const queryEnd = fragmentIndex < 0 ? rawUrl.length : fragmentIndex;
  const query = rawUrl.slice(queryIndex + 1, queryEnd);
  const redacted = query.split("&").map(redactQueryPart).join("&");
  return `${rawUrl.slice(0, queryIndex + 1)}${redacted}${rawUrl.slice(queryEnd)}`;
}

function redactQueryPart(part: string): string {
  const separatorIndex = part.indexOf("=");
  const rawKey = separatorIndex < 0 ? part : part.slice(0, separatorIndex);
  if (!SENSITIVE_QUERY_KEYS.has(normalizeQueryKey(rawKey))) {
    return part;
  }
  return `${rawKey}=redacted`;
}

function normalizeQueryKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey).toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  } catch {
    return rawKey.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  }
}
