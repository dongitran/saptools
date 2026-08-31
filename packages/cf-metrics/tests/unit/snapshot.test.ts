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

    const rows = await querySnapshot(client, { service: "app" });

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

    const rows = await querySnapshot(client, { service: "app" });

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

    const rows = await querySnapshot(client, { service: "app" });

    expect(rows[0]).toEqual({ NAME: "orphan", KIND: "", VALUE: null, UNIT: "", TIME: "" });
  });
});
