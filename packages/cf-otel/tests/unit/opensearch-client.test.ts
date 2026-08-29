import { describe, expect, it, vi } from "vitest";

import { createOpenSearchClient, encodeConsoleProxyPath, searchAfterAll } from "../../src/opensearch-client.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

describe("encodeConsoleProxyPath", () => {
  it("matches the verified working encoding for otel-v1-apm-span-* + /_search", () => {
    const path = ["otel-v1-apm-span-", "*", "/_search"].join("");
    expect(encodeConsoleProxyPath(path)).toBe("otel-v1-apm-span-%2A%2F_search");
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
        JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { name: "GET" } }] } }),
        { status: 200 },
      );
    });
    const client = createOpenSearchClient({
      dashboardsEndpoint: "https://dash.example.com",
      username: "user",
      password: "pass",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.search("otel-v1-apm-span-*", { query: { match_all: {} } });

    expect(capturedUrl).toContain("/api/console/proxy?path=");
    expect(capturedUrl).toContain("method=GET");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["osd-xsrf"]).toBe("true");
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(result.totalHits).toBe(1);
    expect(result.hits).toEqual([{ _id: "1", _source: { name: "GET" } }]);
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

describe("searchAfterAll", () => {
  it("pages past a single page size using search_after and reports not truncated once exhausted", async () => {
    const client = fakeClient([
      { totalHits: 3, hits: [{ _id: "1", sort: [1] }, { _id: "2", sort: [2] }] },
      { totalHits: 3, hits: [{ _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 100);
    expect(result.hits.map((hit) => hit._id)).toEqual(["1", "2", "3"]);
    expect(result.truncated).toBe(false);
    expect(client.search).toHaveBeenCalledTimes(2);
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
    await searchAfterAll(client, "idx", {}, 10, 100);
    expect(capturedBody?.["track_total_hits"]).toBe(true);
  });

  it("reports truncated when the fetch cap is hit before the query is exhausted", async () => {
    const client = fakeClient([
      { totalHits: 10_000, hits: [{ _id: "0", sort: [0] }, { _id: "1", sort: [1] }] },
      { totalHits: 10_000, hits: [{ _id: "2", sort: [2] }, { _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 4);
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(4);
  });

  it("stops immediately on an empty first page", async () => {
    const client = fakeClient([{ totalHits: 0, hits: [] }]);
    const result = await searchAfterAll(client, "idx", {}, 10, 100);
    expect(result.hits).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
