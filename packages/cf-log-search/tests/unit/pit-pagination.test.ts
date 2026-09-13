import type { OpenSearchClient } from "@saptools/core";
import { describe, expect, it, vi } from "vitest";

import { pitSearchAll } from "../../src/pit-pagination.js";

interface FakeState {
  readonly pitOpens: number;
  readonly pitCloses: number;
  readonly searchCalls: Record<string, unknown>[];
}

/**
 * A minimal fake of the `raw()` surface `pitSearchAll` uses — deliberately
 * not the full HTTP-level `fake-opensearch.ts` fixture (that is for e2e; see
 * Task 13), since this module only ever calls `client.raw`, never
 * `client.search`/`count`/`getMapping`.
 */
function fakeClient(pages: readonly { readonly ids: readonly string[]; readonly total: number }[]): { client: OpenSearchClient; state: FakeState } {
  const state: FakeState = { pitOpens: 0, pitCloses: 0, searchCalls: [] };
  let call = 0;
  const client: OpenSearchClient = {
    search: vi.fn(),
    count: vi.fn(),
    getMapping: vi.fn(),
    raw: vi.fn(async (path: string, method: string, body?: Record<string, unknown>) => {
      if (path.includes("/_search/point_in_time")) {
        (state as { pitOpens: number }).pitOpens += 1;
        return { pit_id: "pit-1" };
      }
      if (path === "_search/point_in_time" && method === "DELETE") {
        (state as { pitCloses: number }).pitCloses += 1;
        return { pits: [{ successful: true }] };
      }
      if (path === "_search" && method === "POST") {
        state.searchCalls.push(body ?? {});
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        const ids = page?.ids ?? [];
        return {
          pit_id: "pit-1",
          hits: {
            total: { value: page?.total ?? 0 },
            hits: ids.map((id, index) => ({ _id: id, _source: { n: index }, sort: [Date.now() - index, index] })),
          },
        };
      }
      throw new Error(`unexpected raw() call: ${method} ${path}`);
    }),
  };
  return { client, state };
}

describe("pitSearchAll", () => {
  it("opens a PIT, pages through search_after, and always closes the PIT", async () => {
    const { client, state } = fakeClient([{ ids: ["a", "b"], total: 3 }, { ids: ["c"], total: 3 }]);

    const result = await pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 2, 100);

    expect(result.hits.map((hit) => hit.id)).toEqual(["a", "b", "c"]);
    expect(result.totalHits).toBe(3);
    expect(result.truncated).toBe(false);
    expect(state.pitOpens).toBe(1);
    expect(state.pitCloses).toBe(1);
  });

  it("closes the PIT even when a search page throws", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(),
      count: vi.fn(),
      getMapping: vi.fn(),
      raw: vi.fn(async (path: string, method: string) => {
        if (path.includes("/_search/point_in_time")) {
          return { pit_id: "pit-1" };
        }
        if (path === "_search/point_in_time" && method === "DELETE") {
          return { pits: [{ successful: true }] };
        }
        throw new Error("boom");
      }),
    };

    await expect(pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 10, 100)).rejects.toThrow("boom");
    expect(client.raw).toHaveBeenCalledWith("_search/point_in_time", "DELETE", { pit_id: ["pit-1"] });
  });

  it("reports truncated once maxTotal is reached before the query is exhausted", async () => {
    const { client } = fakeClient([{ ids: ["a", "b"], total: 10_000 }, { ids: ["c", "d"], total: 10_000 }]);

    const result = await pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 2, 3);

    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(3);
  });

  it("sorts by [@timestamp desc, _doc asc] and requests track_total_hits on every page", async () => {
    const { client, state } = fakeClient([{ ids: ["a"], total: 1 }]);

    await pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 10, 100);

    expect(state.searchCalls[0]).toMatchObject({
      sort: [{ "@timestamp": "desc" }, { _doc: "asc" }],
      track_total_hits: true,
    });
  });

  it("throws a clear error when OpenSearch does not return a pit_id", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(),
      count: vi.fn(),
      getMapping: vi.fn(),
      raw: vi.fn(async () => ({})),
    };

    await expect(pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 10, 100)).rejects.toThrow(/did not return a pit_id/);
  });

  it("stops on an empty first page without erroring", async () => {
    const { client } = fakeClient([{ ids: [], total: 0 }]);
    const result = await pitSearchAll(client, "logs-cfsyslog-*", { match_all: {} }, 10, 100);
    expect(result.hits).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
