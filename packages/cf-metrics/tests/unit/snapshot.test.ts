import { describe, expect, it, vi } from "vitest";

import type { OpenSearchClient } from "../../src/opensearch-client.js";
import { querySnapshot } from "../../src/snapshot.js";

describe("querySnapshot", () => {
  it("reads the latest top_hits document per metric name", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              {
                key: "container.cpu.usage",
                latest: { hits: { hits: [{ _source: { kind: "GAUGE", value: 0.0154, unit: "1", time: "t1" } }] } },
              },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await querySnapshot(client, { service: "app", limit: 50 });

    expect(rows).toEqual([{ NAME: "container.cpu.usage", KIND: "GAUGE", VALUE: 0.0154, UNIT: "1", TIME: "t1" }]);
  });

  it("falls back to the sum field for a histogram's latest point, which has no top-level value", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              {
                key: "http.server.duration",
                latest: { hits: { hits: [{ _source: { kind: "HISTOGRAM", sum: 1.9167, unit: "ms", time: "t1" } }] } },
              },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await querySnapshot(client, { service: "app", limit: 50 });

    expect(rows[0]).toEqual({ NAME: "http.server.duration", KIND: "HISTOGRAM", VALUE: 1.9167, UNIT: "ms", TIME: "t1" });
  });

  it("reports a null VALUE when a bucket's latest hit is missing", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_name: { buckets: [{ key: "orphan", latest: { hits: { hits: [] } } }] } },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await querySnapshot(client, { service: "app", limit: 50 });

    expect(rows[0]).toEqual({ NAME: "orphan", KIND: "", VALUE: null, UNIT: "", TIME: "" });
  });

  function clientReturning(names: readonly string[], droppedDocs = 0): OpenSearchClient {
    return {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return {
          totalHits: 0,
          hits: [],
          aggregations: {
            by_name: {
              sum_other_doc_count: droppedDocs,
              buckets: names.map((name) => ({
                key: name,
                doc_count: 1,
                latest: { hits: { hits: [{ _source: { kind: "GAUGE", value: 1, unit: "By", time: "2026-09-01T00:00:00Z" } }] } },
              })),
            },
          },
        };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };
  }

  let capturedBody: Record<string, unknown> = {};

  /**
   * OpenSearch reports dropped buckets via `sum_other_doc_count`. Inferring it
   * from `rows.length === limit` instead was wrong twice over: it fired when an
   * app happened to have exactly `--limit` names and nothing was lost, and it
   * could never fire at all under `--limit 0`, the very flag the notice tells
   * people to reach for.
   */
  it("reports truncation when OpenSearch says buckets were dropped", async () => {
    const client = clientReturning(["a", "b", "c"], 4200);

    const result = await querySnapshot(client, { service: "app", limit: 3 });

    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when exactly --limit names exist and none were dropped", async () => {
    const client = clientReturning(["a", "b", "c"], 0);

    const result = await querySnapshot(client, { service: "app", limit: 3 });

    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("still reports truncation under --limit 0, where a row count could never reveal it", async () => {
    const client = clientReturning(["a", "b"], 99);

    const result = await querySnapshot(client, { service: "app", limit: 0 });

    expect(result.truncated).toBe(true);
  });

  it("requests every bucket for --limit 0", async () => {
    const client = clientReturning(["a", "b"]);

    await querySnapshot(client, { service: "app", limit: 0 });

    const aggs = capturedBody["aggs"] as { by_name: { terms: { size: number } } };
    expect(aggs.by_name.terms.size).toBe(10_000);
  });

  it("passes an explicit --limit straight through as the terms size", async () => {
    const client = clientReturning(["a"]);

    await querySnapshot(client, { service: "app", limit: 7 });

    const aggs = capturedBody["aggs"] as { by_name: { terms: { size: number } } };
    expect(aggs.by_name.terms.size).toBe(7);
  });
});
