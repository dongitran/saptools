import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { withOpenSearchClient } from "../../src/cli/client-bootstrap.js";
import * as credentialCache from "../../src/credential-cache.js";
import * as dashboardsCredentials from "../../src/dashboards-credentials.js";
import { CfMetricsError, CredentialsNotFoundError } from "../../src/errors.js";
import * as target from "../../src/target.js";
import type { DashboardsCredential, ResolvedTarget } from "../../src/types.js";

vi.mock("../../src/credential-cache.js", () => ({
  credentialCacheOptionsFromEnv: vi.fn(() => ({})),
  readCachedCredential: vi.fn(),
  writeCachedCredential: vi.fn(),
  deleteCachedCredential: vi.fn(),
}));

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
  refreshCredential: false,
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
  vi.spyOn(target, "resolveTarget").mockResolvedValue(TARGET);
  vi.spyOn(target, "printResolvedTarget").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(undefined);
  vi.mocked(credentialCache.writeCachedCredential).mockResolvedValue(undefined);
  vi.mocked(credentialCache.deleteCachedCredential).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(credentialCache.readCachedCredential).mockReset();
  vi.mocked(credentialCache.writeCachedCredential).mockReset();
  vi.mocked(credentialCache.deleteCachedCredential).mockReset();
});

function stubDiscovery(credential: DashboardsCredential = DISCOVERED): MockInstance<typeof dashboardsCredentials.discoverDashboardsCredential> {
  return vi.spyOn(dashboardsCredentials, "discoverDashboardsCredential").mockResolvedValue(credential);
}

describe("withOpenSearchClient", () => {
  it("discovers a credential on a cache miss, hands the caller a client, and remembers the result", async () => {
    const discover = stubDiscovery();

    const result = await withOpenSearchClient(BASE_OPTS, async (client) => {
      expect(client).toBeDefined();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(credentialCache.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET }, DISCOVERED, {});
  });

  it("uses a cached credential without touching Cloud Foundry at all", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await expect(withOpenSearchClient(BASE_OPTS, async () => "ok")).resolves.toBe("ok");

    expect(discover).not.toHaveBeenCalled();
    expect(credentialCache.writeCachedCredential).not.toHaveBeenCalled();
  });

  it("keys the cache by --service-instance when one is given", async () => {
    stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceInstance: "cloud-logging" }, async () => undefined);

    expect(credentialCache.readCachedCredential).toHaveBeenCalledWith({ target: TARGET, instanceSelector: "cloud-logging" }, {});
    expect(credentialCache.writeCachedCredential).toHaveBeenCalledWith(
      { target: TARGET, instanceSelector: "cloud-logging" },
      DISCOVERED,
      {},
    );
  });

  it("--refresh-credential skips the cached entry and replaces it with a fresh discovery", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, refreshCredential: true }, async () => undefined);

    expect(credentialCache.readCachedCredential).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(credentialCache.writeCachedCredential).toHaveBeenCalledTimes(1);
  });

  it("CF_METRICS_CREDENTIAL_CACHE=0 neither reads nor writes the cache", async () => {
    vi.stubEnv("CF_METRICS_CREDENTIAL_CACHE", "0");
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);

    expect(credentialCache.readCachedCredential).not.toHaveBeenCalled();
    expect(credentialCache.writeCachedCredential).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  /**
   * `--service-key`/`--fallback-binding-app` say which bindings may be used.
   * A cached credential from some other binding is still valid, but it is not
   * what the caller asked for.
   */
  it("treats a cached credential from an unpinned binding as a miss", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, serviceKey: ["key1"] }, async () => undefined);

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("accepts a cached credential whose source matches a pin", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
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
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();
    const passwordsSeen: string[] = [];
    let attempt = 0;
    const work = vi.fn(async (client: unknown) => {
      attempt += 1;
      passwordsSeen.push(String(attempt));
      if (attempt === 1) {
        throw new CfMetricsError("OPENSEARCH_REQUEST_FAILED", "OpenSearch request failed: HTTP 401 Unauthorized", { status: 401 });
      }
      expect(client).toBeDefined();
      return "ok";
    });

    await expect(withOpenSearchClient(BASE_OPTS, work)).resolves.toBe("ok");

    expect(work).toHaveBeenCalledTimes(2);
    expect(credentialCache.deleteCachedCredential).toHaveBeenCalledWith({ target: TARGET }, {});
    expect(discover).toHaveBeenCalledTimes(1);
    expect(credentialCache.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET }, DISCOVERED, {});
    expect(stderr).toContain("cached dashboards credential from binding:legacy-app was rejected");
    expect(stderr).toContain("rediscovering");
  });

  it("does not mistake an ordinary query failure for a stale credential", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    const discover = stubDiscovery();
    const failure = new CfMetricsError("OPENSEARCH_REQUEST_FAILED", "HTTP 500 shard failure", { status: 500 });

    await expect(
      withOpenSearchClient(BASE_OPTS, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(credentialCache.deleteCachedCredential).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not retry a freshly discovered credential that gets rejected — that is a real error", async () => {
    stubDiscovery();
    const rejection = new CfMetricsError("OPENSEARCH_REQUEST_FAILED", "HTTP 401", { status: 401 });
    const work = vi.fn(async () => {
      throw rejection;
    });

    await expect(withOpenSearchClient(BASE_OPTS, work)).rejects.toBe(rejection);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("reports a failed cache write on stderr but still runs the command", async () => {
    stubDiscovery();
    vi.mocked(credentialCache.writeCachedCredential).mockRejectedValue(new Error("EROFS: read-only file system"));

    await expect(withOpenSearchClient(BASE_OPTS, async () => "ok")).resolves.toBe("ok");

    expect(stderr).toContain("could not save the dashboards credential for reuse");
    expect(stderr).toContain("EROFS");
  });

  it("names the cached source only under --verbose, so a hit is otherwise silent", async () => {
    vi.mocked(credentialCache.readCachedCredential).mockResolvedValue(CACHED);
    stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);
    expect(stderr).toBe("");

    await withOpenSearchClient({ ...BASE_OPTS, verbose: true }, async () => undefined);
    expect(stderr).toContain("using cached dashboards credential from binding:legacy-app");
    expect(stderr).not.toContain("from-cache");
  });

  it("lets a discovery failure propagate unchanged", async () => {
    const failure = new CredentialsNotFoundError("nothing worked");
    vi.spyOn(dashboardsCredentials, "discoverDashboardsCredential").mockRejectedValue(failure);

    await expect(withOpenSearchClient(BASE_OPTS, async () => "unreachable")).rejects.toBe(failure);
    expect(credentialCache.writeCachedCredential).not.toHaveBeenCalled();
  });

  it("forwards optional serviceInstance/serviceKey/fallbackBindingApp only when provided", async () => {
    // The developer machine running this suite may well have real SAP
    // credentials exported; blank them so the "not set" shape is what's tested.
    vi.stubEnv("SAP_EMAIL", "");
    vi.stubEnv("SAP_PASSWORD", "");
    const discover = stubDiscovery();

    await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", serviceKey: ["key1"], fallbackBindingApp: ["app1"] },
      async () => undefined,
    );

    expect(discover).toHaveBeenCalledWith(
      TARGET,
      undefined,
      expect.objectContaining({ serviceInstance: "cloud-logging", serviceKeyNames: ["key1"], fallbackBindingApps: ["app1"] }),
    );
  });

  it("passes SAP_EMAIL/SAP_PASSWORD through to discovery when they are set, for the isolated-login path", async () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    const discover = stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);

    expect(discover).toHaveBeenCalledWith(TARGET, { email: "user@example.com", password: "pw" }, expect.anything());
  });
});
