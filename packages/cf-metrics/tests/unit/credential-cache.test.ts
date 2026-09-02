import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCredentialCache,
  credentialCacheOptionsFromEnv,
  deleteCachedCredential,
  listCachedCredentials,
  readCachedCredential,
  writeCachedCredential,
} from "../../src/credential-cache.js";
import type { CredentialCacheKey } from "../../src/credential-cache.js";
import type { DashboardsCredential, ResolvedTarget } from "../../src/types.js";

const TARGET: ResolvedTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  region: "eu10",
  org: "example-org",
  space: "space-demo",
  selectorSource: "explicit",
  regionConfirmed: true,
};

const CREDENTIAL: DashboardsCredential = {
  dashboardsEndpoint: "https://dash.example.com",
  username: "dash-user",
  password: "dash-secret",
  source: "service-key:logging-key",
  instance: "cloud-logging",
};

const NOW = new Date("2026-09-02T10:00:00.000Z");
const AUTO_KEY: CredentialCacheKey = { target: TARGET };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cf-metrics-credential-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env["CF_METRICS_SAPTOOLS_ROOT"];
});

function options(now: Date = NOW): { saptoolsRoot: string; now: () => Date } {
  return { saptoolsRoot: root, now: () => now };
}

describe("credentialCacheOptionsFromEnv", () => {
  it("is empty when the override is unset or blank, and passes the root through when set", () => {
    delete process.env["CF_METRICS_SAPTOOLS_ROOT"];
    expect(credentialCacheOptionsFromEnv()).toEqual({});
    process.env["CF_METRICS_SAPTOOLS_ROOT"] = "  ";
    expect(credentialCacheOptionsFromEnv()).toEqual({});
    process.env["CF_METRICS_SAPTOOLS_ROOT"] = "/tmp/some-root";
    expect(credentialCacheOptionsFromEnv()).toEqual({ saptoolsRoot: "/tmp/some-root" });
  });
});

describe("credential cache", () => {
  it("returns nothing before anything was cached, without creating the file", async () => {
    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
    await expect(stat(join(root, "cf-metrics", "credentials.json"))).rejects.toThrow(/ENOENT/);
  });

  it("round-trips a credential for the same target and auto-discovered instance", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toEqual(CREDENTIAL);
  });

  /**
   * The file holds a real basic-auth password. Whatever the umask, it must end
   * up readable by the owner only, inside a directory nobody else can list —
   * the same protection `~/.cf/config.json` and `~/.saptools/xsuaa-data.json`
   * already get.
   */
  it("keeps the cache file private (0600) inside a private directory (0700)", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    const file = await stat(join(root, "cf-metrics", "credentials.json"));
    const directory = await stat(join(root, "cf-metrics"));
    expect((file.mode & 0o777).toString(8)).toBe("600");
    expect((directory.mode & 0o777).toString(8)).toBe("700");
  });

  it("misses for a different space, org, or API endpoint", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    await expect(readCachedCredential({ target: { ...TARGET, space: "other" } }, options())).resolves.toBeUndefined();
    await expect(readCachedCredential({ target: { ...TARGET, org: "other" } }, options())).resolves.toBeUndefined();
    await expect(
      readCachedCredential({ target: { ...TARGET, apiEndpoint: "https://api.cf.us10.hana.ondemand.com" } }, options()),
    ).resolves.toBeUndefined();
  });

  it("treats endpoint case and a trailing slash as the same target", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    await expect(
      readCachedCredential({ target: { ...TARGET, apiEndpoint: "HTTPS://api.cf.eu10.hana.ondemand.com/" } }, options()),
    ).resolves.toEqual(CREDENTIAL);
  });

  /**
   * `--service-instance X` after an auto-discovered run that resolved to X is
   * the same credential; a different name is not. And an entry pinned to one
   * instance must not answer an auto-discovery request, which might legitimately
   * resolve to another instance in the same space.
   */
  it("matches an explicit --service-instance against the instance the entry resolved to", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    await expect(readCachedCredential({ target: TARGET, instanceSelector: "cloud-logging" }, options())).resolves.toEqual(CREDENTIAL);
    await expect(readCachedCredential({ target: TARGET, instanceSelector: "other-logging" }, options())).resolves.toBeUndefined();
  });

  it("does not let an explicitly pinned entry answer an auto-discovery request", async () => {
    await writeCachedCredential({ target: TARGET, instanceSelector: "cloud-logging" }, CREDENTIAL, options());

    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
    await expect(readCachedCredential({ target: TARGET, instanceSelector: "cloud-logging" }, options())).resolves.toEqual(CREDENTIAL);
  });

  it("expires an entry after its time-to-live and prunes it on the next write", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, { ...options(), ttlMinutes: 60 });

    const justBefore = new Date(NOW.getTime() + 59 * 60_000);
    const justAfter = new Date(NOW.getTime() + 61 * 60_000);
    await expect(readCachedCredential(AUTO_KEY, options(justBefore))).resolves.toEqual(CREDENTIAL);
    await expect(readCachedCredential(AUTO_KEY, options(justAfter))).resolves.toBeUndefined();

    const otherKey: CredentialCacheKey = { target: { ...TARGET, space: "other" } };
    await writeCachedCredential(otherKey, CREDENTIAL, options(justAfter));
    const stored = JSON.parse(await readFile(join(root, "cf-metrics", "credentials.json"), "utf8")) as { entries: readonly { space: string }[] };
    expect(stored.entries.map((entry) => entry.space)).toEqual(["other"]);
  });

  it("replaces the entry for the same key rather than accumulating duplicates", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());
    await writeCachedCredential(AUTO_KEY, { ...CREDENTIAL, password: "rotated" }, options());

    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toMatchObject({ password: "rotated" });
    expect(await listCachedCredentials(options())).toHaveLength(1);
  });

  it("deletes one key's entry and reports whether anything was removed", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());
    const otherKey: CredentialCacheKey = { target: { ...TARGET, space: "other" } };
    await writeCachedCredential(otherKey, CREDENTIAL, options());

    await expect(deleteCachedCredential(AUTO_KEY, options())).resolves.toBe(true);
    await expect(deleteCachedCredential(AUTO_KEY, options())).resolves.toBe(false);
    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
    await expect(readCachedCredential(otherKey, options())).resolves.toEqual(CREDENTIAL);
  });

  it("lists live entries without the username or password, sorted by target", async () => {
    await writeCachedCredential({ target: { ...TARGET, space: "zulu" } }, CREDENTIAL, options());
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    const summaries = await listCachedCredentials(options());

    expect(summaries.map((summary) => summary.space)).toEqual(["space-demo", "zulu"]);
    expect(summaries[0]).toEqual({
      region: "eu10",
      org: "example-org",
      space: "space-demo",
      instance: "cloud-logging",
      source: "service-key:logging-key",
      dashboardsEndpoint: "https://dash.example.com",
      cachedAt: NOW.toISOString(),
      expiresAt: "2026-09-09T10:00:00.000Z",
    });
    expect(JSON.stringify(summaries)).not.toContain("dash-secret");
    expect(JSON.stringify(summaries)).not.toContain("dash-user");
  });

  it("clears everything, reporting how many live entries were held", async () => {
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());

    await expect(clearCredentialCache(options())).resolves.toBe(1);
    await expect(clearCredentialCache(options())).resolves.toBe(0);
    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
  });

  /**
   * The cache is an accelerator. A corrupted file must read as "nothing
   * cached" and be overwritten by the next write, never fail the command.
   */
  it("treats a malformed cache file as empty and recovers on the next write", async () => {
    const path = join(root, "cf-metrics", "credentials.json");
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());
    await writeFile(path, "{not json", "utf8");

    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());
    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toEqual(CREDENTIAL);
  });

  it("ignores entries missing required fields instead of returning a half-formed credential", async () => {
    const path = join(root, "cf-metrics", "credentials.json");
    await writeCachedCredential(AUTO_KEY, CREDENTIAL, options());
    const stored = JSON.parse(await readFile(path, "utf8")) as { version: 1; entries: Record<string, unknown>[] };
    delete stored.entries[0]?.["password"];
    await writeFile(path, JSON.stringify(stored), "utf8");

    await expect(readCachedCredential(AUTO_KEY, options())).resolves.toBeUndefined();
  });
});
