import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntime } from "../../src/config/resolve.js";
import {
  createProfileStore,
  redactProfile,
  removeProfile,
  upsertProfile,
} from "../../src/credentials/profile-store.js";
import type { SecretVault } from "../../src/credentials/secret-vault.js";

function memoryVault(): SecretVault {
  const values = new Map<string, string>();
  return {
    async getSecret(profileName: string): Promise<string | undefined> {
      return values.get(profileName);
    },
    async setSecret(profileName: string, secret: string): Promise<void> {
      values.set(profileName, secret);
    },
    async deleteSecret(profileName: string): Promise<void> {
      values.delete(profileName);
    },
  };
}

async function tempProfileStore() {
  const dir = await mkdtemp(join(tmpdir(), "sharepoint-excel-"));
  return createProfileStore(join(dir, "profiles.json"));
}

describe("profile store", () => {
  it("upserts metadata, stores secrets in the vault, and redacts output", async () => {
    const store = await tempProfileStore();
    const vault = memoryVault();

    const profile = await upsertProfile(store, vault, {
      name: "demo",
      tenantId: "tenant",
      clientId: "demo-client-123456",
      clientSecret: "secret",
      site: "demo.sharepoint.example/sites/demo",
      drive: "Documents",
      secretStore: "file",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const redacted = await redactProfile(profile, vault);

    expect(await vault.getSecret("demo")).toBe("secret");
    expect(redacted.clientId).toBe("demo...3456");
    expect(redacted.hasClientSecret).toBe(true);
    expect((await store.readProfiles())[0]?.clientId).toBe("demo-client-123456");
  });

  it("removes metadata and vault secret", async () => {
    const store = await tempProfileStore();
    const vault = memoryVault();
    await upsertProfile(store, vault, {
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      site: "demo.sharepoint.example/sites/demo",
      secretStore: "file",
    });

    expect(await removeProfile(store, vault)).toBe(true);
    expect(await store.readProfiles()).toEqual([]);
    expect(await vault.getSecret("default")).toBeUndefined();
  });
});

describe("resolveRuntime", () => {
  it("resolves credentials from a stored profile and vault", async () => {
    const store = await tempProfileStore();
    const vault = memoryVault();
    await upsertProfile(store, vault, {
      name: "demo",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      site: "https://demo.sharepoint.example/sites/demo?x=1",
      drive: "Documents",
      secretStore: "file",
    });

    const runtime = await resolveRuntime({
      overrides: { profile: "demo" },
      profileStore: store,
      fileVault: vault,
      env: {},
    });

    expect(runtime.target.credentials).toEqual({
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });
    expect(runtime.target.site).toEqual({
      hostname: "demo.sharepoint.example",
      sitePath: "sites/demo",
    });
    expect(runtime.drive).toBe("Documents");
  });

  it("allows env credentials without a profile", async () => {
    const store = await tempProfileStore();
    const runtime = await resolveRuntime({
      profileStore: store,
      env: {
        SHAREPOINT_EXCEL_TENANT_ID: "tenant",
        SHAREPOINT_EXCEL_CLIENT_ID: "client",
        SHAREPOINT_EXCEL_CLIENT_SECRET: "secret",
        SHAREPOINT_EXCEL_SITE: "demo.sharepoint.example/sites/demo",
      },
    });

    expect(runtime.source).toBe("env");
    expect(runtime.profileName).toBe("default");
  });
});
