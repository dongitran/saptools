import { describe, expect, it } from "vitest";

import { findDetachedCandidates, parseDetachedCandidates, sortDetachedCandidates } from "../../src/detached.js";
import type { OpenSearchClient, SearchResponse } from "../../src/opensearch-client.js";
import type { DetachedCandidate } from "../../src/types.js";

import { makeSpan } from "./fixtures/spans.js";

function bucket(traceId: string, docCount: number, minStartIso: string, maxDuration: number, firstName: string): unknown {
  return {
    key: traceId,
    doc_count: docCount,
    min_start: { value_as_string: minStartIso },
    max_duration: { value: maxDuration },
    first_hit: { hits: { hits: [{ _source: { name: firstName } }] } },
  };
}

describe("parseDetachedCandidates", () => {
  it("excludes the reference traceId from its own candidate list", () => {
    const aggregations = {
      by_trace: {
        buckets: [
          bucket("reference-trace", 999, "2026-01-01T00:00:00Z", 999, "self"),
          bucket("other-1", 14, "2026-01-01T00:00:01Z", 571_000_000, "root"),
        ],
      },
    };
    const candidates = parseDetachedCandidates(aggregations, "reference-trace");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.traceId).toBe("other-1");
  });

  it("parses spanCount, minStart, maxDurationNanos, and firstSpanName correctly", () => {
    const aggregations = { by_trace: { buckets: [bucket("t1", 14, "2026-01-01T00:00:01Z", 571_000_000, "root-op")] } };
    const [candidate] = parseDetachedCandidates(aggregations, "reference");
    expect(candidate).toEqual({
      traceId: "t1",
      spanCount: 14,
      minStart: "2026-01-01T00:00:01Z",
      maxDurationNanos: 571_000_000,
      firstSpanName: "root-op",
    });
  });

  it("returns an empty list for a malformed or missing aggregation", () => {
    expect(parseDetachedCandidates(undefined, "x")).toEqual([]);
    expect(parseDetachedCandidates({}, "x")).toEqual([]);
    expect(parseDetachedCandidates({ by_trace: {} }, "x")).toEqual([]);
  });
});

describe("sortDetachedCandidates", () => {
  const candidates: readonly DetachedCandidate[] = [
    { traceId: "a", spanCount: 5, minStart: "", maxDurationNanos: 1000, firstSpanName: "" },
    { traceId: "b", spanCount: 20, minStart: "", maxDurationNanos: 500, firstSpanName: "" },
    { traceId: "c", spanCount: 10, minStart: "", maxDurationNanos: 2000, firstSpanName: "" },
  ];

  it("sorts by spanCount descending", () => {
    expect(sortDetachedCandidates(candidates, "spanCount").map((candidate) => candidate.traceId)).toEqual(["b", "c", "a"]);
  });

  it("sorts by duration descending", () => {
    expect(sortDetachedCandidates(candidates, "duration").map((candidate) => candidate.traceId)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...candidates];
    sortDetachedCandidates(candidates, "spanCount");
    expect(candidates).toEqual(copy);
  });
});

function aggResponse(buckets: readonly unknown[], totalHits = 0): SearchResponse {
  return { totalHits, hits: [], aggregations: { by_trace: { buckets } } };
}

function bucketRow(traceId: string, docCount: number): Record<string, unknown> {
  return {
    key: traceId,
    doc_count: docCount,
    min_start: { value_as_string: "2026-01-01T00:00:00Z" },
    max_duration: { value: 1000 },
    first_hit: { hits: { hits: [{ _source: { name: "root" } }] } },
  };
}

describe("findDetachedCandidates", () => {
  it("filters by the single root span's own serviceName, not a plurality vote across all spans", async () => {
    let capturedQuery: unknown;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedQuery = body["query"];
        return aggResponse([]);
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };
    // Root is service-a; the overwhelming majority of spans are service-c —
    // a plurality vote would wrongly pick service-c as the search target.
    const spans = [
      makeSpan({
        spanId: "root",
        name: "root",
        serviceName: "service-a",
        startTime: "2026-01-01T00:00:00.000000000Z",
        durationInNanos: 1_000_000_000,
      }),
      ...Array.from({ length: 5 }, (_unused, index) =>
        makeSpan({
          spanId: `child-${String(index)}`,
          parentSpanId: "root",
          name: "child",
          serviceName: "service-c",
          startTime: "2026-01-01T00:00:00.100000000Z",
          durationInNanos: 10_000_000,
        }),
      ),
    ];

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, {
      paddingSeconds: 0,
      limit: 10,
      sortBy: "spanCount",
    });

    expect(result.referenceServiceName).toBe("service-a");
    const query = capturedQuery as { bool: { filter: readonly unknown[] } };
    expect(query.bool.filter).toContainEqual({ term: { serviceName: "service-a" } });
  });

  it("falls back to a plurality vote when there is no single root (zero or many parentless spans)", async () => {
    const client: OpenSearchClient = { search: async () => aggResponse([]), count: async () => 0, getMapping: async () => ({}) };
    // Two roots (ambiguous) — falls back to whichever serviceName is most common overall.
    const spans = [
      makeSpan({ spanId: "root-1", name: "root-1", serviceName: "service-x", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 }),
      makeSpan({ spanId: "root-2", name: "root-2", serviceName: "service-y", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 }),
      makeSpan({ spanId: "child", parentSpanId: "root-2", name: "child", serviceName: "service-y", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 500 }),
    ];

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, {
      paddingSeconds: 0,
      limit: 10,
      sortBy: "spanCount",
    });

    expect(result.referenceServiceName).toBe("service-y");
  });

  it("treats --limit 0 as 'return every candidate', not zero rows", async () => {
    const buckets = Array.from({ length: 5 }, (_unused, index) => bucketRow(`trace-${String(index)}`, index + 1));
    const client: OpenSearchClient = { search: async () => aggResponse(buckets), count: async () => 0, getMapping: async () => ({}) };
    const spans = [makeSpan({ spanId: "root", name: "root", serviceName: "service-a", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 })];

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, {
      paddingSeconds: 0,
      limit: 0,
      sortBy: "spanCount",
    });

    expect(result.totalCandidateTraceCount).toBe(5);
    expect(result.candidates).toHaveLength(5);
  });

  it("still respects a real positive limit while reporting the true total candidate count", async () => {
    const buckets = Array.from({ length: 5 }, (_unused, index) => bucketRow(`trace-${String(index)}`, index + 1));
    const client: OpenSearchClient = { search: async () => aggResponse(buckets), count: async () => 0, getMapping: async () => ({}) };
    const spans = [makeSpan({ spanId: "root", name: "root", serviceName: "service-a", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 })];

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, {
      paddingSeconds: 0,
      limit: 2,
      sortBy: "spanCount",
    });

    expect(result.totalCandidateTraceCount).toBe(5);
    expect(result.candidates).toHaveLength(2);
  });

  it("returns an empty result without querying at all when the reference trace has no spans", async () => {
    let searchCalled = false;
    const client: OpenSearchClient = {
      search: async () => {
        searchCalled = true;
        return aggResponse([]);
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", [], {
      paddingSeconds: 0,
      limit: 10,
      sortBy: "spanCount",
    });

    expect(searchCalled).toBe(false);
    expect(result).toMatchObject({ referenceServiceName: "", candidates: [], totalCandidateTraceCount: 0, totalCandidateSpanCount: 0 });
  });

  it("orders the terms aggregation by the requested metric, not just re-sorting client-side", async () => {
    // Regression test: OpenSearch's terms `order` clause decides which
    // 10,000 buckets come back at all, not just their display order. Without
    // an explicit `order` matching sortBy, a long-but-low-span-count
    // candidate could be truncated away before the client ever sees it.
    let capturedTerms: unknown;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        const aggs = body["aggs"] as { by_trace: { terms: unknown } };
        capturedTerms = aggs.by_trace.terms;
        return aggResponse([]);
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };
    const spans = [makeSpan({ spanId: "root", name: "root", serviceName: "service-a", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 })];

    await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, { paddingSeconds: 0, limit: 10, sortBy: "duration" });
    expect(capturedTerms).toMatchObject({ order: { max_duration: "desc" } });

    await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, { paddingSeconds: 0, limit: 10, sortBy: "spanCount" });
    expect(capturedTerms).toMatchObject({ order: { _count: "desc" } });
  });

  it("reports the true total candidate span count (response.totalHits), distinct from the trace count", async () => {
    // The spec's own worked example headlines this distinction: "2,896
    // candidate spans found across 190 other traceIds" — spans, not traces.
    const buckets = [bucketRow("trace-a", 3), bucketRow("trace-b", 4)];
    const client: OpenSearchClient = { search: async () => aggResponse(buckets, 7), count: async () => 0, getMapping: async () => ({}) };
    const spans = [makeSpan({ spanId: "root", name: "root", serviceName: "service-a", startTime: "2026-01-01T00:00:00.000000000Z", durationInNanos: 1000 })];

    const result = await findDetachedCandidates(client, "otel-v1-apm-span-*", "ref-trace", spans, {
      paddingSeconds: 0,
      limit: 10,
      sortBy: "spanCount",
    });

    expect(result.totalCandidateTraceCount).toBe(2);
    expect(result.totalCandidateSpanCount).toBe(7);
  });
});
