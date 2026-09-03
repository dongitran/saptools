import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenSearchClient, encodeConsoleProxyPath, searchAfterAll } from "../../src/opensearch-client.js";
import type { OpenSearchClient } from "../../src/opensearch-client.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A `fetch` that accepts the connection and then never answers — the failure
 * this deadline exists for. It rejects only when the signal it was handed
 * aborts, so a client that forgot to pass one would hang the test rather than
 * quietly pass.
 */
function neverAnsweringFetch(): { fetchImpl: typeof fetch; signalOf: () => AbortSignal | undefined } {
  let captured: AbortSignal | undefined;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    captured = signal;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error("createOpenSearchClient passed no AbortSignal"));
        return;
      }
      signal.addEventListener("abort", () => {
        // `AbortSignal.timeout` aborts with a DOMException, which in Node is
        // an Error subclass — rejecting with it verbatim is what lets the
        // client tell a deadline apart from a transport failure.
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted without an Error reason"));
      });
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, signalOf: () => captured };
}

function clientWith(fetchImpl: typeof fetch, timeoutMs?: number): OpenSearchClient {
  return createOpenSearchClient({
    dashboardsEndpoint: "https://dash.example.com",
    username: "user",
    password: "pass",
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

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

  it("ties startTime with spanId, not _id, so pagination never depends on OpenSearch's restricted-for-sort _id meta-field", async () => {
    let capturedSort: unknown;
    const client: OpenSearchClient = {
      search: async (_index, body) => {
        capturedSort = body["sort"];
        return { totalHits: 0, hits: [] };
      },
      count: async () => 0,
      getMapping: async () => ({}),
    };
    await searchAfterAll(client, "idx", {}, 10, 100);
    expect(capturedSort).toEqual([{ startTime: "asc" }, { spanId: "asc" }]);
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

describe("createOpenSearchClient request deadline", () => {
  it("aborts a request that never answers and names the timeout", async () => {
    // Node's fetch applies no deadline of its own, so without this the CLI
    // hangs indefinitely with no output at all.
    const { fetchImpl } = neverAnsweringFetch();
    const client = clientWith(fetchImpl, 20);

    await expect(client.search("otel-v1-apm-span-*", { query: { match_all: {} } })).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  it("tells the reader how to raise the ceiling rather than just reporting a failure", async () => {
    const { fetchImpl } = neverAnsweringFetch();
    await expect(clientWith(fetchImpl, 20).count("idx", {})).rejects.toThrow(/CF_OTEL_HTTP_TIMEOUT_MS/);
  });

  it("reports a timeout distinctly from a transport failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(clientWith(failing as unknown as typeof fetch).getMapping("idx")).rejects.toThrow(
      /failed: ECONNREFUSED/,
    );

    const { fetchImpl } = neverAnsweringFetch();
    await expect(clientWith(fetchImpl, 20).getMapping("idx")).rejects.toThrow(/timed out/);
  });

  it("applies the deadline to every verb, not just search", async () => {
    for (const call of [
      async (client: OpenSearchClient) => await client.search("idx", {}),
      async (client: OpenSearchClient) => await client.count("idx", {}),
      async (client: OpenSearchClient) => await client.getMapping("idx"),
    ]) {
      const { fetchImpl } = neverAnsweringFetch();
      await expect(call(clientWith(fetchImpl, 20))).rejects.toThrow(/timed out after 20ms/);
    }
  });

  it("honors CF_OTEL_HTTP_TIMEOUT_MS", async () => {
    vi.stubEnv("CF_OTEL_HTTP_TIMEOUT_MS", "35");
    const { fetchImpl } = neverAnsweringFetch();
    await expect(clientWith(fetchImpl).search("idx", {})).rejects.toThrow(/timed out after 35ms/);
  });

  it("lets an explicit timeoutMs option win over the environment", async () => {
    vi.stubEnv("CF_OTEL_HTTP_TIMEOUT_MS", "999999");
    const { fetchImpl } = neverAnsweringFetch();
    await expect(clientWith(fetchImpl, 20).search("idx", {})).rejects.toThrow(/timed out after 20ms/);
  });

  it.each(["not-a-number", "0", "-5", "", "1.5", "-1", "1e3000", "Infinity"])(
    "falls back to the 60s default when the override is %j, rather than refusing to run",
    async (raw) => {
      // An unusable env var must not be the reason a read-only query fails.
      vi.stubEnv("CF_OTEL_HTTP_TIMEOUT_MS", raw);
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 7 }), { status: 200 }));
      await expect(clientWith(fetchImpl as unknown as typeof fetch).count("idx", {})).resolves.toBe(7);
    },
  );

  it("passes a live, un-aborted signal on a request that answers normally", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ count: 1 }), { status: 200 });
    });

    await clientWith(fetchImpl as unknown as typeof fetch).count("idx", {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("gives each request its own deadline, so a long paged fetch is not capped in aggregate", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      if (signal !== undefined) {
        signals.push(signal);
      }
      return new Response(JSON.stringify({ count: 0 }), { status: 200 });
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch, 20);

    await client.count("idx", {});
    await client.count("idx", {});

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

describe("createOpenSearchClient deadline normalization", () => {
  /**
   * `AbortSignal.timeout` throws a RangeError for a fractional or negative
   * delay. Reaching it would report a bad local setting as an OpenSearch
   * failure, so every unusable value must fall back to the default instead.
   */
  it.each([1.5, -1, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default rather than letting timeoutMs %j reach AbortSignal.timeout",
    async (timeoutMs) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 3 }), { status: 200 }));
      const client = createOpenSearchClient({
        dashboardsEndpoint: "https://dash.example.com",
        username: "user",
        password: "pass",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs,
      });

      await expect(client.count("idx", {})).resolves.toBe(3);
    },
  );

  it.each([2_147_483_648, 4_294_967_296, 1e20])(
    "clamps an over-large timeoutMs of %j instead of letting Node reduce it to 1ms",
    async (timeoutMs) => {
      // Above 2^31-1 Node silently sets the timer to 1ms; above 2^32-1 it
      // throws. Either way a request would fail almost immediately while the
      // caller believed they had raised the ceiling.
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 9 }), { status: 200 }));
      const client = createOpenSearchClient({
        dashboardsEndpoint: "https://dash.example.com",
        username: "user",
        password: "pass",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs,
      });

      await expect(client.count("idx", {})).resolves.toBe(9);
    },
  );

  it("clamps an over-large CF_OTEL_HTTP_TIMEOUT_MS the same way", async () => {
    vi.stubEnv("CF_OTEL_HTTP_TIMEOUT_MS", "9999999999");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 4 }), { status: 200 }));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).count("idx", {})).resolves.toBe(4);
  });

  it("does not let an over-large timeoutMs collapse into Node's 1ms overflow", async () => {
    // Unclamped, Node reduces a 2^31 delay to a 1ms timer, so this response
    // would be aborted rather than returned — the caller having asked for a
    // *longer* ceiling, not a shorter one.
    const slowFetch = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(JSON.stringify({ count: 11 }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(clientWith(slowFetch, 2_147_483_648).count("idx", {})).resolves.toBe(11);
  });

  it("aborts that same slow response when the ceiling really is small", async () => {
    // The control for the test above: same 120ms response, a 20ms ceiling.
    const slowFetch = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response(JSON.stringify({ count: 11 }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(clientWith(slowFetch, 20).count("idx", {})).rejects.toThrow(/timed out after 20ms/);
  });

  it("still honors a valid explicit timeoutMs", async () => {
    const { fetchImpl } = neverAnsweringFetch();
    await expect(clientWith(fetchImpl, 25).count("idx", {})).rejects.toThrow(/timed out after 25ms/);
  });
});

describe("createOpenSearchClient body-read deadline", () => {
  /** Headers arrive, then the payload never finishes — where the deadline actually lands on a wide aggregation. */
  function stalledBodyFetch(): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      text: async (): Promise<string> => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    })) as unknown as typeof fetch;
  }

  it("names the timeout when it fires while the body is still streaming", async () => {
    // Left unhandled, this abort escaped as a bare "The operation was aborted
    // due to timeout" with no path, no ceiling and no hint.
    await expect(clientWith(stalledBodyFetch(), 40).count("idx", {})).rejects.toThrow(
      /OpenSearch request to idx\/_count timed out after 40ms/,
    );
    await expect(clientWith(stalledBodyFetch(), 40).count("idx", {})).rejects.toThrow(
      /CF_OTEL_HTTP_TIMEOUT_MS/,
    );
  });

  it("still reports a non-timeout body failure as a plain request failure", async () => {
    const brokenBody = (async () => ({
      ok: true,
      status: 200,
      text: async (): Promise<string> => {
        throw new Error("socket hang up");
      },
    })) as unknown as typeof fetch;

    await expect(clientWith(brokenBody, 40).search("idx", {})).rejects.toThrow(/failed: socket hang up/);
  });

  it("wraps the body failure as a CfOtelError with the OpenSearch code", async () => {
    await expect(clientWith(stalledBodyFetch(), 40).getMapping("idx")).rejects.toMatchObject({
      name: "CfOtelError",
      code: "OPENSEARCH_REQUEST_FAILED",
    });
  });
});
