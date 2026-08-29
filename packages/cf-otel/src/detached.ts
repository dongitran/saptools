import type { OpenSearchClient } from "./opensearch-client.js";
import { toEpochNanos } from "./timestamps.js";
import type { DetachedCandidate, DetachedResult, Span } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A plain `Array.isArray(x)` check on an `unknown` narrows to `any[]` per
// TypeScript's lib types, which then propagates `any` into anything
// destructured from it; this wrapper keeps the narrowed type honestly `unknown[]`.
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function mostCommonServiceName(spans: readonly Span[]): string {
  const counts = new Map<string, number>();
  for (const span of spans) {
    counts.set(span.serviceName, (counts.get(span.serviceName) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best ?? "";
}

/** The root span's own serviceName when there's exactly one root; falls back to a plurality vote across all spans when there's ambiguity (0 or many roots), mirroring the 0/1/many root-handling used elsewhere. */
function referenceServiceName(spans: readonly Span[]): string {
  const roots = spans.filter((span) => span.parentSpanId === undefined);
  if (roots.length === 1) {
    const [only] = roots;
    if (only !== undefined) {
      return only.serviceName;
    }
  }
  return mostCommonServiceName(spans);
}

interface Window {
  readonly startNanos: bigint;
  readonly endNanos: bigint;
}

function computeWindow(spans: readonly Span[]): Window | undefined {
  let start: bigint | undefined;
  let end: bigint | undefined;
  for (const span of spans) {
    const spanStart = toEpochNanos(span.startTime);
    const spanEnd = spanStart + BigInt(span.durationInNanos);
    if (start === undefined || spanStart < start) {
      start = spanStart;
    }
    if (end === undefined || spanEnd > end) {
      end = spanEnd;
    }
  }
  return start === undefined || end === undefined ? undefined : { startNanos: start, endNanos: end };
}

function nanosToIso(nanos: bigint): string {
  const clamped = nanos < 0n ? 0n : nanos;
  return new Date(Number(clamped / 1_000_000n)).toISOString();
}

function extractFirstHitName(firstHitAgg: unknown): string {
  if (!isRecord(firstHitAgg)) {
    return "";
  }
  const hitsBlock = firstHitAgg["hits"];
  if (!isRecord(hitsBlock)) {
    return "";
  }
  const hitsArray = hitsBlock["hits"];
  if (!isUnknownArray(hitsArray)) {
    return "";
  }
  const [hit] = hitsArray;
  if (!isRecord(hit)) {
    return "";
  }
  const source = hit["_source"];
  const name = isRecord(source) ? source["name"] : undefined;
  return typeof name === "string" ? name : "";
}

function parseMinStart(minStartAgg: unknown): string {
  if (!isRecord(minStartAgg)) {
    return "";
  }
  if (typeof minStartAgg["value_as_string"] === "string") {
    return minStartAgg["value_as_string"];
  }
  return typeof minStartAgg["value"] === "number" ? new Date(minStartAgg["value"]).toISOString() : "";
}

/**
 * Parse the `by_trace` terms-aggregation response into candidate rows,
 * excluding the reference trace itself (defense in depth: the query already
 * filters it out server-side, but this keeps that guarantee independently
 * testable without mocking a full search response).
 */
export function parseDetachedCandidates(
  aggregations: unknown,
  referenceTraceId: string,
): readonly DetachedCandidate[] {
  if (!isRecord(aggregations)) {
    return [];
  }
  const byTrace = aggregations["by_trace"];
  if (!isRecord(byTrace) || !Array.isArray(byTrace["buckets"])) {
    return [];
  }
  const candidates: DetachedCandidate[] = [];
  for (const bucket of byTrace["buckets"]) {
    if (!isRecord(bucket)) {
      continue;
    }
    const traceId = bucket["key"];
    const docCount = bucket["doc_count"];
    if (typeof traceId !== "string" || typeof docCount !== "number" || traceId === referenceTraceId) {
      continue;
    }
    const maxDurationAgg = bucket["max_duration"];
    const maxDurationNanos = isRecord(maxDurationAgg) && typeof maxDurationAgg["value"] === "number"
      ? maxDurationAgg["value"]
      : 0;
    candidates.push({
      traceId,
      spanCount: docCount,
      minStart: parseMinStart(bucket["min_start"]),
      maxDurationNanos,
      firstSpanName: extractFirstHitName(bucket["first_hit"]),
    });
  }
  return candidates;
}

export function sortDetachedCandidates(
  candidates: readonly DetachedCandidate[],
  sortBy: "spanCount" | "duration",
): DetachedCandidate[] {
  return [...candidates].sort((a, b) =>
    sortBy === "duration" ? b.maxDurationNanos - a.maxDurationNanos : b.spanCount - a.spanCount,
  );
}

export interface DetachedOptions {
  readonly paddingSeconds: number;
  readonly limit: number;
  readonly sortBy: "spanCount" | "duration";
}

/**
 * Find likely detached/orphaned trace continuations: other traces whose
 * spans land in the same service and time window as a reference trace,
 * excluding the reference trace itself. Use this when a trace's self-time is
 * unexplained by any of its own child spans (see `selftime`/`gaps`) — a
 * server-instrumentation framework can spawn background work in a new,
 * uninstrumented context that gets its own fresh traceId instead of
 * propagating the parent's.
 */
export async function findDetachedCandidates(
  client: OpenSearchClient,
  index: string,
  referenceTraceId: string,
  referenceSpans: readonly Span[],
  options: DetachedOptions,
): Promise<DetachedResult> {
  const serviceName = referenceServiceName(referenceSpans);
  const window = computeWindow(referenceSpans);
  if (window === undefined) {
    return {
      referenceServiceName: serviceName,
      windowStart: "",
      windowEnd: "",
      candidates: [],
      totalCandidateTraceCount: 0,
      totalCandidateSpanCount: 0,
    };
  }
  const paddingNanos = BigInt(options.paddingSeconds) * 1_000_000_000n;
  const windowStart = nanosToIso(window.startNanos - paddingNanos);
  const windowEnd = nanosToIso(window.endNanos + paddingNanos);

  const response = await client.search(index, {
    size: 0,
    query: {
      bool: {
        filter: [{ term: { serviceName } }, { range: { startTime: { gte: windowStart, lte: windowEnd } } }],
        must_not: [{ term: { traceId: referenceTraceId } }],
      },
    },
    aggs: {
      by_trace: {
        terms: { field: "traceId", size: 10_000 },
        aggs: {
          min_start: { min: { field: "startTime" } },
          max_duration: { max: { field: "durationInNanos" } },
          first_hit: { top_hits: { size: 1, sort: [{ startTime: "asc" }] } },
        },
      },
    },
  });

  const candidates = sortDetachedCandidates(
    parseDetachedCandidates(response.aggregations, referenceTraceId),
    options.sortBy,
  );
  return {
    referenceServiceName: serviceName,
    windowStart,
    windowEnd,
    // A limit of 0 means "all" (documented in --help and the worked example),
    // not zero rows — Array.slice(0, 0) would otherwise silently empty the list.
    candidates: options.limit === 0 ? candidates : candidates.slice(0, options.limit),
    totalCandidateTraceCount: candidates.length,
    // response.totalHits is the true count of candidate SPANS across every
    // trace found (before the by-trace terms aggregation groups them) — the
    // spec's own worked example headlines this ("2,896 candidate spans found
    // across 190 other traceIds"), distinct from totalCandidateTraceCount.
    totalCandidateSpanCount: response.totalHits,
  };
}
