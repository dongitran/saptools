import * as core from "@saptools/core";
import type { CloudLoggingCfExecutor } from "@saptools/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { isCleanDiscoveryMiss, withOpenSearchClient } from "../../src/cli/client-bootstrap.js";
import { cloudLoggingExecutor } from "../../src/cli/cloud-logging-executor.js";
import * as samlToggle from "../../src/saml-toggle.js";
import type { DashboardsCredential, ResolvedTarget } from "../../src/types.js";

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

let stderr: string;

beforeEach(() => {
  stderr = "";
  // The developer machine running this suite may well have real SAP
  // credentials exported; blank both so every test's "not set" shape is what's
  // actually exercised unless a test deliberately overrides one.
  vi.stubEnv("SAP_EMAIL", "");
  vi.stubEnv("SAP_PASSWORD", "");
  vi.spyOn(core, "resolveTarget").mockResolvedValue(TARGET);
  vi.spyOn(core, "printResolvedTarget").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  // Cache infrastructure defaults to a clean miss for every test in this
  // file — the cache's own behavior (hits, pin-matching, 401/403 retry,
  // CF_OTEL_CREDENTIAL_CACHE=0) is covered separately in
  // cli-client-bootstrap-credential-cache.test.ts, which cf-otel never had
  // before this migration.
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

describe("withOpenSearchClient", () => {
  it("resolves target, hands the caller a working client, and remembers the discovered credential", async () => {
    const discover = stubDiscovery();

    const result = await withOpenSearchClient(BASE_OPTS, async (client) => {
      expect(client).toBeDefined();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(core.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET }, DISCOVERED, { cliName: "cf-otel" });
  });

  it("lets a discovery failure propagate unchanged when minting is not allowed", async () => {
    const failure = new Error("could not resolve dashboards credentials");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(failure);

    await expect(withOpenSearchClient(BASE_OPTS, async () => "unreachable")).rejects.toBe(failure);
    expect(core.writeCachedCredential).not.toHaveBeenCalled();
  });

  it("forwards optional serviceInstance/serviceKey/fallbackBindingApp only when provided", async () => {
    const discover = stubDiscovery();

    await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", serviceKey: ["key1"], fallbackBindingApp: ["app1"] },
      async () => undefined,
    );

    expect(discover).toHaveBeenCalledWith(
      TARGET,
      undefined,
      expect.objectContaining({ serviceInstance: "cloud-logging", serviceKeyNames: ["key1"], fallbackBindingApps: ["app1"] }),
      cloudLoggingExecutor,
    );
    expect(core.readCachedCredential).toHaveBeenCalledWith({ target: TARGET, instanceSelector: "cloud-logging" }, { cliName: "cf-otel" });
  });

  it("passes SAP_EMAIL/SAP_PASSWORD through to discovery when they are set, for the isolated-login path", async () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    const discover = stubDiscovery();

    await withOpenSearchClient(BASE_OPTS, async () => undefined);

    expect(discover).toHaveBeenCalledWith(TARGET, { email: "user@example.com", password: "pw" }, expect.anything(), cloudLoggingExecutor);
  });

  it("never asks the shared discovery to mint on its own — cf-otel's own saml-toggle.ts still owns that", async () => {
    const discover = stubDiscovery();

    await withOpenSearchClient({ ...BASE_OPTS, allowMintCredential: true }, async () => undefined);

    expect(discover).toHaveBeenCalledWith(TARGET, undefined, expect.objectContaining({ allowMintCredential: false }), cloudLoggingExecutor);
  });
});

/**
 * `@saptools/core`'s shared `discoverDashboardsCredential` deliberately does
 * not implement minting — it throws instead of minting when
 * `allowMintCredential` is set and nothing else worked (see its own doc
 * comment). `withOpenSearchClient` must catch exactly that failure and fall
 * back to cf-otel's own `saml-toggle.ts`, or `--allow-mint-credential` would
 * silently stop minting anything after this migration.
 */
describe("withOpenSearchClient's mint-as-last-resort fallback", () => {
  it("mints via the matching ambient session when ordinary discovery finds nothing", async () => {
    stubDiscovery(); // overridden below to reject instead
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error('Could not resolve Cloud Logging dashboards credentials for instance "cloud-logging". Tried:\n  - nothing worked'),
    );
    vi.spyOn(cloudLoggingExecutor, "readCurrentCfTarget").mockResolvedValue({
      apiEndpoint: TARGET.apiEndpoint,
      orgName: TARGET.org,
      spaceName: TARGET.space,
    });
    const minted: DashboardsCredential = { ...DISCOVERED, source: "minted:cf-otel-ab12cd34" };
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential").mockResolvedValue(minted);

    const result = await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", allowMintCredential: true, verbose: true },
      async (client) => {
        expect(client).toBeDefined();
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(mint).toHaveBeenCalledWith("cloud-logging", cloudLoggingExecutor.ambientContext, {
      confirmDisruptive: true,
      report: expect.any(Function),
    });
    expect(core.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET, instanceSelector: "cloud-logging" }, minted, {
      cliName: "cf-otel",
    });
    expect(stderr).toContain("reusing the current 'cf target' session for o/s to mint a credential");
  });

  /**
   * `ambientSessionMatches` only compares the `cf target` *descriptor*
   * (endpoint/org/space) — a session whose token has actually expired still
   * "matches" it. This proves the ambient mint attempt's own auth failure
   * falls back to the isolated SAP-credentials login instead of propagating
   * (or, worse, silently retrying against the same dead session) — mirroring
   * the resilience the shared discovery's own `tryAmbientSession` already has.
   */
  it("falls back to an isolated login when the ambient session's mint attempt itself hits an auth failure", async () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error('Could not resolve Cloud Logging dashboards credentials for instance "cloud-logging". Tried:\n  - nothing worked'),
    );
    vi.spyOn(cloudLoggingExecutor, "readCurrentCfTarget").mockResolvedValue({
      apiEndpoint: TARGET.apiEndpoint,
      orgName: TARGET.org,
      spaceName: TARGET.space,
    });
    const authFailure = new Error("token expired");
    vi.spyOn(cloudLoggingExecutor, "isCfAuthFailure").mockImplementation((error) => error === authFailure);
    const fakeCtx = { cfHome: "/tmp/fake-cf-home" };
    vi.spyOn(cloudLoggingExecutor, "withCfSession").mockImplementation(async (work) => await work(fakeCtx as never));
    vi.spyOn(cloudLoggingExecutor, "cfApi").mockResolvedValue(undefined);
    vi.spyOn(cloudLoggingExecutor, "cfAuth").mockResolvedValue(undefined);
    vi.spyOn(cloudLoggingExecutor, "cfTargetSpace").mockResolvedValue(undefined);
    const minted: DashboardsCredential = { ...DISCOVERED, source: "minted:cf-otel-ef78ab90" };
    const mint = vi
      .spyOn(samlToggle, "mintDashboardsCredential")
      .mockRejectedValueOnce(authFailure)
      .mockResolvedValueOnce(minted);

    const result = await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", allowMintCredential: true, verbose: true },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(mint).toHaveBeenCalledTimes(2);
    // First attempt: the ambient session, which fails.
    expect(mint).toHaveBeenNthCalledWith(1, "cloud-logging", cloudLoggingExecutor.ambientContext, {
      confirmDisruptive: true,
      report: expect.any(Function),
    });
    // Second attempt: the isolated session, which succeeds — never the same
    // (already-proven-dead) ambient context retried a second time.
    expect(mint).toHaveBeenNthCalledWith(2, "cloud-logging", fakeCtx, { confirmDisruptive: true, report: expect.any(Function) });
    expect(core.writeCachedCredential).toHaveBeenCalledWith({ target: TARGET, instanceSelector: "cloud-logging" }, minted, {
      cliName: "cf-otel",
    });
    expect(stderr).toContain("the current 'cf target' session was rejected while minting (token expired); falling back to an isolated login");
  });

  /**
   * The symmetrical counterpart of the test above: the ambient-session
   * fallback exists specifically for *auth* failures — a genuinely different
   * problem (e.g. the instance was deleted, or a network blip) must still
   * propagate immediately rather than being masked by an isolated-login retry
   * that has no chance of fixing it.
   */
  it("propagates the ambient mint attempt's failure immediately when it is not an auth failure", async () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error('Could not resolve Cloud Logging dashboards credentials for instance "cloud-logging". Tried:\n  - nothing worked'),
    );
    vi.spyOn(cloudLoggingExecutor, "readCurrentCfTarget").mockResolvedValue({
      apiEndpoint: TARGET.apiEndpoint,
      orgName: TARGET.org,
      spaceName: TARGET.space,
    });
    vi.spyOn(cloudLoggingExecutor, "isCfAuthFailure").mockReturnValue(false);
    const unrelatedFailure = new Error('"cloud-logging" reported a failed update status: failed');
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential").mockRejectedValue(unrelatedFailure);

    await expect(
      withOpenSearchClient({ ...BASE_OPTS, serviceInstance: "cloud-logging", allowMintCredential: true }, async () => "unreachable"),
    ).rejects.toBe(unrelatedFailure);
    // Never retried in an isolated session — that would not fix an unrelated failure.
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("refuses to mint when no ambient session matches and SAP_EMAIL/SAP_PASSWORD are unset", async () => {
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error('Could not resolve Cloud Logging dashboards credentials for instance "cloud-logging". Tried:\n  - nothing worked'),
    );
    vi.spyOn(cloudLoggingExecutor, "readCurrentCfTarget").mockResolvedValue(undefined);
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential");

    await expect(
      withOpenSearchClient({ ...BASE_OPTS, serviceInstance: "cloud-logging", allowMintCredential: true }, async () => "unreachable"),
    ).rejects.toThrow(/SAP_EMAIL and SAP_PASSWORD/);
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints in an isolated CF_HOME when no ambient session matches, using SAP_EMAIL/SAP_PASSWORD", async () => {
    vi.stubEnv("SAP_EMAIL", "user@example.com");
    vi.stubEnv("SAP_PASSWORD", "pw");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(
      new Error('Could not resolve Cloud Logging dashboards credentials for instance "cloud-logging". Tried:\n  - nothing worked'),
    );
    vi.spyOn(cloudLoggingExecutor, "readCurrentCfTarget").mockResolvedValue(undefined);
    const fakeCtx = { cfHome: "/tmp/fake-cf-home" };
    vi.spyOn(cloudLoggingExecutor, "withCfSession").mockImplementation(async (work) => await work(fakeCtx as never));
    const cfApi = vi.spyOn(cloudLoggingExecutor, "cfApi").mockResolvedValue(undefined);
    const cfAuth = vi.spyOn(cloudLoggingExecutor, "cfAuth").mockResolvedValue(undefined);
    const cfTargetSpace = vi.spyOn(cloudLoggingExecutor, "cfTargetSpace").mockResolvedValue(undefined);
    const minted: DashboardsCredential = { ...DISCOVERED, source: "minted:cf-otel-cd34ef56" };
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential").mockResolvedValue(minted);

    const result = await withOpenSearchClient(
      { ...BASE_OPTS, serviceInstance: "cloud-logging", allowMintCredential: true },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(cfApi).toHaveBeenCalledWith(TARGET.apiEndpoint, fakeCtx);
    expect(cfAuth).toHaveBeenCalledWith("user@example.com", "pw", fakeCtx);
    expect(cfTargetSpace).toHaveBeenCalledWith(TARGET.org, TARGET.space, fakeCtx);
    expect(mint).toHaveBeenCalledWith("cloud-logging", fakeCtx, { confirmDisruptive: true, report: expect.any(Function) });
  });

  it("does not mint at all when --allow-mint-credential is absent — the original failure propagates", async () => {
    const failure = new Error("could not resolve dashboards credentials");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(failure);
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential");

    await expect(withOpenSearchClient(BASE_OPTS, async () => "unreachable")).rejects.toBe(failure);
    expect(mint).not.toHaveBeenCalled();
  });

  /**
   * Minting is disruptive (it disables SAML on a shared instance), so it must
   * only ever fire on the exact "tried every binding, nothing worked" miss —
   * never as a side effect of an unrelated failure such as a `cf curl` error
   * listing bindings, or a bad isolated login. The pre-migration local
   * discovery could only ever reach its own mint branch after a clean miss;
   * this pins that `withOpenSearchClient` does not widen that condition now
   * that the miss and the mint fallback live in two different functions.
   */
  it("does not mint on an unrelated discovery failure, even with --allow-mint-credential set", async () => {
    const transientFailure = new Error("cf curl /v3/service_credential_bindings failed: dial tcp: connection refused");
    vi.spyOn(core, "discoverDashboardsCredential").mockRejectedValue(transientFailure);
    const mint = vi.spyOn(samlToggle, "mintDashboardsCredential");

    await expect(
      withOpenSearchClient({ ...BASE_OPTS, allowMintCredential: true }, async () => "unreachable"),
    ).rejects.toBe(transientFailure);
    expect(mint).not.toHaveBeenCalled();
  });

  /**
   * `isCleanDiscoveryMiss` matches on a hardcoded prefix of `@saptools/core`'s
   * error text. Every other test in this file mocks `discoverDashboardsCredential`
   * outright, so none of them would notice if that package's wording ever
   * drifted — `isCleanDiscoveryMiss` would then silently stop matching
   * anything, and `--allow-mint-credential` would become a silent no-op with
   * no test failure to flag it. This test drives the REAL, unmocked
   * `discoverDashboardsCredential` from `@saptools/core` — not a hand-typed
   * copy of its message — through a fake executor that genuinely finds zero
   * credential bindings, catches the real rejection it throws, and asserts
   * `isCleanDiscoveryMiss` recognizes that real error directly.
   */
  it("isCleanDiscoveryMiss matches the real error @saptools/core's discoverDashboardsCredential throws on a genuine clean miss", async () => {
    const fakeExecutor: CloudLoggingCfExecutor = {
      ambientContext: {},
      cfCurl: async () => JSON.stringify({ resources: [], pagination: { total_pages: 1 } }),
      cfServiceGuid: async () => "fake-guid",
      cfSpaceGuid: async () => "fake-space-guid",
      isCfAuthFailure: () => false,
      withCfSession: async (work) => await work({}),
      cfApi: async () => undefined,
      cfAuth: async () => undefined,
      cfTargetSpace: async () => undefined,
      readCurrentCfTarget: async () => ({
        apiEndpoint: TARGET.apiEndpoint,
        orgName: TARGET.org,
        spaceName: TARGET.space,
      }),
      getApiEndpointForRegion: () => undefined,
    };

    let caught: unknown;
    try {
      // Real function, real (fake-executor-driven) rejection — `core` here is
      // not spied on in this test, so this is not the module-mocked stand-in
      // every other test in this file uses.
      await core.discoverDashboardsCredential(
        TARGET,
        undefined,
        { serviceInstance: "cloud-logging", allowMintCredential: false, verbose: false },
        fakeExecutor,
      );
      throw new Error("expected discoverDashboardsCredential to reject on a zero-binding instance");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Could not resolve Cloud Logging dashboards credentials");
    expect(isCleanDiscoveryMiss(caught)).toBe(true);
  });
});
