import { describe, expect, it, vi } from "vitest";

import { CfMetricsError, isAuthRejection } from "../../src/errors.js";
import { createOpenSearchClient, encodeConsoleProxyPath, searchAfterAll } from "../../src/opensearch-client.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

describe("encodeConsoleProxyPath", () => {
  it("matches the verified working encoding for metrics-* + /_search", () => {
    const path = ["metrics-", "*", "/_search"].join("");
    expect(encodeConsoleProxyPath(path)).toBe("metrics-%2A%2F_search");
  });

  it("encodes every slash and asterisk in a more complex path", () => {
    expect(encodeConsoleProxyPath("a/b*c/d*")).toBe("a%2Fb%2Ac%2Fd%2A");
  });
});

describe("createOpenSearchClient", () => {
  it("POSTs to the console proxy with osd-xsrf, basic auth, and the real verb as ?method=", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { name: "container.cpu.usage" } }] } }),
        { status: 200 },
      );
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "user",
      password: "pass",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.search("metrics-*", { query: { match_all: {} } });

    expect(capturedUrl).toContain("/api/console/proxy?path=");
    expect(capturedUrl).toContain("method=GET");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["osd-xsrf"]).toBe("true");
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(result.totalHits).toBe(1);
    expect(result.hits).toEqual([{ _id: "1", _source: { name: "container.cpu.usage" } }]);
  });

  it("throws a clear error on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.count("idx", {})).rejects.toThrow(/HTTP 404/);
  });

  /**
   * The credential cache needs to tell "this credential is dead" from every
   * other failure, and only an HTTP response carries that information — a
   * timeout or a transport error must never look like a rejected credential.
   */
  it("carries the HTTP status on the error so a 401/403 is recognizable as an auth rejection", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error: unknown = await client.search("idx", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CfMetricsError);
    expect((error as CfMetricsError).status).toBe(401);
    expect(isAuthRejection(error)).toBe(true);
  });

  it("does not report a transport failure as an auth rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error: unknown = await client.search("idx", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CfMetricsError);
    expect((error as CfMetricsError).status).toBeUndefined();
    expect(isAuthRejection(error)).toBe(false);
  });

  it("parses a bare numeric hits.total (older ES/OS shape) as well as the object shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hits: { total: 42, hits: [] } }), { status: 200 }));
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await client.search("idx", {})).totalHits).toBe(42);
  });

  it("defaults to https:// when a real Cloud Logging endpoint is returned as a bare hostname", async () => {
    // Regression test: a real service-key/binding payload's dashboards-endpoint
    // has been observed with no scheme at all (e.g.
    // "dashboards-sf-<guid>.<n>.<region>.cls.services.cloud.sap"), which
    // fetch() otherwise rejects outright as an invalid URL.
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "dashboards-sf-example.003.br10.cls.services.cloud.sap",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.search("idx", {});

    expect(capturedUrl.startsWith("https://dashboards-sf-example.003.br10.cls.services.cloud.sap/")).toBe(true);
  });

  it("strips multiple trailing slashes", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com///",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.search("idx", {});

    expect(capturedUrl.startsWith("https://dash.example.com/api/console/proxy")).toBe(true);
  });

  it("leaves an already-schemed endpoint unchanged", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "http://127.0.0.1:4000/",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.search("idx", {});

    expect(capturedUrl.startsWith("http://127.0.0.1:4000/")).toBe(true);
  });

  it("threads an AbortSignal through to the underlying fetch call when the caller provides one", async () => {
    // Regression test: watch.ts relies on this to actually cancel an
    // in-flight poll request on Ctrl-C, rather than only checking
    // `signal.aborted` between iterations.
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();

    await client.search("metrics-*", { query: { match_all: {} } }, controller.signal);

    // The caller's signal is now combined with the request deadline rather than
    // forwarded verbatim, so identity no longer holds — what must still hold is
    // that aborting the caller's controller aborts the request.
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.signal?.aborted).toBe(false);
    controller.abort();
    expect(capturedInit?.signal?.aborted).toBe(true);
  });

  it("still supplies a signal when the caller passes none, so no request is left unbounded", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.search("metrics-*", { query: { match_all: {} } });

    // Previously this asserted `undefined` — that absence *was* the bug: a
    // request with no signal has no deadline and can hang forever.
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

function fakeClient(pages: readonly { totalHits: number; hits: readonly { _id: string; sort: number[] }[] }[]): OpenSearchClient {
  let call = 0;
  return {
    search: vi.fn(async () => {
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return { totalHits: page?.totalHits ?? 0, hits: (page?.hits ?? []).map((hit) => ({ ...hit, _source: {} })) };
    }),
    count: vi.fn(),
    getMapping: vi.fn(),
  };
}

// This package's callers query heterogeneous metric documents (container/
// queue/db-pool/custom), so — unlike cf-otel's span domain, which always
// sorts on its own startTime+spanId — no single tiebreaker is universally
// correct here; searchAfterAll takes the caller's tiebreaker as a parameter
// instead of hardcoding one. This constant stands in for "whatever a real
// caller supplies" in these tests.
const ARBITRARY_TIEBREAKER = [{ time: "asc" }, { "resource.attributes.sap@cf@instance_id": "asc" }] as const;

describe("searchAfterAll", () => {
  it("pages past a single page size using search_after and reports not truncated once exhausted", async () => {
    const client = fakeClient([
      { totalHits: 3, hits: [{ _id: "1", sort: [1] }, { _id: "2", sort: [2] }] },
      { totalHits: 3, hits: [{ _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 100, ARBITRARY_TIEBREAKER);
    expect(result.hits.map((hit) => hit._id)).toEqual(["1", "2", "3"]);
    expect(result.truncated).toBe(false);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it("uses the caller-supplied sort tiebreaker verbatim, never a hardcoded field", async () => {
    let capturedSort: unknown;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedSort = body["sort"];
        return { totalHits: 0, hits: [] };
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };
    await searchAfterAll(client, "idx", {}, 10, 100, ARBITRARY_TIEBREAKER);
    expect(capturedSort).toEqual(ARBITRARY_TIEBREAKER);
  });

  it("always requests track_total_hits, so OpenSearch's default 10000 total-hits cap never applies", async () => {
    // Without this, hits.total.value silently freezes at 10000 once real
    // matches exceed it — independent of search_after paging, which still
    // correctly collects every hit — making "total"/"truncated" self-
    // contradictory (a total that doesn't match how many hits came back).
    let capturedBody: Record<string, unknown> | undefined;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedBody = body;
        return { totalHits: 1, hits: [{ _id: "1", _source: {}, sort: [1] }] };
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };
    await searchAfterAll(client, "idx", {}, 10, 100, ARBITRARY_TIEBREAKER);
    expect(capturedBody?.["track_total_hits"]).toBe(true);
  });

  it("reports truncated when the fetch cap is hit before the query is exhausted", async () => {
    const client = fakeClient([
      { totalHits: 10_000, hits: [{ _id: "0", sort: [0] }, { _id: "1", sort: [1] }] },
      { totalHits: 10_000, hits: [{ _id: "2", sort: [2] }, { _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 4, ARBITRARY_TIEBREAKER);
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(4);
  });

  it("stops immediately on an empty first page", async () => {
    const client = fakeClient([{ totalHits: 0, hits: [] }]);
    const result = await searchAfterAll(client, "idx", {}, 10, 100, ARBITRARY_TIEBREAKER);
    expect(result.hits).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("request timeout", () => {
  /**
   * Before this, `fetch` was called with no deadline at all, so a Dashboards
   * endpoint that accepted the connection and then went silent hung the command
   * forever — no output, no error, nothing to distinguish it from a slow query.
   */
  it("aborts a request that outlives the timeout, and names the timeout in the error", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          });
        }),
    );
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });

    await expect(client.search("metrics-*", { size: 0 })).rejects.toThrow(/timed out after 20ms/);
  });

  it("passes a signal on every request, so no call can escape the deadline", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ hits: { hits: [], total: { value: 0 } } }));
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.search("metrics-*", { size: 0 });

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  /**
   * `watch` supplies its own Ctrl-C signal. Combining rather than replacing
   * matters: passing a caller signal used to opt that request out of any
   * deadline, which is exactly the long-running command that needs one.
   */
  it("still honours the caller's own abort signal alongside the deadline", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const reason: unknown = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          });
        }),
    );
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 60_000,
    });

    const pending = client.search("metrics-*", { size: 0 }, controller.signal);
    controller.abort();

    // Rejects on the caller's abort, well before the 60s deadline, and is not
    // reported as a timeout.
    await expect(pending).rejects.toThrow(/failed/);
  });
});
