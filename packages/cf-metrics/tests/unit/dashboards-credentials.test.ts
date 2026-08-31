import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
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
function stubCf(bindings: readonly FakeBinding[], opts: { totalPages?: number; delays?: Record<string, number> } = {}): void {
  vi.spyOn(cf, "withCfSession").mockImplementation(async (work) => await work({ cfHome: "/tmp/fake" }));
  vi.spyOn(cf, "cfApi").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfAuth").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfTargetSpace").mockResolvedValue(undefined);
  vi.spyOn(cf, "cfServiceGuid").mockResolvedValue(INSTANCE_GUID);
  vi.spyOn(cf, "cfCurl").mockImplementation(async (path: string) => {
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
      throw new Error(`details request failed for ${guid}`);
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
