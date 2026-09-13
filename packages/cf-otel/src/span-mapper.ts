import type { SearchHit } from "@saptools/core";

import type { Span } from "./types.js";

/**
 * `spanId`, not `_id`: OpenSearch documents `_id` as restricted from sorting
 * without fielddata; `spanId` is a mandatory OpenTelemetry field, mapped as a
 * plain sortable `keyword` in Data Prepper's own index template. Moved here
 * from the now-deleted local `opensearch-client.ts` — the shared
 * `packages/core` client's `searchAfterAll` takes the tiebreaker as an
 * explicit parameter instead of hardcoding one (cf-metrics's heterogeneous
 * metric domain has no universal tiebreaker, so the shared helper cannot
 * hardcode cf-otel's).
 */
export const SPANS_SORT_TIEBREAKER = [{ startTime: "asc" }, { spanId: "asc" }] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(source: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

function readStatusCode(source: Readonly<Record<string, unknown>>): number | undefined {
  const status = source["status"];
  return isRecord(status) && typeof status["code"] === "number" ? status["code"] : undefined;
}

/** Map one raw OpenSearch hit to the shaped {@link Span} every command works with. */
export function hitToSpan(hit: SearchHit): Span {
  const source = hit._source;
  const traceId = readString(source, "traceId");
  const spanId = readString(source, "spanId");
  if (traceId === undefined || spanId === undefined) {
    throw new Error(`Span document ${hit._id} is missing traceId/spanId`);
  }
  const parentSpanId = readString(source, "parentSpanId");
  const statusCode = readStatusCode(source);
  return {
    traceId,
    spanId,
    name: readString(source, "name") ?? "",
    kind: readString(source, "kind") ?? "",
    serviceName: readString(source, "serviceName") ?? "",
    startTime: readString(source, "startTime") ?? "",
    durationInNanos: readNumber(source, "durationInNanos") ?? 0,
    ...(parentSpanId !== undefined && parentSpanId.length > 0 ? { parentSpanId } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    raw: source,
  };
}
