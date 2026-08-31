import { describe, expect, it, vi } from "vitest";

import { CfMetricsError } from "../../src/errors.js";
import type { OpenSearchClient, SearchResponse } from "../../src/opensearch-client.js";
import { queryTop, resolveTopMetricKind } from "../../src/top.js";

describe("queryTop", () => {
  it("ranks apps by avg value descending, with an explicit sub-agg order (not the terms default of _count)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return {
          totalHits: 0,
          hits: [],
          aggregations: {
            by_app: {
              buckets: [
                { key: "app-a", doc_count: 101, avg_value: { value: 1_515_297_264.6 }, max_value: { value: 1_515_399_312 } },
                { key: "app-b", doc_count: 105, avg_value: { value: 280_046_513.5 }, max_value: { value: 280_100_019 } },
              ],
            },
          },
        };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryTop(client, { name: "container.memory.usage", since: "30m", limit: 5 });

    expect(rows).toEqual([
      { APP: "app-a", AVG: 1_515_297_264.6, MAX: 1_515_399_312, DOC_COUNT: 101 },
      { APP: "app-b", AVG: 280_046_513.5, MAX: 280_100_019, DOC_COUNT: 105 },
    ]);
    const aggs = capturedBody["aggs"] as { by_app: { terms: { order: unknown; field: string } } };
    expect(aggs.by_app.terms.order).toEqual({ avg_value: "desc" });
    expect(aggs.by_app.terms.field).toBe("resource.attributes.sap@cf@app_name");
  });

  it("requests every app (terms size 10000) when --limit is 0", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return { totalHits: 0, hits: [], aggregations: { by_app: { buckets: [] } } };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await queryTop(client, { name: "container.cpu.usage", limit: 0 });

    const aggs = capturedBody["aggs"] as { by_app: { terms: { size: number } } };
    expect(aggs.by_app.terms.size).toBe(10_000);
  });

  it("does not filter by service — ranking is cross-app by design", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return { totalHits: 0, hits: [], aggregations: { by_app: { buckets: [] } } };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await queryTop(client, { name: "container.cpu.usage", limit: 10 });

    const query = capturedBody["query"] as { bool: { filter: Record<string, unknown>[] } };
    expect(query.bool.filter.some((clause) => "term" in clause)).toBe(false);
  });

  it("ranks a HISTOGRAM metric by derived avg (sum/count) instead of a null avg/max on a nonexistent value field", async () => {
    // Real HISTOGRAM documents (e.g. http.server.duration) carry no `value`
    // field at all — confirmed live against the real backend, where the
    // pre-fix avg/max-on-value query returned null for every app and a
    // meaningless (effectively alphabetical) bucket order.
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return {
          totalHits: 0,
          hits: [],
          aggregations: {
            by_app: {
              buckets: [
                // Deliberately NOT pre-sorted by avg — proves the client-side sort, not just data ordering.
                { key: "fast-app", doc_count: 40, sum_count: { value: 40 }, sum_sum: { value: 4 } }, // avg 0.1
                { key: "slow-app", doc_count: 10, sum_count: { value: 10 }, sum_sum: { value: 100 } }, // avg 10
                { key: "silent-app", doc_count: 5, sum_count: { value: 0 }, sum_sum: { value: 0 } }, // avg null
              ],
            },
          },
        };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryTop(client, { name: "http.server.duration", limit: 10, kind: "HISTOGRAM" });

    expect(rows).toEqual([
      { APP: "slow-app", AVG: 10, DOC_COUNT: 10 },
      { APP: "fast-app", AVG: 0.1, DOC_COUNT: 40 },
      { APP: "silent-app", AVG: null, DOC_COUNT: 5 },
    ]);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("MAX");
    }
    // No scriptable server-side order is used for the ratio — every app is
    // fetched (bounded at the "effectively all" ceiling) and sorted client-side.
    const aggs = capturedBody["aggs"] as { by_app: { terms: { size: number; order?: unknown } } };
    expect(aggs.by_app.terms.size).toBe(10_000);
    expect(aggs.by_app.terms.order).toBeUndefined();
  });

  it("returns every ranked app for a HISTOGRAM metric when --limit is 0, rather than slicing to nothing", async () => {
    // `top.ts`'s HISTOGRAM branch slices client-side (`ranked.slice(0, limit)`),
    // so the `limit === 0` guard is the only thing standing between "no limit"
    // and `slice(0, 0)` — an empty table. The GAUGE/SUM path cannot regress the
    // same way, since it bounds server-side via the terms `size`.
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_app: {
            buckets: [
              { key: "a", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 1 } },
              { key: "b", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 2 } },
              { key: "c", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 3 } },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryTop(client, { name: "http.server.duration", limit: 0, kind: "HISTOGRAM" });

    expect(rows).toEqual([
      { APP: "c", AVG: 3, DOC_COUNT: 1 },
      { APP: "b", AVG: 2, DOC_COUNT: 1 },
      { APP: "a", AVG: 1, DOC_COUNT: 1 },
    ]);
  });

  it("slices the client-side-sorted HISTOGRAM ranking to the requested --limit", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_app: {
            buckets: [
              { key: "a", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 1 } },
              { key: "b", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 2 } },
              { key: "c", doc_count: 1, sum_count: { value: 1 }, sum_sum: { value: 3 } },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryTop(client, { name: "http.server.duration", limit: 1, kind: "HISTOGRAM" });

    expect(rows).toEqual([{ APP: "c", AVG: 3, DOC_COUNT: 1 }]);
  });
});

describe("resolveTopMetricKind", () => {
  function fakeClient(searchImpl: (index: string, body: Record<string, unknown>) => Promise<SearchResponse>): OpenSearchClient {
    return { search: vi.fn(searchImpl), count: vi.fn(async () => 0), getMapping: vi.fn(async () => ({})) };
  }

  it("resolves the kind without a --service filter, cross-app", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client = fakeClient(async (_index, body) => {
      capturedBody = body;
      return { totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [{ key: "HISTOGRAM", doc_count: 12 }] } } };
    });

    await expect(resolveTopMetricKind(client, "http.server.duration")).resolves.toBe("HISTOGRAM");
    const query = capturedBody["query"] as { bool?: { filter: Record<string, unknown>[] } };
    // buildMetricBoolQuery always wraps its filters in `{bool: {filter: [...]}}`
    // once at least one is present (here, the `terms: {name: [...]}` clause) —
    // this just confirms that array holds no `term` (service) clause.
    expect(query.bool?.filter.some((clause) => "term" in clause) ?? false).toBe(false);
  });

  it("degrades to undefined (not a thrown error) when no documents match the name at all", async () => {
    const client = fakeClient(async () => ({ totalHits: 0, hits: [], aggregations: { by_kind: { buckets: [] } } }));

    await expect(resolveTopMetricKind(client, "totally.bogus.metric")).resolves.toBeUndefined();
  });

  it("re-throws a non-METRIC_NOT_FOUND error instead of swallowing it", async () => {
    const client = fakeClient(async () => {
      throw new CfMetricsError("OPENSEARCH_REQUEST_FAILED", "boom");
    });

    await expect(resolveTopMetricKind(client, "container.cpu.usage")).rejects.toThrow("boom");
  });
});
