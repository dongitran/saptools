import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import { createGraphClient, GraphHttpError } from "../../src/graph/client.js";
import type { FetchLike } from "../../src/graph/client.js";

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

describe("createGraphClient", () => {
  it("sends bearer + accept headers and returns parsed JSON", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchLike = async (input, init) => {
      calls.push({ url: urlString(input), init });
      return jsonResponse(200, { hello: "world" });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
    });
    const result = await client.request<{ hello: string }>("/ping");
    expect(result).toEqual({ hello: "world" });
    expect(calls[0]?.url).toBe("http://api/v1/ping");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
    expect(headers?.["Accept"]).toBe("application/json");
  });

  it("accepts absolute URLs (for @odata.nextLink pagination)", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      calls.push(urlString(input));
      return jsonResponse(200, { value: [] });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
    });
    await client.request("https://other.example/next");
    expect(calls[0]).toBe("https://other.example/next");
  });

  it("serialises JSON bodies and sets content-type", async () => {
    let captured: RequestInit | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      captured = init;
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
    });
    await client.request("/thing", { method: "POST", body: { foo: 1 } });
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe(JSON.stringify({ foo: 1 }));
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  it("preserves string bodies and caller content-type", async () => {
    let captured: RequestInit | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      captured = init;
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
    });

    await client.request("/thing", {
      method: "POST",
      body: "raw-body",
      headers: { "Content-Type": "text/plain" },
    });

    expect(captured?.body).toBe("raw-body");
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("text/plain");
  });

  it("returns undefined for 204 responses", async () => {
    const fetchFn: FetchLike = async () => new Response(null, { status: 204 });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    const result: unknown = await client.request<unknown>("/thing", {
      method: "DELETE",
      expectJson: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when expectJson is false on a 200 response", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, { ok: true });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    const result = await client.request<unknown>("/thing", { expectJson: false });
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-JSON successful responses", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    const result = await client.request<unknown>("/thing");
    expect(result).toBeUndefined();
  });

  it("parses JSON responses with mixed-case content types", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    const result = await client.request<{ readonly ok: boolean }>("/thing");
    expect(result).toEqual({ ok: true });
  });

  it("throws GraphHttpError with parsed error code + message", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(404, { error: { code: "itemNotFound", message: "nope" } });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    await expect(client.request("/missing")).rejects.toBeInstanceOf(GraphHttpError);
    try {
      await client.request("/missing");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GraphHttpError);
      if (err instanceof GraphHttpError) {
        expect(err.status).toBe(404);
        expect(err.code).toBe("itemNotFound");
        expect(err.detail).toBe("nope");
      }
    }
  });

  it("falls back to raw text when error body is not JSON", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("server on fire", { status: 500, headers: { "content-type": "text/plain" } });
    const client = createGraphClient({ accessToken: "tok", baseUrl: "http://api/v1", fetchFn });
    await expect(client.request("/x")).rejects.toMatchObject({
      status: 500,
      detail: "server on fire",
    });
  });

  it("normalises trailing slashes on baseUrl", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      calls.push(urlString(input));
      return jsonResponse(200, {});
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1///",
      fetchFn,
    });
    await client.request("/x");
    expect(calls[0]).toBe("http://api/v1/x");
  });

  it("retries on 429 honouring Retry-After seconds", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const fetchFn: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "content-type": "text/plain", "retry-after": "2" },
        });
      }
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
      retry: {
        maxRetries: 2,
        baseDelayMs: 10,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
      },
    });
    const result = await client.request<{ ok: boolean }>("/x");
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(slept).toEqual([2000]);
  });

  it("retries using Retry-After HTTP dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const slept: number[] = [];
    let attempts = 0;
    const fetchFn: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("slow down", {
          status: 429,
          headers: {
            "content-type": "text/plain",
            "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT",
          },
        });
      }
      return jsonResponse(200, { ok: true });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
      retry: {
        maxRetries: 2,
        baseDelayMs: 10,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
      },
    });

    try {
      await client.request("/x");
    } finally {
      vi.useRealTimers();
    }

    expect(attempts).toBe(2);
    expect(slept).toEqual([3000]);
  });

  it("retries 503 with exponential backoff when Retry-After is absent", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const fetchFn: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response("", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      return jsonResponse(200, {});
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
      retry: {
        maxRetries: 3,
        baseDelayMs: 100,
        sleepFn: async (ms) => {
          slept.push(ms);
        },
      },
    });
    await client.request("/x");
    expect(attempts).toBe(3);
    expect(slept).toEqual([100, 200]);
  });

  it("gives up after maxRetries and surfaces the last error", async () => {
    let attempts = 0;
    const fetchFn: FetchLike = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "tooManyRequests", message: "nope" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createGraphClient({
      accessToken: "tok",
      baseUrl: "http://api/v1",
      fetchFn,
      retry: {
        maxRetries: 1,
        baseDelayMs: 1,
        sleepFn: async () => undefined,
      },
    });
    await expect(client.request("/x")).rejects.toMatchObject({
      status: 429,
      code: "tooManyRequests",
    });
    expect(attempts).toBe(2);
  });

  it("uses SHAREPOINT_GRAPH_BASE when no baseUrl override is passed", async () => {
    const previous = process.env["SHAREPOINT_GRAPH_BASE"];
    process.env["SHAREPOINT_GRAPH_BASE"] = "http://env-graph/v1.0///";
    const calls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      calls.push(urlString(input));
      return jsonResponse(200, {});
    };

    try {
      const client = createGraphClient({ accessToken: "tok", fetchFn });
      await client.request("ping");
      expect(client.baseUrl).toBe("http://env-graph/v1.0");
    } finally {
      if (previous === undefined) {
        delete process.env["SHAREPOINT_GRAPH_BASE"];
      } else {
        process.env["SHAREPOINT_GRAPH_BASE"] = previous;
      }
    }

    expect(calls[0]).toBe("http://env-graph/v1.0/ping");
  });
});
