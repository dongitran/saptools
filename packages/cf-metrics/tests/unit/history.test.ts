import { describe, expect, it, vi } from "vitest";

import { queryHistory, resolveMetricKind } from "../../src/history.js";
import type { OpenSearchClient, SearchResponse } from "../../src/opensearch-client.js";

function fakeClient(searchImpl: (index: string, body: Record<string, unknown>) => Promise<SearchResponse>): OpenSearchClient {
  return {
    search: vi.fn(searchImpl),
    count: vi.fn(async () => 0),
    getMapping: vi.fn(async () => ({})),
  };
}

describe("queryHistory", () => {
  it("shapes GAUGE buckets and reports no cumulative warning", async () => {
    const client = fakeClient(async (_index, body) => {
      expect(body["size"]).toBe(0);
      return {
        totalHits: 0,
        hits: [],
        aggregations: {
          over_time: {
            buckets: [
              { key_as_string: "t1", doc_count: 5, avg_value: { value: 1 }, min_value: { value: 0.5 }, max_value: { value: 2 } },
            ],
          },
        },
      };
    });

    const result = await queryHistory(client, {
      service: "app",
      name: "container.cpu.usage",
      since: "2h",
      interval: "10m",
      kind: "GAUGE",
    });

    expect(result.rows).toEqual([{ TIME: "t1", AVG: 1, MIN: 0.5, MAX: 2, DOC_COUNT: 5 }]);
    expect(result.cumulativeWarning).toBe(false);
  });

  it("fetches a sample doc for SUM kind and flags a cumulative-temporality warning", async () => {
    const client = fakeClient(async (_index, body) => {
      if (body["size"] === 1) {
        return { totalHits: 1, hits: [{ _id: "1", _source: { aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" } }] };
      }
      return { totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } };
    });

    const result = await queryHistory(client, {
      service: "app",
      name: "queue.incoming_messages",
      since: "2h",
      interval: "10m",
      kind: "SUM",
    });

    expect(result.cumulativeWarning).toBe(true);
  });

  it("does not warn for SUM kind when the sample reports delta temporality", async () => {
    const client = fakeClient(async (_index, body) => {
      if (body["size"] === 1) {
        return { totalHits: 1, hits: [{ _id: "1", _source: { aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA" } }] };
      }
      return { totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } };
    });

    const result = await queryHistory(client, {
      service: "app",
      name: "queue.incoming_messages",
      since: "2h",
      interval: "10m",
      kind: "SUM",
    });

    expect(result.cumulativeWarning).toBe(false);
  });

  it('builds the date_histogram aggregation on field "time" with the requested --interval as fixed_interval', async () => {
    let capturedBody: Record<string, unknown> = {};
    const client = fakeClient(async (_index, body) => {
      capturedBody = body;
      return { totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } };
    });

    await queryHistory(client, {
      service: "app",
      name: "container.cpu.usage",
      since: "2h",
      interval: "37m",
      kind: "GAUGE",
    });

    const aggs = capturedBody["aggs"] as { over_time: { date_histogram: { field: string; fixed_interval: string } } };
    expect(aggs.over_time.date_histogram).toEqual({ field: "time", fixed_interval: "37m" });
  });

  it("does not issue a second query for GAUGE or HISTOGRAM kinds, which never need the temporality check", async () => {
    const search = vi.fn(async () => ({ totalHits: 0, hits: [], aggregations: { over_time: { buckets: [] } } }));
    const client: OpenSearchClient = { search, count: vi.fn(async () => 0), getMapping: vi.fn(async () => ({})) };

    await queryHistory(client, { service: "app", name: "http.server.duration", since: "2h", interval: "10m", kind: "HISTOGRAM" });

    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMetricKind", () => {
  it("resolves the kind from a terms aggregation's top bucket, with no other kinds", async () => {
    const client = fakeClient(async () => ({
      totalHits: 0,
      hits: [],
      aggregations: { by_kind: { buckets: [{ key: "HISTOGRAM", doc_count: 30 }] } },
    }));

    await expect(resolveMetricKind(client, "app", "http.server.duration")).resolves.toEqual({
      kind: "HISTOGRAM",
      otherKinds: [],
    });
  });

  it("requests all 3 kind buckets, not just 1, so a second kind is visible instead of silently discarded", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client = fakeClient(async (_index, body) => {
      capturedBody = body;
      return { totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [{ key: "GAUGE", doc_count: 5 }] } } };
    });

    await resolveMetricKind(client, "app", "container.cpu.usage");

    const aggs = capturedBody["aggs"] as { by_kind: { terms: { size: number } } };
    expect(aggs.by_kind.terms.size).toBe(3);
  });

  it("surfaces every other kind found for the name as otherKinds — a data anomaly, not the expected multi-unit case", async () => {
    // A metric name reporting more than one kind (e.g. an instrumentation
    // change mid-rollout) used to vanish silently: `size: 1` meant the
    // second kind's documents were never even visible in the response.
    const client = fakeClient(async () => ({
      totalHits: 0,
      hits: [],
      aggregations: {
        by_kind: { buckets: [{ key: "HISTOGRAM", doc_count: 30 }, { key: "GAUGE", doc_count: 4 }] },
      },
    }));

    await expect(resolveMetricKind(client, "app", "http.server.duration")).resolves.toEqual({
      kind: "HISTOGRAM",
      otherKinds: ["GAUGE"],
    });
  });

  it("throws a clear error when no documents match the metric name", async () => {
    const client = fakeClient(async () => ({ totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [] } } }));

    await expect(resolveMetricKind(client, "app", "nonexistent")).rejects.toThrow(/Could not resolve a kind/);
  });

  it("resolves the kind with no --service filter when service is undefined, for cross-app callers like top", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client = fakeClient(async (_index, body) => {
      capturedBody = body;
      return { totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [{ key: "GAUGE", doc_count: 5 }] } } };
    });

    await expect(resolveMetricKind(client, undefined, "container.cpu.usage")).resolves.toEqual({
      kind: "GAUGE",
      otherKinds: [],
    });
    const query = capturedBody["query"] as { bool?: { filter: Record<string, unknown>[] } };
    expect(query.bool?.filter.some((clause) => "term" in clause) ?? false).toBe(false);
  });

  it("omits the service clause from its not-found error message when service is undefined", async () => {
    const client = fakeClient(async () => ({ totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [] } } }));

    await expect(resolveMetricKind(client, undefined, "nonexistent")).rejects.toThrow(
      'Could not resolve a kind for metric "nonexistent" — no matching documents found',
    );
  });
});
