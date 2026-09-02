import { describe, expect, it, vi } from "vitest";

import { CfMetricsError } from "../../src/errors.js";
import type { OpenSearchClient, SearchHit, SearchResponse } from "../../src/opensearch-client.js";
import { WATCH_FETCH_LIMIT, advanceCursor, dedupeAgainstCursor, watchMetrics } from "../../src/watch.js";

describe("watchMetrics", () => {
  it("emits fresh documents oldest-to-newest and dedupes repeated ids across polls", async () => {
    const controller = new AbortController();
    const responses: SearchResponse[] = [
      {
        totalHits: 0,
        // Ascending by time, as watchMetrics now requests — "b" reappears in
        // the next poll because it ties the cursor boundary (`since` is
        // inclusive), and must be deduped rather than re-emitted.
        hits: [
          { _id: "a", _source: { time: "t1", value: 1 } },
          { _id: "b", _source: { time: "t2", value: 2 } },
        ],
      },
      {
        totalHits: 0,
        hits: [
          { _id: "b", _source: { time: "t2", value: 2 } },
          { _id: "c", _source: { time: "t3", value: 3 } },
        ],
      },
    ];
    function responseAt(index: number): SearchResponse {
      const response = responses[Math.min(index, responses.length - 1)];
      if (response === undefined) {
        throw new Error("test fixture misconfigured: no responses defined");
      }
      return response;
    }

    let call = 0;
    const client: OpenSearchClient = {
      search: vi.fn(async () => responseAt(call++)),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    const seenTimes: string[] = [];
    await watchMetrics(
      client,
      { service: "app", intervalMs: 5, lookback: "1m" },
      (source) => {
        seenTimes.push(String(source["time"]));
        if (seenTimes.length >= 3) {
          controller.abort();
        }
      },
      controller.signal,
    );

    expect(seenTimes).toEqual(["t1", "t2", "t3"]);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it("returns immediately without polling when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({ totalHits: 0, hits: [] })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await watchMetrics(client, { service: "app", intervalMs: 5, lookback: "1m" }, () => {
      throw new Error("onPoint must not be called when the signal starts aborted");
    }, controller.signal);

    expect(client.search).not.toHaveBeenCalled();
  });

  it("filters by metric name when --name is given, service when it isn't a wildcard", async () => {
    const controller = new AbortController();
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        controller.abort();
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await watchMetrics(
      client,
      { service: "app", name: "container.cpu.usage", intervalMs: 5, lookback: "1m" },
      () => undefined,
      controller.signal,
    );

    const query = capturedBody["query"] as { bool: { filter: Record<string, unknown>[] } };
    expect(query.bool.filter).toContainEqual({ terms: { name: ["container.cpu.usage"] } });
  });

  it("sorts the poll query ascending by time, oldest-of-the-new first, not descending", async () => {
    const controller = new AbortController();
    let capturedBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        capturedBody = body;
        controller.abort();
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await watchMetrics(client, { service: "app", intervalMs: 5, lookback: "1m" }, () => undefined, controller.signal);

    expect(capturedBody["sort"]).toEqual([{ time: { order: "asc", unmapped_type: "date" } }]);
  });

  it("advances the cursor to the last item actually returned in a full page, not a max-ever-seen value, and warns more may be waiting", async () => {
    // Regression test for the burst-data-loss bug: previously the poll sorted
    // `desc`, capped at WATCH_FETCH_LIMIT, and jumped the cursor to the
    // single newest matched document — permanently skipping anything between
    // the old cursor and the top-N cutoff whenever more than WATCH_FETCH_LIMIT
    // new documents landed in one interval.
    const controller = new AbortController();
    const base = Date.parse("2026-08-31T00:00:00.000Z");
    const fullPage: SearchHit[] = Array.from({ length: WATCH_FETCH_LIMIT }, (_, i) => ({
      _id: `id-${String(i)}`,
      _source: { time: new Date(base + i * 1_000).toISOString(), value: i },
    }));
    const lastInPage = fullPage[fullPage.length - 1]?._source["time"];

    let call = 0;
    let secondCallBody: Record<string, unknown> = {};
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, body) => {
        call += 1;
        if (call === 1) {
          // Simulate far more than one page's worth of real matches — the
          // page itself is still capped at WATCH_FETCH_LIMIT.
          return { totalHits: 500, hits: fullPage };
        }
        secondCallBody = body;
        controller.abort();
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };
    const notices: string[] = [];

    await watchMetrics(
      client,
      { service: "app", intervalMs: 5, lookback: "1m" },
      () => undefined,
      controller.signal,
      (message) => {
        notices.push(message);
      },
    );

    expect(notices.some((message) => message.includes(`${String(WATCH_FETCH_LIMIT)}+ new points`))).toBe(true);
    expect(notices.some((message) => message.includes("catching up next poll"))).toBe(true);
    const query = secondCallBody["query"] as { bool: { filter: Record<string, unknown>[] } };
    const rangeClause = query.bool.filter.find((clause) => "range" in clause) as
      | { range: { time: { gte: string } } }
      | undefined;
    // The next poll's cursor is the LAST item actually returned (index 99),
    // never the FIRST item in this ascending page (index 0) and never some
    // separately-tracked "newest ever seen" value.
    expect(rangeClause?.range.time.gte).toBe(lastInPage);
    expect(rangeClause?.range.time.gte).not.toBe(fullPage[0]?._source["time"]);
  });

  it("does not warn when a page returns fewer documents than the fetch limit", async () => {
    const controller = new AbortController();
    const client: OpenSearchClient = {
      search: vi.fn(async () => {
        controller.abort();
        return {
          totalHits: 2,
          hits: [
            { _id: "a", _source: { time: "t1", value: 1 } },
            { _id: "b", _source: { time: "t2", value: 2 } },
          ],
        };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };
    const notices: string[] = [];

    await watchMetrics(
      client,
      { service: "app", intervalMs: 5, lookback: "1m" },
      () => undefined,
      controller.signal,
      (message) => {
        notices.push(message);
      },
    );

    expect(notices).toEqual([]);
  });

  it("logs a warning and keeps polling when a poll's search call rejects, instead of throwing", async () => {
    const controller = new AbortController();
    let call = 0;
    const client: OpenSearchClient = {
      search: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          throw new Error("temporary network blip");
        }
        controller.abort();
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };
    const notices: string[] = [];

    await expect(
      watchMetrics(
        client,
        { service: "app", intervalMs: 5, lookback: "1m" },
        () => undefined,
        controller.signal,
        (message) => {
          notices.push(message);
        },
      ),
    ).resolves.toBeUndefined();

    expect(call).toBe(2);
    expect(notices.some((message) => message.includes("poll failed") && message.includes("temporary network blip"))).toBe(
      true,
    );
  });

  /**
   * A rejected credential never recovers by waiting, and swallowing it would
   * loop on "poll failed: HTTP 401" forever — while the command layer, which
   * could discard a cached credential and start over, never hears about it.
   */
  it("lets an auth rejection propagate instead of retrying it every interval", async () => {
    const controller = new AbortController();
    const client: OpenSearchClient = {
      search: vi.fn(async () => {
        throw new CfMetricsError("OPENSEARCH_REQUEST_FAILED", "HTTP 401 Unauthorized", { status: 401 });
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };
    const notices: string[] = [];

    await expect(
      watchMetrics(client, { service: "app", intervalMs: 5, lookback: "1m" }, () => undefined, controller.signal, (message) => {
        notices.push(message);
      }),
    ).rejects.toThrow(/HTTP 401/);

    expect(client.search).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("threads the AbortSignal through to client.search on every poll", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client: OpenSearchClient = {
      search: vi.fn(async (_index, _body, signal) => {
        capturedSignal = signal;
        controller.abort();
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
    };

    await watchMetrics(client, { service: "app", intervalMs: 5, lookback: "1m" }, () => undefined, controller.signal);

    expect(capturedSignal).toBe(controller.signal);
  });
});

describe("dedupeAgainstCursor / advanceCursor (watch's bounded dedup-set mechanics)", () => {
  it("keeps the dedup set bounded to only the ids tied at the current cursor across many advancing polls", () => {
    let cursor = "t0";
    let seenAtCursor: ReadonlySet<string> = new Set();
    let maxSetSize = 0;

    for (let i = 1; i <= 5_000; i += 1) {
      const time = `t${String(i)}`;
      const hits: SearchHit[] = [{ _id: `id-${String(i)}`, _source: { time } }];
      const deduped = dedupeAgainstCursor(hits, seenAtCursor);
      const advanced = advanceCursor(cursor, hits, deduped.seenAtCursor);
      cursor = advanced.cursor;
      seenAtCursor = advanced.seenAtCursor;
      maxSetSize = Math.max(maxSetSize, seenAtCursor.size);
    }

    expect(cursor).toBe("t5000");
    // Every poll in this scenario advances the cursor to a brand-new
    // timestamp, so the set should never hold more than the single id tied
    // at "now" — proof it does not grow without bound over a long session.
    expect(maxSetSize).toBe(1);
  });

  it("does not re-emit an id that ties the current cursor's timestamp on the next poll, but does emit a new one at the same tie", () => {
    const seenAtCursor = new Set(["existing-id"]);
    const hits: SearchHit[] = [
      { _id: "existing-id", _source: { time: "t1" } },
      { _id: "new-id", _source: { time: "t1" } },
    ];

    const { fresh, seenAtCursor: nextSeen } = dedupeAgainstCursor(hits, seenAtCursor);

    expect(fresh.map((hit) => hit._id)).toEqual(["new-id"]);
    expect(nextSeen.has("existing-id")).toBe(true);
    expect(nextSeen.has("new-id")).toBe(true);
  });

  it("advanceCursor keeps the cursor and dedup set unchanged when the page is empty", () => {
    const seenAtCursor = new Set(["a"]);
    const result = advanceCursor("t1", [], seenAtCursor);
    expect(result).toEqual({ cursor: "t1", seenAtCursor });
  });

  it("advanceCursor resets the dedup set to only ids tied at the new cursor, dropping older ones", () => {
    const hits: SearchHit[] = [
      { _id: "old", _source: { time: "t1" } },
      { _id: "tied-a", _source: { time: "t2" } },
      { _id: "tied-b", _source: { time: "t2" } },
    ];

    const result = advanceCursor("t0", hits, new Set());

    expect(result.cursor).toBe("t2");
    expect(result.seenAtCursor).toEqual(new Set(["tied-a", "tied-b"]));
  });
});
