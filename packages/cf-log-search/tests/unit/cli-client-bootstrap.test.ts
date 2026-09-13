import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@saptools/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withOpenSearchClient } from "../../src/cli/client-bootstrap.js";
import type { CredentialOpts, TargetOpts } from "../../src/cli/commandTypes.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cf-log-search-bootstrap-test-"));
  process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"] = root;
});

afterEach(() => {
  delete process.env["CF_LOG_SEARCH_SAPTOOLS_ROOT"];
  rmSync(root, { recursive: true, force: true });
  // Every test in this file re-spies on the same `core` module exports
  // (discoverDashboardsCredential, createOpenSearchClient, writeCachedCredential,
  // ...); vi.spyOn does not reset an already-spied export's mocked behavior on
  // its own. Without this, one test's .mockRejectedValue (e.g. simulating a
  // cache-write failure) silently persists into every later test, poisoning
  // unrelated assertions about cache reuse — caught by a test that failed
  // only in the full file, not in isolation.
  vi.restoreAllMocks();
});

const BASE_OPTS: TargetOpts & CredentialOpts = {
  region: "br10",
  org: "o",
  space: "s",
  serviceKey: [],
  fallbackBindingApp: [],
  refreshCredential: false,
  verbose: false,
};

describe("withOpenSearchClient", () => {
  it("discovers, caches, and reuses a credential across two calls without a second discovery", async () => {
    const discoverSpy = vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com",
      username: "u",
      password: "p",
      source: "service-key:k",
      instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({
      search: vi.fn(async () => ({ totalHits: 0, hits: [] })),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
      raw: vi.fn(async () => ({})),
    });

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    await withOpenSearchClient(BASE_OPTS, async () => undefined);

    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it("drops the cached credential and rediscovers once on a 401/403", async () => {
    let calls = 0;
    vi.spyOn(core, "discoverDashboardsCredential").mockImplementation(async () => {
      calls += 1;
      return { dashboardsEndpoint: "https://dash.example.com", username: "u", password: `p${String(calls)}`, source: "service-key:k", instance: "cloud-logging" };
    });
    let clientCalls = 0;
    vi.spyOn(core, "createOpenSearchClient").mockImplementation(() => ({
      search: vi.fn(async () => {
        clientCalls += 1;
        if (clientCalls === 1) {
          throw new core.OpenSearchRequestError("rejected", { status: 401 });
        }
        return { totalHits: 0, hits: [] };
      }),
      count: vi.fn(async () => 0),
      getMapping: vi.fn(async () => ({})),
      raw: vi.fn(async () => ({})),
    }));

    await withOpenSearchClient(BASE_OPTS, async (client) => {
      await client.search("logs-cfsyslog-*", {});
    });

    expect(calls).toBe(2);
  });

  it("respects --refresh-credential by skipping the cache read even when a live entry exists", async () => {
    const discoverSpy = vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({ search: vi.fn(async () => ({ totalHits: 0, hits: [] })), count: vi.fn(), getMapping: vi.fn(), raw: vi.fn() });

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    await withOpenSearchClient({ ...BASE_OPTS, refreshCredential: true }, async () => undefined);

    expect(discoverSpy).toHaveBeenCalledTimes(2);
  });

  it("--verbose prints which cached credential is being reused", async () => {
    vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({ search: vi.fn(), count: vi.fn(), getMapping: vi.fn(), raw: vi.fn() });
    const noticeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    await withOpenSearchClient({ ...BASE_OPTS, verbose: true }, async () => undefined);

    const written = noticeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("[verbose] using cached dashboards credential from service-key:k");
    noticeSpy.mockRestore();
  });

  it("re-throws an error that is not an auth rejection, without rediscovering", async () => {
    const discoverSpy = vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({
      search: vi.fn(async () => {
        throw new Error("connection reset");
      }),
      count: vi.fn(),
      getMapping: vi.fn(),
      raw: vi.fn(),
    });

    await expect(
      withOpenSearchClient(BASE_OPTS, async (client) => {
        await client.search("logs-cfsyslog-*", {});
      }),
    ).rejects.toThrow("connection reset");
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it("rewrites the --allow-mint-credential mention out of a discovery failure", async () => {
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error(
        "Could not resolve Cloud Logging dashboards credentials. Pass --allow-mint-credential to temporarily disable SAML and mint a new key as a last resort (disruptive: breaks SSO dashboards login for all users during the window).",
      ),
    );

    await expect(withOpenSearchClient(BASE_OPTS, async () => undefined)).rejects.toThrow(
      "Could not resolve Cloud Logging dashboards credentials.",
    );
    await expect(withOpenSearchClient(BASE_OPTS, async () => undefined)).rejects.not.toThrow(/allow-mint-credential/);
  });

  it("still returns the work result when caching the freshly discovered credential fails", async () => {
    vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({ search: vi.fn(), count: vi.fn(), getMapping: vi.fn(), raw: vi.fn() });
    vi.spyOn(core, "writeCachedCredential").mockRejectedValue(new Error("disk full"));
    const noticeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await withOpenSearchClient(BASE_OPTS, async () => "search-result");

    expect(result).toBe("search-result");
    expect(noticeSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("could not save the dashboards credential for reuse");
    noticeSpy.mockRestore();
  });

  it("reuses a cached credential when --service-key pins allow its source", async () => {
    const discoverSpy = vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({ search: vi.fn(), count: vi.fn(), getMapping: vi.fn(), raw: vi.fn() });

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["k"] }, async () => undefined);

    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a cached credential whose source --service-key pins reject", async () => {
    const discoverSpy = vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue({
      dashboardsEndpoint: "https://dash.example.com", username: "u", password: "p", source: "service-key:k", instance: "cloud-logging",
    });
    vi.spyOn(core, "createOpenSearchClient").mockReturnValue({ search: vi.fn(), count: vi.fn(), getMapping: vi.fn(), raw: vi.fn() });

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["some-other-key"] }, async () => undefined);

    expect(discoverSpy).toHaveBeenCalledTimes(2);
  });
});
