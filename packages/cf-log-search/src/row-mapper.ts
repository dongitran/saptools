import type { LogRow, RawLogSource } from "./types.js";

function readString(source: RawLogSource, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readOptionalString(source: RawLogSource, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(source: RawLogSource, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

function isRtr(source: RawLogSource): boolean {
  return readString(source, "source_type") === "RTR";
}

/**
 * The genuine OTel trace id, or `undefined`.
 *
 * Verified live 2026-09-12 against `logs-cfsyslog-*`: on an RTR (router
 * access log) document, the top-level `trace_id` field mirrors
 * `w3c_trace-id` — the real W3C traceparent trace id, matching
 * `otel-v1-apm-span-*` spans' own `traceId` field exactly, in every RTR
 * sample checked (a 5-doc live re-sample on 2026-09-13 agreed 5/5).
 *
 * On every other `source_type`, the same field name is **unreliable, not
 * consistently wrong in one way** — a live 100-document sample of APP-log
 * rows on 2026-09-13 found 58 where `trace_id` was a de-hyphenated
 * `correlation_id` (confirmed byte-for-byte, e.g. `correlation_id`
 * "cafecafe-babe-4bad-8bad-deadbeefcafe" -> `trace_id`
 * "cafecafebabe4bad8baddeadbeefcafe"), but 42 where it was a genuinely
 * different, real, independently-propagated OTel trace id instead —
 * confirmed by finding an APP-log row whose `trace_id` exactly matched a
 * sibling RTR row's own (real) `trace_id` for a request sharing the same
 * `correlation_id`. There is no field on the document itself that reliably
 * distinguishes which of the two a given non-RTR row is in. That is exactly
 * why this function refuses to return anything but `undefined` off a
 * non-RTR row: a value that is only sometimes real is not a safe one to
 * expose as a trace id under any circumstance, and APP-log documents are the
 * majority of volume.
 */
export function resolveTraceId(source: RawLogSource): string | undefined {
  if (!isRtr(source)) {
    return undefined;
  }
  return readOptionalString(source, "trace_id");
}

/** Mirrors {@link resolveTraceId}'s RTR-only gate — `span_id` has no defined meaning on a non-RTR document either. */
export function resolveSpanId(source: RawLogSource): string | undefined {
  if (!isRtr(source)) {
    return undefined;
  }
  return readOptionalString(source, "span_id");
}

/** Strips trailing zeros from a decimal string's fractional part, but always keeps at least one digit after the point — "17.000" -> "17.0", "17.500" -> "17.5", "17.0" stays "17.0". */
function trimTrailingZeros(value: string): string {
  const trimmed = value.replace(/(\.\d*?)0+$/, "$1");
  return trimmed.endsWith(".") ? `${trimmed}0` : trimmed;
}

function formatLatencyMs(latencyMs: number | undefined): string {
  if (latencyMs === undefined) {
    return "";
  }
  return ` (${trimTrailingZeros(latencyMs.toFixed(1))}ms)`;
}

/** RTR documents carry no `msg` field (verified live — they are already fully decomposed into method/request/response_status/etc.), so this synthesizes an equivalent one-line summary for display. */
function synthesizeRtrMessage(method: string, path: string, status: number | undefined, latencyMs: number | undefined): string {
  const statusText = status === undefined ? "?" : String(status);
  return `${method} ${path} -> ${statusText}${formatLatencyMs(latencyMs)}`;
}

export function mapHitToLogRow(hit: { readonly id: string; readonly source: RawLogSource }): LogRow {
  const source = hit.source;
  const rtr = isRtr(source);
  const method = rtr ? readString(source, "method") : "";
  const path = rtr ? readString(source, "request") : "";
  const responseStatus = rtr ? readNumber(source, "response_status") : undefined;
  const responseTimeMs = rtr ? readNumber(source, "response_time_ms") : undefined;

  return {
    id: hit.id,
    timestamp: readString(source, "@timestamp"),
    sourceType: readString(source, "source_type"),
    appName: readString(source, "app_name"),
    appId: readString(source, "app_id"),
    spaceName: readString(source, "space_name"),
    orgName: readString(source, "organization_name"),
    level: readString(source, "level"),
    logger: readString(source, "logger"),
    message: rtr ? synthesizeRtrMessage(method, path, responseStatus, responseTimeMs) : readString(source, "msg"),
    correlationId: readString(source, "correlation_id"),
    vcapRequestId: readString(source, "vcap_request_id"),
    traceId: resolveTraceId(source) ?? "",
    spanId: resolveSpanId(source) ?? "",
    method,
    path,
    responseStatus,
    responseTimeMs,
  };
}
