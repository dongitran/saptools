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
});
