import { describe, expect, it, vi } from "vitest";

import { queryNames } from "../../src/names.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

describe("queryNames", () => {
  it("shapes a terms aggregation with kind/unit sub-buckets into NAME/KIND/UNIT/DOC_COUNT rows", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              {
                key: "container.cpu.usage",
                doc_count: 208,
                by_kind: { buckets: [{ key: "GAUGE" }] },
                by_unit: { buckets: [{ key: "1" }] },
              },
              {
                key: "http.server.duration",
                doc_count: 30,
                by_kind: { buckets: [{ key: "HISTOGRAM" }] },
                by_unit: { buckets: [{ key: "ms" }] },
              },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryNames(client, { service: "app", since: "2h", limit: 50 });

    expect(rows).toEqual([
      { NAME: "container.cpu.usage", KIND: "GAUGE", UNIT: "1", DOC_COUNT: 208 },
      { NAME: "http.server.duration", KIND: "HISTOGRAM", UNIT: "ms", DOC_COUNT: 30 },
    ]);
  });

  it("returns an empty list when the aggregation has no buckets", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({ totalHits: 0, hits: [], aggregations: { by_name: { buckets: [] } } })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await expect(queryNames(client, { service: "app", since: "2h", limit: 50 })).resolves.toEqual({ rows: [], truncated: false });
  });

  it("requests every bucket (terms size 10000) when --limit is 0, matching top's 'no limit' convention", async () => {
    // names' `--limit` follows top's "0 means no limit" convention, not
    // sample's "0 is a rejected error" convention — both names and top feed
    // --limit into an aggregation bucket size, where 0 has a sensible "all"
    // meaning; sample feeds it into a raw hit count, where 0 would
    // legitimately return nothing.
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return { totalHits: 0, hits: [], aggregations: { by_name: { buckets: [] } } };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await queryNames(client, { service: "app", since: "2h", limit: 0 });

    const aggs = capturedBody["aggs"] as { by_name: { terms: { size: number } } };
    expect(aggs.by_name.terms.size).toBe(10_000);
  });

  it("passes a non-zero --limit straight through as the terms aggregation size", async () => {
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        return { totalHits: 0, hits: [], aggregations: { by_name: { buckets: [] } } };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await queryNames(client, { service: "app", since: "2h", limit: 7 });

    const aggs = capturedBody["aggs"] as { by_name: { terms: { size: number } } };
    expect(aggs.by_name.terms.size).toBe(7);
  });

  it("falls back to empty strings when a bucket has no kind or unit sub-bucket", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: { by_name: { buckets: [{ key: "mystery.metric", doc_count: 1 }] } },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryNames(client, { service: "app", since: "2h", limit: 50 });

    expect(rows).toEqual([{ NAME: "mystery.metric", KIND: "", UNIT: "", DOC_COUNT: 1 }]);
  });

  /**
   * `names` is the discovery command, so it is where a user first meets a
   * metric. Showing only the most common unit hid that `container.cpu.usage`
   * publishes two series (`unit="1"` and `unit="cpu"`, ~17x apart) while its
   * DOC_COUNT counted both — concealing exactly the fact needed before
   * aggregating it with `history`/`top`.
   */
  it("lists every unit a metric name reports, not just the most common one", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              {
                key: "container.cpu.usage",
                doc_count: 208,
                by_kind: { buckets: [{ key: "GAUGE" }] },
                by_unit: { buckets: [{ key: "cpu" }, { key: "1" }] },
              },
              {
                key: "container.memory.usage",
                doc_count: 104,
                by_kind: { buckets: [{ key: "GAUGE" }] },
                by_unit: { buckets: [{ key: "By" }] },
              },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryNames(client, { service: "app", since: "2h", limit: 50 });

    expect(rows[0]).toMatchObject({ NAME: "container.cpu.usage", UNIT: "cpu, 1" });
    // A single-unit metric must not gain a spurious separator.
    expect(rows[1]).toMatchObject({ NAME: "container.memory.usage", UNIT: "By" });
  });

  /**
   * Unlike multi-unit (an expected shape for some names), a name reporting
   * more than one `kind` is a data anomaly — see `history.ts`'s
   * `KindResolution`. `names` used to show only the most common kind here,
   * silently hiding the exact anomaly a user needs to see before running
   * `history`/`top` on the name.
   */
  it("lists every kind a metric name reports, not just the most common one", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 0,
        hits: [],
        aggregations: {
          by_name: {
            buckets: [
              {
                key: "custom.migrating.metric",
                doc_count: 2,
                by_kind: { buckets: [{ key: "GAUGE" }, { key: "HISTOGRAM" }] },
                by_unit: { buckets: [{ key: "1" }] },
              },
            ],
          },
        },
      })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const { rows } = await queryNames(client, { service: "app", since: "2h", limit: 50 });

    expect(rows[0]).toMatchObject({ NAME: "custom.migrating.metric", KIND: "GAUGE, HISTOGRAM" });
  });
});
