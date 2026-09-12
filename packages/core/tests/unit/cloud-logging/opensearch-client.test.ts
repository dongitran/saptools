import { describe, expect, it, vi } from "vitest";

import { createOpenSearchClient, encodeConsoleProxyPath, isAuthRejection, OpenSearchRequestError, searchAfterAll } from "../../../src/cloud-logging/opensearch-client.js";
import type { OpenSearchClient } from "../../../src/cloud-logging/opensearch-client.js";

describe("encodeConsoleProxyPath", () => {
  it("percent-encodes both slashes and asterisks", () => {
    expect(encodeConsoleProxyPath("logs-cfsyslog-*/_search")).toBe("logs-cfsyslog-%2A%2F_search");
  });
});

describe("createOpenSearchClient", () => {
  it("POSTs to the console proxy with osd-xsrf, basic auth, and the real verb as ?method=", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "1", _source: { a: 1 } }] } }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "user", password: "pass", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.search("logs-cfsyslog-*", { query: { match_all: {} } });

    expect(capturedUrl).toContain("/api/console/proxy?path=");
    expect(capturedUrl).toContain("method=GET");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["osd-xsrf"]).toBe("true");
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(result.totalHits).toBe(1);
  });

  it("threads a caller AbortSignal alongside the request deadline", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });
    const controller = new AbortController();

    await client.search("idx", { query: { match_all: {} } }, controller.signal);

    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(capturedInit?.signal?.aborted).toBe(true);
  });

  it("memoizes getMapping per client instance, sharing one in-flight request across concurrent callers", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ "idx-000001": { mappings: { properties: {} } } }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const [a, b] = await Promise.all([client.getMapping("logs-cfsyslog-*"), client.getMapping("logs-cfsyslog-*")]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("does not remember a failed mapping fetch as the answer", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response("boom", { status: 500 }) : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getMapping("idx")).rejects.toThrow();
    await expect(client.getMapping("idx")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("raw() issues an arbitrary console-proxy path/method not shaped like <index>/_search", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = String(init?.method);
      return new Response(JSON.stringify({ pit_id: "abc123" }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.raw("logs-cfsyslog-*/_search/point_in_time?keep_alive=1m", "POST");

    expect(capturedUrl).toContain("method=POST");
    expect(capturedMethod).toBe("POST"); // console-proxy is always POSTed to; the real verb travels in ?method=
    expect(result).toEqual({ pit_id: "abc123" });
  });

  it("carries the HTTP status on the error, recognizable as an auth rejection at 401/403", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const error: unknown = await client.search("idx", {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenSearchRequestError);
    expect((error as OpenSearchRequestError).status).toBe(401);
  });

  it("refuses a search answered by only some shards", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            _shards: { total: 104, successful: 100, failed: 4, failures: [{ reason: { type: "x", reason: "shard down" } }] },
            hits: { total: { value: 3 }, hits: [] },
          }),
          { status: 200 },
        ),
    );
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/only some shards: 4 of 104 failed/);
  });

  it("defaults to https:// when the endpoint is a bare hostname", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "dashboards-sf-x.003.br10.cls.services.cloud.sap", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search("idx", {});
    expect(capturedUrl.startsWith("https://dashboards-sf-x.003.br10.cls.services.cloud.sap/")).toBe(true);
  });

  it.each([1.5, -1, 0, Number.NaN])("falls back to the default timeout rather than passing %j to AbortSignal.timeout", async (timeoutMs) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 3 }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs });
    await expect(client.count("idx", {})).resolves.toBe(3);
  });

  it.each([2_147_483_648, 4_294_967_296])("clamps an over-large timeoutMs of %j instead of Node's silent 1ms collapse", async (timeoutMs) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 9 }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs });
    await expect(client.count("idx", {})).resolves.toBe(9);
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
    raw: vi.fn(),
  };
}

const A_TIEBREAKER = [{ startTime: "asc" }, { spanId: "asc" }] as const;

describe("searchAfterAll", () => {
  it("pages past a single page size using the caller-supplied tiebreaker verbatim", async () => {
    let capturedSort: unknown;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedSort = body["sort"];
        return { totalHits: 0, hits: [] };
      },
      count: async () => 0,
      getMapping: async () => ({}),
      raw: async () => ({}),
    };
    await searchAfterAll(client, "idx", {}, 10, 100, A_TIEBREAKER);
    expect(capturedSort).toEqual(A_TIEBREAKER);
  });

  it("collects every hit across pages and reports not truncated once exhausted", async () => {
    const client = fakeClient([
      { totalHits: 3, hits: [{ _id: "1", sort: [1] }, { _id: "2", sort: [2] }] },
      { totalHits: 3, hits: [{ _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 100, A_TIEBREAKER);
    expect(result.hits.map((hit) => hit._id)).toEqual(["1", "2", "3"]);
    expect(result.truncated).toBe(false);
  });

  it("reports truncated when the fetch cap is hit before the query is exhausted", async () => {
    const client = fakeClient([
      { totalHits: 10_000, hits: [{ _id: "0", sort: [0] }, { _id: "1", sort: [1] }] },
      { totalHits: 10_000, hits: [{ _id: "2", sort: [2] }, { _id: "3", sort: [3] }] },
    ]);
    const result = await searchAfterAll(client, "idx", {}, 2, 4, A_TIEBREAKER);
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(4);
  });

  it("always requests track_total_hits so the 10000 default cap never silently applies", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedBody = body;
        return { totalHits: 0, hits: [] };
      },
      count: async () => 0,
      getMapping: async () => ({}),
      raw: async () => ({}),
    };
    await searchAfterAll(client, "idx", {}, 10, 100, A_TIEBREAKER);
    expect(capturedBody?.["track_total_hits"]).toBe(true);
  });

  it("returns truncated true when last hit has no sort field", async () => {
    const client: OpenSearchClient = {
      search: vi.fn(async () => ({
        totalHits: 100,
        hits: [{ _id: "1", _source: {} }], // no sort
      })),
      count: vi.fn(),
      getMapping: vi.fn(),
      raw: vi.fn(),
    };
    const result = await searchAfterAll(client, "idx", {}, 10, 100, A_TIEBREAKER);
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(1);
  });
});

describe("isAuthRejection", () => {
  it("recognizes 401 as an auth rejection", () => {
    const error = new OpenSearchRequestError("test", { status: 401 });
    expect(isAuthRejection(error)).toBe(true);
  });

  it("recognizes 403 as an auth rejection", () => {
    const error = new OpenSearchRequestError("test", { status: 403 });
    expect(isAuthRejection(error)).toBe(true);
  });

  it("returns false for other status codes", () => {
    const error = new OpenSearchRequestError("test", { status: 500 });
    expect(isAuthRejection(error)).toBe(false);
  });

  it("returns false for errors without status", () => {
    const error = new OpenSearchRequestError("test");
    expect(isAuthRejection(error)).toBe(false);
  });

  it("returns false for non-OpenSearchRequestError objects", () => {
    expect(isAuthRejection(new Error("test"))).toBe(false);
  });
});

describe("error handling edge cases", () => {
  it("handles network errors during fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Network error");
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/Network error/);
  });

  it("handles timeout errors specially", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("Timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const error: unknown = await client.search("idx", {}).catch((e: unknown) => e);
    expect((error as Error).message).toContain("timed out after");
  });

  it("handles response.text() errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("Text parse error");
        },
      } as unknown as Response;
    });
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/Text parse error/);
  });

  it("handles invalid JSON in response", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/not valid JSON/);
  });

  it("handles timed_out flag in response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ timed_out: true, hits: { total: { value: 0 }, hits: [] } }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/timed out serving/);
  });

  it("handles shard failure with no reason", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            _shards: { total: 104, successful: 100, failed: 4, failures: [{ reason: {} }] },
            hits: { total: { value: 3 }, hits: [] },
          }),
          { status: 200 },
        ),
    );
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search("idx", {})).rejects.toThrow(/only some shards: 4 of 104 failed/);
  });

  it("respects CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS environment variable", async () => {
    const originalEnv = process.env["CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS"];
    process.env["CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS"] = "1";
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              _shards: { total: 104, successful: 100, failed: 4 },
              hits: { total: { value: 3 }, hits: [] },
            }),
            { status: 200 },
          ),
      );
      const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

      const result = await client.search("idx", {});
      expect(result.totalHits).toBe(3);
    } finally {
      if (originalEnv === undefined) {
        delete process.env["CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS"];
      } else {
        process.env["CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS"] = originalEnv;
      }
    }
  });

  it("handles count response with missing count field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ other: "field" }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.count("idx", {});
    expect(result).toBe(0);
  });

  it("handles empty response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.search("idx", {});
    expect(result.totalHits).toBe(0);
    expect(result.hits.length).toBe(0);
  });

  it("handles invalid hit without _id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _source: {} }] } }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.search("idx", {});
    expect(result.hits.length).toBe(0);
  });

  it("handles invalid hit without _source", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "1" }] } }), { status: 200 }));
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.search("idx", {});
    expect(result.hits.length).toBe(0);
  });

  it("handles response with aggregations", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hits: { total: { value: 0 }, hits: [] },
            aggregations: { my_agg: { buckets: [] } },
          }),
          { status: 200 },
        ),
    );
    const client = createOpenSearchClient({ dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.search("idx", {});
    expect(result.aggregations).toEqual({ my_agg: { buckets: [] } });
  });
});
