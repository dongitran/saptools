import { mkdtempSync, rmSync } from "node:fs";
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
});
