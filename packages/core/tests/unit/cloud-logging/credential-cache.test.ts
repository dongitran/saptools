import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCredentialCache,
  deleteCachedCredential,
  listCachedCredentials,
  readCachedCredential,
  writeCachedCredential,
} from "../../../src/cloud-logging/credential-cache.js";
import type { ResolvedTarget } from "../../../src/cloud-logging/types.js";

const TARGET: ResolvedTarget = {
  apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
  region: "br10",
  org: "o",
  space: "s",
  selectorSource: "explicit",
  regionConfirmed: true,
};
const CREDENTIAL = { dashboardsEndpoint: "https://dash.example.com", username: "cache-test-user", password: "cache-test-pass", source: "service-key:k", instance: "cloud-logging" };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-credential-cache-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("credential-cache", () => {
  it("returns undefined for a target with nothing cached", async () => {
    expect(await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" })).toBeUndefined();
  });

  it("writes then reads back a credential for the same target", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const read = await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(read).toEqual(CREDENTIAL);
  });

  it("does not return an entry once its TTL has expired", async () => {
    const past = () => new Date(Date.now() - 10 * 60_000);
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search", now: past, ttlMinutes: 1 });
    const read = await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(read).toBeUndefined();
  });

  it("scopes entries by instanceSelector, not just target", async () => {
    await writeCachedCredential({ target: TARGET, instanceSelector: "other-instance" }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" })).toBeUndefined();
  });

  it("deletes only the matching entry", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const removed = await deleteCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(removed).toBe(true);
    expect(await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" })).toBeUndefined();
  });

  it("lists cached credentials without exposing the secret", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const list = await listCachedCredentials({ saptoolsRoot: root, cliName: "cf-log-search" });
    expect(list).toEqual([
      { region: "br10", org: "o", space: "s", instance: "cloud-logging", source: "service-key:k", dashboardsEndpoint: "https://dash.example.com", cachedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
    expect(JSON.stringify(list)).not.toContain("cache-test-user");
    expect(JSON.stringify(list)).not.toContain("cache-test-pass");
  });

  it("clears the whole cache and reports how many live entries it held", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(await clearCredentialCache({ saptoolsRoot: root, cliName: "cf-log-search" })).toBe(1);
    expect(await listCachedCredentials({ saptoolsRoot: root, cliName: "cf-log-search" })).toEqual([]);
  });

  it("scopes the on-disk file by cliName, so cf-otel's and cf-log-search's caches never collide", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-otel" });
    expect(await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" })).toBeUndefined();
    expect(await readCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-otel" })).toEqual(CREDENTIAL);
  });

  it("silently drops malformed entries that are not objects", async () => {
    const cacheDir = join(root, "cf-log-search");
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, "credentials.json");
    writeFileSync(cachePath, JSON.stringify({
      version: 1,
      entries: [
        "not-an-object",
        123,
        null,
        { region: "br10", apiEndpoint: "https://api.cf.br10.hana.ondemand.com", org: "o", space: "s", instanceSelector: "auto", instance: "cloud-logging", source: "service-key:k", dashboardsEndpoint: "https://dash.example.com", username: "cache-test-user", password: "cache-test-pass", cachedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
      ],
    }));
    const list = await listCachedCredentials({ saptoolsRoot: root, cliName: "cf-log-search" });
    expect(list).toHaveLength(1);
    const first = list[0];
    if (first === undefined) {
      throw new Error("Expected first entry to exist");
    }
    expect(first.org).toBe("o");
  });

  it("returns undefined when querying with a different org", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const differentOrgTarget = { ...TARGET, org: "different-org" };
    const read = await readCachedCredential({ target: differentOrgTarget }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(read).toBeUndefined();
  });

  it("returns undefined when querying with a different space", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const differentSpaceTarget = { ...TARGET, space: "different-space" };
    const read = await readCachedCredential({ target: differentSpaceTarget }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(read).toBeUndefined();
  });

  it("matches a cached entry when querying with explicit instanceSelector that matches the credential's instance", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const read = await readCachedCredential({ target: TARGET, instanceSelector: "cloud-logging" }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(read).toEqual(CREDENTIAL);
  });

  it("returns false when deleting a non-existent credential", async () => {
    const deleted = await deleteCachedCredential({ target: TARGET }, { saptoolsRoot: root, cliName: "cf-log-search" });
    expect(deleted).toBe(false);
  });

  it("sorts multiple cached credentials by region, org, space, and instance", async () => {
    const target1 = { ...TARGET, region: "us10", org: "org-b" };
    const target2 = { ...TARGET, region: "us10", org: "org-a" };
    await writeCachedCredential({ target: target1 }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    await writeCachedCredential({ target: target2 }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const list = await listCachedCredentials({ saptoolsRoot: root, cliName: "cf-log-search" });
    expect(list).toHaveLength(2);
    const first = list[0];
    const second = list[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two entries");
    }
    expect(first.org).toBe("org-a");
    expect(second.org).toBe("org-b");
  });

  it("returns 0 from clearCredentialCache on a fresh cache with no directory", async () => {
    const count = await clearCredentialCache({ saptoolsRoot: root, cliName: "fresh-cli" });
    expect(count).toBe(0);
  });

  it("cleans up stray temp files when clearing the cache", async () => {
    await writeCachedCredential({ target: TARGET }, CREDENTIAL, { saptoolsRoot: root, cliName: "cf-log-search" });
    const cacheDir = join(root, "cf-log-search");
    const strayTempFile = join(cacheDir, "credentials.json.9999.stray.tmp");
    writeFileSync(strayTempFile, "stray");
    expect(existsSync(strayTempFile)).toBe(true);
    await clearCredentialCache({ saptoolsRoot: root, cliName: "cf-log-search" });
    expect(existsSync(strayTempFile)).toBe(false);
  });
});
