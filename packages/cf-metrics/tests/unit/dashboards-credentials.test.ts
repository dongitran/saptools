import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import type { CurrentCfTarget } from "../../src/cf.js";
import { discoverDashboardsCredential } from "../../src/dashboards-credentials.js";
import { CredentialsNotFoundError } from "../../src/errors.js";
import * as samlToggle from "../../src/saml-toggle.js";
import type { DashboardsCredential, ResolvedTarget } from "../../src/types.js";

vi.mock("../../src/saml-toggle.js", () => ({ mintDashboardsCredential: vi.fn() }));

const TARGET: ResolvedTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  region: "eu10",
  org: "example-org",
  space: "space-demo",
  selectorSource: "explicit",
  regionConfirmed: true,
};
const SAP = { email: "user@example.com", password: "sap-password" };
const INSTANCE_GUID = "instance-guid-1";

interface FakeBinding {
  readonly guid: string;
  readonly type: "key" | "app";
  /** Service-key name; app bindings are named through the `include=app` sidecar instead. */
  readonly name?: string;
  readonly appGuid?: string;
  readonly appName?: string;
  readonly createdAt: string;
  /** `undefined` means the binding exists but carries no dashboards credentials (bound after SAML). */
  readonly password?: string;
  /** Makes this binding's `/details` request reject, to exercise the per-candidate error path. */
  readonly detailsFails?: boolean;
  /** The message that rejection carries; defaults to a generic per-request failure. */
  readonly detailsError?: string;
  /** Which listing page this binding appears on, 1-based. */
  readonly page?: number;
}

function listingFor(bindings: readonly FakeBinding[], page: number, totalPages: number): string {
  const onPage = bindings.filter((b) => (b.page ?? 1) === page);
  return JSON.stringify({
    pagination: { total_results: bindings.length, total_pages: totalPages },
    resources: onPage.map((b) => ({
      guid: b.guid,
      type: b.type,
      name: b.name ?? null,
      created_at: b.createdAt,
      relationships: b.appGuid === undefined ? {} : { app: { data: { guid: b.appGuid } } },
    })),
    included: {
      apps: onPage
        .filter((b) => b.appGuid !== undefined && b.appName !== undefined)
        .map((b) => ({ guid: b.appGuid, name: b.appName })),
    },
  });
}

function detailsFor(binding: FakeBinding): string {
  const credentials: Record<string, string> = {
    "dashboards-endpoint": "https://dash.example.com",
    "ingest-username": "ingest-user",
  };
  if (binding.password !== undefined) {
    credentials["dashboards-username"] = `user-${binding.guid}`;
    credentials["dashboards-password"] = binding.password;
  }
  return JSON.stringify({ credentials });
}

/**
 * Stub the whole CF layer: an isolated session, a resolved instance GUID, and a
 * `cf curl` that answers the two v3 endpoints the discovery path uses.
 * `delays` lets a test make a *later* candidate respond first, which is how the
 * "priority order, not response order" guarantee gets exercised.
 */
/** The v3 service-instances listing the auto-discovery path reads: one cloud-logging instance in the space. */
function instancesListing(): string {
  return JSON.stringify({
    pagination: { total_results: 1, total_pages: 1 },
    resources: [
      { guid: INSTANCE_GUID, name: "cloud-logging", type: "managed", relationships: { service_plan: { data: { guid: "plan-1" } } } },
    ],
    included: {
      service_plans: [{ guid: "plan-1", name: "large", relationships: { service_offering: { data: { guid: "offering-1" } } } }],
      service_offerings: [{ guid: "offering-1", name: "cloud-logging" }],
    },
  });
}

function stubCf(bindings: readonly FakeBinding[], opts: { totalPages?: number; delays?: Record<string, number> } = {}): void {
  // No ambient session by default, so every existing expectation below runs
  // through the isolated login exactly as before; the session tests override it.
  vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(undefined);
  vi.spyOn(cf, "withCfSession").mockImplementation(async (work) => await work({ cfHome: "/tmp/fake" }));
  vi.spyOn(cf, "cfApi").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfAuth").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfTargetSpace").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfServiceGuid").mockResolvedValue(INSTANCE_GUID);
  vi.spyOn(cf, "cfSpaceGuid").mockResolvedValue("1af3e621-59f5-439c-9838-4508ae8be431");
  vi.spyOn(cf, "cfCurl").mockImplementation(async (path: string) => {
    if (path.startsWith("/v3/service_instances?")) {
      return instancesListing();
    }
    const detailsMatch = /service_credential_bindings\/([^/]+)\/details/.exec(path);
    if (detailsMatch === null) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
      return listingFor(bindings, page, opts.totalPages ?? 1);
    }
    const guid = detailsMatch[1] ?? "";
    const binding = bindings.find((b) => b.guid === guid);
    if (binding === undefined) {
      throw new Error(`unexpected binding ${guid}`);
    }
    if (binding.detailsFails === true) {
      throw new Error(binding.detailsError ?? `details request failed for ${guid}`);
    }
    const delay = opts.delays?.[guid];
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return detailsFor(binding);
  });
}

function discover(overrides: Partial<Parameters<typeof discoverDashboardsCredential>[2]> = {}): Promise<DashboardsCredential> {
  return discoverDashboardsCredential(TARGET, SAP, {
    serviceInstance: "cloud-logging",
    allowMintCredential: false,
    verbose: false,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const MATCHING_SESSION: CurrentCfTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  orgName: "example-org",
  spaceName: "space-demo",
  regionKey: "eu10",
};

const NOT_LOGGED_IN = "cf service cloud-logging --guid failed: FAILED\nNot logged in. Use 'cf login' or 'cf login --sso' to log in.";

describe("session selection", () => {
  it("reuses a matching 'cf target' session: no isolated login, and no SAP credentials needed", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(MATCHING_SESSION);

    const credential = await discoverDashboardsCredential(TARGET, undefined, {
      serviceInstance: "cloud-logging",
      allowMintCredential: false,
      verbose: false,
    });

    expect(credential).toMatchObject({ password: "key-secret", instance: "cloud-logging" });
    expect(cf.withCfSession).not.toHaveBeenCalled();
    expect(cf.cfApi).not.toHaveBeenCalled();
    expect(cf.cfAuth).not.toHaveBeenCalled();
    expect(cf.cfTargetSpace).not.toHaveBeenCalled();
    // Every command ran in the ambient context: no temporary CF_HOME anywhere.
    for (const call of vi.mocked(cf.cfCurl).mock.calls) {
      expect(call[1]).toEqual({});
    }
  });

  it("reports the instance it resolved to, so the credential can be cached against it", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);

    await expect(discover()).resolves.toMatchObject({ instance: "cloud-logging", source: "service-key:logging-key" });
  });

  it("auto-discovers the instance through the v3 listing when --service-instance is omitted", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);

    const credential = await discoverDashboardsCredential(TARGET, SAP, { allowMintCredential: false, verbose: false });

    expect(credential.instance).toBe("cloud-logging");
    expect(cf.cfSpaceGuid).toHaveBeenCalledWith("space-demo", expect.anything());
    expect(cf.cfServiceGuid).not.toHaveBeenCalled();
  });

  it("falls back to an isolated login when the matching session turns out to be dead", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(MATCHING_SESSION);
    vi.spyOn(cf, "cfServiceGuid").mockImplementation(async (_instance, ctx) => {
      if (ctx.cfHome === undefined) {
        throw new Error(NOT_LOGGED_IN);
      }
      return INSTANCE_GUID;
    });

    await expect(discover()).resolves.toMatchObject({ source: "service-key:logging-key" });

    expect(cf.cfApi).toHaveBeenCalledTimes(1);
    expect(cf.cfAuth).toHaveBeenCalledTimes(1);
    expect(cf.cfTargetSpace).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on an ordinary failure inside the ambient session", async () => {
    stubCf([]);
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(MATCHING_SESSION);
    vi.spyOn(cf, "cfServiceGuid").mockRejectedValue(new Error("cf service cloud-logging --guid failed: Service instance 'cloud-logging' not found."));

    await expect(discover()).rejects.toThrow(/Service instance 'cloud-logging' not found/);
    expect(cf.cfApi).not.toHaveBeenCalled();
  });

  it("explains what to do when no session is active and SAP credentials are absent", async () => {
    stubCf([]);

    const error = await discoverDashboardsCredential(TARGET, undefined, {
      serviceInstance: "cloud-logging",
      allowMintCredential: false,
      verbose: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialsNotFoundError);
    expect((error as Error).message).toContain("no 'cf target' session is active");
    expect((error as Error).message).toContain("SAP_EMAIL and SAP_PASSWORD");
    expect((error as Error).message).toContain("cf target -o example-org -s space-demo");
    expect(cf.cfApi).not.toHaveBeenCalled();
  });

  it("names the session it refused to reuse when one is active but points elsewhere", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue({ ...MATCHING_SESSION, orgName: "other-org", spaceName: "other-space" });

    await expect(
      discoverDashboardsCredential(TARGET, undefined, { serviceInstance: "cloud-logging", allowMintCredential: false, verbose: false }),
    ).rejects.toThrow(/points at other-org\/other-space/);

    // With SAP credentials the same mismatch simply takes the isolated path.
    await expect(discover()).resolves.toMatchObject({ password: "key-secret" });
    expect(cf.cfApi).toHaveBeenCalledTimes(1);
  });

  it("rejects the result when the ambient target changed while discovery was running", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);
    vi.spyOn(cf, "readCurrentCfTarget")
      .mockResolvedValueOnce(MATCHING_SESSION)
      .mockResolvedValueOnce({ ...MATCHING_SESSION, spaceName: "other-space" });

    await expect(discover()).rejects.toThrow(/changed while cf-metrics was reading it/);
    expect(cf.cfApi).not.toHaveBeenCalled();
  });

  it("stops probing on a dead session instead of blaming every binding for it", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "first-key", createdAt: "2026-01-02T00:00:00Z", detailsFails: true, detailsError: NOT_LOGGED_IN },
      { guid: "k2", type: "key", name: "second-key", createdAt: "2026-01-01T00:00:00Z", password: "would-work" },
    ]);

    const error = await discover().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(CredentialsNotFoundError);
    expect((error as Error).message).toContain("Not logged in");
  });
});

describe("discoverDashboardsCredential", () => {
  it("resolves from a service key that carries dashboards credentials", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "key-secret" }]);

    const credential = await discover();

    expect(credential.password).toBe("key-secret");
    expect(credential.source).toBe("service-key:logging-key");
    expect(credential.dashboardsEndpoint).toBe("https://dash.example.com");
  });

  it("skips a candidate whose details carry no dashboards username/password", async () => {
    // The newest key is tried first and has no credentials, so resolution must
    // continue to the older one rather than give up.
    stubCf([
      { guid: "k1", type: "key", name: "post-saml-key", createdAt: "2026-06-01T00:00:00Z" },
      { guid: "k2", type: "key", name: "usable-key", createdAt: "2026-01-02T00:00:00Z", password: "second" },
    ]);

    await expect(discover()).resolves.toMatchObject({ password: "second", source: "service-key:usable-key" });
  });

  it("falls back to an app binding when no service key works", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "useless-key", createdAt: "2026-01-01T00:00:00Z" },
      { guid: "b1", type: "app", appGuid: "a1", appName: "worker-app", createdAt: "2026-01-05T00:00:00Z", password: "from-binding" },
    ]);

    await expect(discover()).resolves.toMatchObject({ password: "from-binding", source: "binding:worker-app" });
  });

  /**
   * Ordering is the whole reason the previous implementation was slow and
   * unpredictable: it scanned apps in whatever order the platform listed them.
   */
  it("prefers a service key over an app binding when both would work", async () => {
    stubCf([
      { guid: "b1", type: "app", appGuid: "a1", appName: "worker-app", createdAt: "2020-01-01T00:00:00Z", password: "from-binding" },
      { guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "from-key" },
    ]);

    await expect(discover()).resolves.toMatchObject({ password: "from-key", source: "service-key:logging-key" });
  });

  /**
   * Keys keep the prior newest-first convention: unlike app bindings, they are
   * created deliberately, and one minted during an intentional SAML-off window
   * can be newer than a key that has no credentials — so age predicts nothing.
   */
  it("tries the newest service key first", async () => {
    stubCf([
      { guid: "k-old", type: "key", name: "old-key", createdAt: "2026-01-01T00:00:00Z", password: "older" },
      { guid: "k-new", type: "key", name: "new-key", createdAt: "2026-06-01T00:00:00Z", password: "newer" },
    ]);

    await expect(discover()).resolves.toMatchObject({ source: "service-key:new-key" });
  });

  it("tries the oldest app binding first, since only pre-SAML bindings keep credentials", async () => {
    stubCf([
      { guid: "b-new", type: "app", appGuid: "a2", appName: "new-app", createdAt: "2026-08-31T00:00:00Z", password: "newer" },
      { guid: "b-old", type: "app", appGuid: "a1", appName: "old-app", createdAt: "2026-07-21T00:00:00Z", password: "older" },
    ]);

    await expect(discover()).resolves.toMatchObject({ source: "binding:old-app" });
  });

  /**
   * Candidates are probed concurrently, so the winner must be chosen by
   * priority rather than by whichever request happens to return first —
   * otherwise the credential used would vary with network timing.
   */
  it("returns the highest-priority hit even when a lower-priority one responds first", async () => {
    stubCf(
      [
        { guid: "k-slow", type: "key", name: "slow-key", createdAt: "2026-06-01T00:00:00Z", password: "slow-but-preferred" },
        { guid: "k-fast", type: "key", name: "fast-key", createdAt: "2026-01-02T00:00:00Z", password: "fast-but-second" },
      ],
      { delays: { "k-slow": 25 } },
    );

    await expect(discover()).resolves.toMatchObject({ password: "slow-but-preferred" });
  });

  it("records a failed details request and keeps probing the remaining candidates", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "broken-key", createdAt: "2026-01-01T00:00:00Z", detailsFails: true },
      { guid: "k2", type: "key", name: "good-key", createdAt: "2026-01-02T00:00:00Z", password: "recovered" },
    ]);

    await expect(discover()).resolves.toMatchObject({ password: "recovered" });
  });

  it("walks every page of the bindings listing", async () => {
    stubCf(
      [
        { guid: "k1", type: "key", name: "page-one-key", createdAt: "2026-01-01T00:00:00Z", page: 1 },
        { guid: "k2", type: "key", name: "page-two-key", createdAt: "2026-01-02T00:00:00Z", password: "on-page-two", page: 2 },
      ],
      { totalPages: 2 },
    );

    await expect(discover()).resolves.toMatchObject({ password: "on-page-two" });
  });

  it("honours --service-key by trying only the named keys", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "wanted", createdAt: "2026-01-02T00:00:00Z", password: "wanted-secret" },
      { guid: "k2", type: "key", name: "ignored", createdAt: "2026-01-01T00:00:00Z", password: "ignored-secret" },
    ]);

    await expect(discover({ serviceKeyNames: ["wanted"] })).resolves.toMatchObject({ password: "wanted-secret" });
  });

  it("honours --fallback-binding-app by trying only the named apps", async () => {
    stubCf([
      { guid: "b1", type: "app", appGuid: "a1", appName: "ignored-app", createdAt: "2026-01-01T00:00:00Z", password: "ignored" },
      { guid: "b2", type: "app", appGuid: "a2", appName: "wanted-app", createdAt: "2026-01-02T00:00:00Z", password: "wanted" },
    ]);

    await expect(discover({ fallbackBindingApps: ["wanted-app"] })).resolves.toMatchObject({ password: "wanted" });
  });

  it("names every attempted candidate when nothing works and minting is not allowed", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "dud-key", createdAt: "2026-01-01T00:00:00Z" },
      { guid: "b1", type: "app", appGuid: "a1", appName: "dud-app", createdAt: "2026-01-02T00:00:00Z" },
    ]);

    const error = await discover().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialsNotFoundError);
    const message = (error as Error).message;
    expect(message).toContain('service key "dud-key"');
    expect(message).toContain('app binding "dud-app"');
    expect(message).toContain("--allow-mint-credential");
  });

  it("explains an instance that has no bindings at all", async () => {
    stubCf([]);

    await expect(discover()).rejects.toThrow(/no service keys or app bindings/);
  });

  /**
   * "Nothing is bound" and "your filters excluded everything" send the reader
   * after completely different problems, so the message must tell them apart.
   */
  it("says so explicitly when filters excluded every existing binding", async () => {
    stubCf([
      { guid: "k1", type: "key", name: "real-key", createdAt: "2026-01-01T00:00:00Z", password: "secret" },
      { guid: "b1", type: "app", appGuid: "a1", appName: "real-app", createdAt: "2026-01-02T00:00:00Z", password: "secret" },
    ]);

    const error = await discover({ serviceKeyNames: ["absent"], fallbackBindingApps: ["absent"] }).catch((e: unknown) => e);

    expect((error as Error).message).toContain("were excluded by --service-key/--fallback-binding-app");
    expect((error as Error).message).not.toContain("no service keys or app bindings");
  });

  it("mints only when --allow-mint-credential is set", async () => {
    stubCf([{ guid: "k1", type: "key", name: "dud-key", createdAt: "2026-01-01T00:00:00Z" }]);
    const minted: DashboardsCredential = {
      dashboardsEndpoint: "https://dash.example.com",
      username: "minted",
      password: "minted-secret",
      source: "minted:new-key",
      instance: "cloud-logging",
    };
    vi.mocked(samlToggle.mintDashboardsCredential).mockResolvedValue(minted);

    await expect(discover({ allowMintCredential: true })).resolves.toBe(minted);
    expect(samlToggle.mintDashboardsCredential).toHaveBeenCalledOnce();
  });

  it("never mints when --allow-mint-credential is absent", async () => {
    stubCf([{ guid: "k1", type: "key", name: "dud-key", createdAt: "2026-01-01T00:00:00Z" }]);

    await expect(discover()).rejects.toBeInstanceOf(CredentialsNotFoundError);
    expect(samlToggle.mintDashboardsCredential).not.toHaveBeenCalled();
  });

  it("never writes the resolved password to stdout or stderr, even with --verbose", async () => {
    stubCf([{ guid: "k1", type: "key", name: "logging-key", createdAt: "2026-01-01T00:00:00Z", password: "super-secret-password" }]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await discover({ verbose: true });

    const output = [...stderrSpy.mock.calls, ...stdoutSpy.mock.calls].map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("super-secret-password");
  });
});
