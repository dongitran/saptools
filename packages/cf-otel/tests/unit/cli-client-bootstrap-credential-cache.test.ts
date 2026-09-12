import { OpenSearchRequestError } from "@saptools/core";
import * as core from "@saptools/core";
import type { DashboardsCredential, ResolvedTarget } from "@saptools/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { withOpenSearchClient } from "../../src/cli/client-bootstrap.js";

/**
 * cf-otel never had an on-disk credential cache before this migration — this
 * file is new coverage, not moved coverage, mirroring the shape of
 * `@saptools/cf-metrics`'s `cache.e2e.ts` (an e2e test, since cf-metrics's
 * cache predates the shared core module) as a unit test against the mocked
 * `@saptools/core` cache functions instead, matching how this package's own
 * `cli-client-bootstrap.test.ts` already mocks `@saptools/core`.
 */

const TARGET: ResolvedTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  region: "eu10",
  org: "o",
  space: "s",
  selectorSource: "explicit",
  regionConfirmed: true,
};

const BASE_OPTS = {
  region: "eu10",
  org: "o",
  space: "s",
  serviceKey: [],
  fallbackBindingApp: [],
  allowMintCredential: false,
  verbose: false,
};

const DISCOVERED: DashboardsCredential = {
  dashboardsEndpoint: "https://dash.example.com",
  username: "u",
  password: "freshly-discovered",
  source: "service-key:key1",
  instance: "cloud-logging",
};

const CACHED: DashboardsCredential = { ...DISCOVERED, password: "from-cache", source: "binding:legacy-app" };

let stderr: string;

beforeEach(() => {
  stderr = "";
  vi.stubEnv("SAP_EMAIL", "");
  vi.stubEnv("SAP_PASSWORD", "");
  vi.spyOn(core, "resolveTarget").mockResolvedValue(TARGET);
  vi.spyOn(core, "printResolvedTarget").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(core, "readCachedCredential").mockResolvedValue(undefined);
  vi.spyOn(core, "writeCachedCredential").mockResolvedValue(undefined);
  vi.spyOn(core, "deleteCachedCredential").mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubDiscovery(credential: DashboardsCredential = DISCOVERED): MockInstance<typeof core.discoverDashboardsCredential> {
  return vi.spyOn(core, "discoverDashboardsCredential").mockResolvedValue(credential);
}

describe("withOpenSearchClient credential cache", () => {
  it("discovers a credential on a cache miss, hands the caller a client, and remembers the result", async () => {
    const discover = stubDiscovery();

    const result = await withOpenSearchClient(BASE_OPTS, async (client) => {
      expect(client).toBeDefined();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(core.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET }, DISCOVERED, { cliName: "cf-otel" });
  });

  it("uses a cached credential without touching Cloud Foundry at all", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await expect(withOpenSearchClient(BASE_OPTS, async () => "ok")).resolves.toBe("ok");

    expect(discover).not.toHaveBeenCalled();
    expect(core.writeCachedCredential).not.toHaveBeenCalled();
  });

  it("keys the cache by --service-instance when one is given", async () => {
    stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceInstance: "cloud-logging" }, async () => undefined);

    expect(core.readCachedCredential).toHaveBeenCalledWith({ target: TARGET, instanceSelector: "cloud-logging" }, { cliName: "cf-otel" });
    expect(core.writeCachedCredential).toHaveBeenCalledWith(
      { target: TARGET, instanceSelector: "cloud-logging" },
      DISCOVERED,
      { cliName: "cf-otel" },
    );
  });

  it("CF_OTEL_CREDENTIAL_CACHE=0 neither reads nor writes the cache", async () => {
    vi.stubEnv("CF_OTEL_CREDENTIAL_CACHE", "0");
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);

    expect(core.readCachedCredential).not.toHaveBeenCalled();
    expect(core.writeCachedCredential).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  /**
   * `--service-key`/`--fallback-binding-app` say which bindings may be used,
   * and each one restricts only its own candidate type — `applyNameFilters`
   * leaves the other type unfiltered during discovery, so running with
   * `--service-key key1` can legitimately *return* an app-binding credential
   * once the pinned keys turn out to be unusable. Rejecting that from the
   * cache made those runs rediscover from scratch every time and arrive at
   * the same answer.
   */
  it("accepts a cached app-binding credential when only service keys were pinned", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["key1"] }, async () => undefined);

    expect(discover).not.toHaveBeenCalled();
  });

  it("still treats a cached credential from a binding the caller excluded as a miss", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    // CACHED came from `binding:legacy-app`, and this run pins a different app.
    await withOpenSearchClient({ ...BASE_OPTS, fallbackBindingApp: ["other-app"] }, async () => undefined);

    expect(discover).toHaveBeenCalledTimes(1);
  });

  /**
   * Minting disables SAML on the shared Cloud Logging instance to create its
   * key, so re-minting is never free. A minted credential is the product of
   * the same flags this run carries — discovery already honoured them before
   * minting — so treating it as unpinned sent every `--allow-mint-credential`
   * invocation back through a fresh mint, breaking SSO for everyone each time.
   */
  it("reuses a cached minted credential instead of minting again on every run", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue({ ...CACHED, source: "minted:cf-otel-ab12cd34" });
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["key1"], allowMintCredential: true }, async () => undefined);

    expect(discover).not.toHaveBeenCalled();
  });

  it("does not reuse a minted credential for a run that did not opt into minting", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue({ ...CACHED, source: "minted:cf-otel-ab12cd34" });
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["key1"] }, async () => undefined);

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("accepts a cached credential whose source matches a pin", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, fallbackBindingApp: ["legacy-app"] }, async () => undefined);

    expect(discover).not.toHaveBeenCalled();
  });

  /**
   * The one failure a cached credential can cause on its own: the key or
   * binding it came from was deleted, so OpenSearch now rejects it. Recovery
   * has to be automatic — the user cannot tell a stale cache from a real
   * permission problem, and should not have to.
   */
  it("drops a cached credential OpenSearch rejects, rediscovers, and retries the work once", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();
    let attempt = 0;
    const work = vi.fn(async (client: unknown) => {
      attempt += 1;
      if (attempt === 1) {
        // The real, now-shared `createOpenSearchClient` throws this exact
        // class on an HTTP 401/403 — `isAuthRejection` (also from
        // `@saptools/core` now) only recognizes it, so the fixture must match.
        throw new OpenSearchRequestError("OpenSearch request failed: HTTP 401 Unauthorized", { status: 401 });
      }
      expect(client).toBeDefined();
      return "ok";
    });

    await expect(withOpenSearchClient(BASE_OPTS, work)).resolves.toBe("ok");

    expect(work).toHaveBeenCalledTimes(2);
    expect(core.deleteCachedCredential).toHaveBeenCalledWith({ target: TARGET }, { cliName: "cf-otel" });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(core.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET }, DISCOVERED, { cliName: "cf-otel" });
    expect(stderr).toContain("cached dashboards credential from binding:legacy-app was rejected");
    expect(stderr).toContain("rediscovering");
  });

  it("does not mistake an ordinary query failure for a stale credential", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();
    const failure = new OpenSearchRequestError("HTTP 500 shard failure", { status: 500 });

    await expect(
      withOpenSearchClient(BASE_OPTS, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(core.deleteCachedCredential).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not retry a freshly discovered credential that gets rejected — that is a real error", async () => {
    stubDiscovery();
    const rejection = new OpenSearchRequestError("HTTP 401", { status: 401 });
    const work = vi.fn(async () => {
      throw rejection;
    });

    await expect(withOpenSearchClient(BASE_OPTS, work)).rejects.toBe(rejection);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("reports a failed cache write on stderr but still runs the command", async () => {
    stubDiscovery();
    vi.mocked(core.writeCachedCredential).mockRejectedValue(new Error("EROFS: read-only file system"));

    await expect(withOpenSearchClient(BASE_OPTS, async () => "ok")).resolves.toBe("ok");

    expect(stderr).toContain("could not save the dashboards credential for reuse");
    expect(stderr).toContain("EROFS");
  });

  it("names the cached source only under --verbose, so a hit is otherwise silent", async () => {
    vi.mocked(core.readCachedCredential).mockResolvedValue(CACHED);
    stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    expect(stderr).toBe("");

    await withOpenSearchClient({ ...BASE_OPTS, verbose: true }, async () => undefined);
    expect(stderr).toContain("using cached dashboards credential from binding:legacy-app");
    expect(stderr).not.toContain("from-cache");
  });
});
