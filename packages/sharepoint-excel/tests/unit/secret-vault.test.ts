import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const keyringValues = new Map<string, string>();

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
});
