import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NPM_REGISTRY,
  fetchLatestVersion,
  normalizeRegistryUrl,
  readUserNpmrc,
  resolveRegistryUrl,
} from "../../src/self-update/registry.js";

type FetchLike = typeof fetch;

function fakeFetch(handler: (url: string, headers: Record<string, string>) => Response | Error): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const result = handler(url, headers);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizeRegistryUrl", () => {
  it("trims trailing slashes and rejects anything that is not an http(s) URL", () => {
    expect(normalizeRegistryUrl("https://registry.npmjs.org/")).toBe("https://registry.npmjs.org");
    expect(normalizeRegistryUrl("  http://127.0.0.1:4873//  ")).toBe("http://127.0.0.1:4873");
    expect(normalizeRegistryUrl("registry.npmjs.org")).toBeUndefined();
    expect(normalizeRegistryUrl("")).toBeUndefined();
    expect(normalizeRegistryUrl(undefined)).toBeUndefined();
  });
});

describe("resolveRegistryUrl", () => {
  it("prefers the saptools override, then npm's own config, then the user npmrc (scoped first), then npmjs", () => {
    const npmrc = ["# comment", "registry=https://mirror.example/npm/", "@saptools:registry=https://scoped.example/", "//x/:_authToken=secret"].join("\n");
    expect(resolveRegistryUrl({ SAPTOOLS_NPM_REGISTRY: "http://127.0.0.1:1/", npm_config_registry: "https://b.example" }, npmrc)).toBe("http://127.0.0.1:1");
    expect(resolveRegistryUrl({ npm_config_registry: "https://b.example" }, npmrc)).toBe("https://b.example");
    expect(resolveRegistryUrl({}, npmrc)).toBe("https://scoped.example");
    expect(resolveRegistryUrl({}, 'registry="https://quoted.example/"')).toBe("https://quoted.example");
    expect(resolveRegistryUrl({}, undefined)).toBe(DEFAULT_NPM_REGISTRY);
  });

  it("ignores malformed overrides instead of sending requests to them", () => {
    expect(resolveRegistryUrl({ SAPTOOLS_NPM_REGISTRY: "not a url" }, undefined)).toBe(DEFAULT_NPM_REGISTRY);
  });
});

describe("readUserNpmrc", () => {
  let home: string;

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads ~/.npmrc when present and returns undefined otherwise", async () => {
    home = await mkdtemp(join(tmpdir(), "core-npmrc-"));
    expect(readUserNpmrc(home)).toBeUndefined();
    await writeFile(join(home, ".npmrc"), "registry=https://mirror.example\n");
    expect(readUserNpmrc(home)).toContain("mirror.example");
  });
});

describe("fetchLatestVersion", () => {
  it("reads the dist-tags endpoint with the package name encoded", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ latest: "0.7.0", next: "0.8.0-beta.1" }));
    const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl, userAgent: "cf-metrics/0.6.0 test" });
    expect(result).toEqual({ ok: true, latest: "0.7.0" });
    expect(calls).toEqual([`https://registry.example/-/package/${encodeURIComponent("@saptools/cf-metrics")}/dist-tags`]);
  });

  it("falls back to the abbreviated packument when the dist-tags endpoint is not served", async () => {
    const { fetchImpl, calls } = fakeFetch((url, headers) => {
      if (url.endsWith("/dist-tags")) {
        return json({ error: "not found" }, 404);
      }
      expect(headers["accept"]).toBe("application/vnd.npm.install-v1+json");
      return json({ name: "@saptools/cf-metrics", "dist-tags": { latest: "0.7.1" } });
    });
    expect(await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl })).toEqual({ ok: true, latest: "0.7.1" });
    expect(calls).toHaveLength(2);
  });

  it("reports an HTTP failure on both endpoints as unknown, never as an update", async () => {
    const { fetchImpl } = fakeFetch(() => json("Unauthorized", 401));
    const result = await fetchLatestVersion("@saptools/nope", "https://registry.example", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("HTTP 401");
  });

  it("does not retry through the packument when the network itself failed", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Error("fetch failed"));
    const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: `fetch failed (https://registry.example/-/package/${encodeURIComponent("@saptools/cf-metrics")}/dist-tags)` });
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed or non-semver latest tag", async () => {
    const bodies: unknown[] = ["\"just a string\"", { latest: 42 }, { latest: "latest" }, []];
    for (const body of bodies) {
      const { fetchImpl } = fakeFetch(() => json(body));
      const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl });
      expect(result.ok).toBe(false);
    }
  });

  it("gives up on a packument without dist-tags", async () => {
    const { fetchImpl } = fakeFetch((url) => (url.endsWith("/dist-tags") ? json({}, 404) : json({ name: "x" })));
    const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "packument carries no valid latest dist-tag" });
  });

  it("propagates a packument HTTP failure after the dist-tags miss", async () => {
    const { fetchImpl } = fakeFetch((url) => (url.endsWith("/dist-tags") ? json({}, 404) : json({}, 500)));
    const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("HTTP 500");
  });

  it("aborts a stalled registry after the timeout", async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const result = await fetchLatestVersion("@saptools/cf-metrics", "https://registry.example", { fetchImpl, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("aborted");
  });
});
