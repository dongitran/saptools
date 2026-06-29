import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const keyringValues = new Map<string, string>();
const legacyServiceName = ["saptools", "sharepoint-excel"].join("-");

vi.mock("@napi-rs/keyring", () => ({
  Entry: class Entry {
    private readonly key: string;

    public constructor(serviceName: string, profileName: string) {
      this.key = `${serviceName}:${profileName}`;
    }

    public getPassword(): string | null {
      return keyringValues.get(this.key) ?? null;
    }

    public setPassword(secret: string): void {
      keyringValues.set(this.key, secret);
    }

    public deletePassword(): void {
      keyringValues.delete(this.key);
    }
  },
}));

describe("secret vaults", () => {
  beforeEach(() => {
    keyringValues.clear();
  });

  it("stores file secrets with get/set/delete", async () => {
    const { createFileSecretVault } = await import("../../src/credentials/secret-vault.js");
    const dir = await mkdtemp(join(tmpdir(), "sharepoint-excel-secrets-"));
    const vault = createFileSecretVault(join(dir, "secrets.json"));

    await vault.setSecret("demo", "secret");
    expect(await vault.getSecret("demo")).toBe("secret");
    await vault.deleteSecret("demo");
    expect(await vault.getSecret("demo")).toBeUndefined();
  });

  it("uses the keyring adapter without exposing secrets", async () => {
    const { createKeyringSecretVault } = await import("../../src/credentials/secret-vault.js");
    const vault = createKeyringSecretVault("service");

    await vault.setSecret("demo", "secret");
    expect(await vault.getSecret("demo")).toBe("secret");
    await vault.deleteSecret("demo");
    expect(await vault.getSecret("demo")).toBeUndefined();
  });

  it("uses the renamed keyring service while cleaning up legacy entries", async () => {
    const { createKeyringSecretVault } = await import("../../src/credentials/secret-vault.js");
    const vault = createKeyringSecretVault();

    await vault.setSecret("demo", "secret");
    expect(keyringValues.get("sharepoint-excel:demo")).toBe("secret");
    expect(keyringValues.get(`${legacyServiceName}:demo`)).toBeUndefined();

    keyringValues.set(`${legacyServiceName}:legacy`, "legacy-secret");
    expect(await vault.getSecret("legacy")).toBe("legacy-secret");

    await vault.deleteSecret("legacy");
    expect(keyringValues.get(`${legacyServiceName}:legacy`)).toBeUndefined();
  });
});
