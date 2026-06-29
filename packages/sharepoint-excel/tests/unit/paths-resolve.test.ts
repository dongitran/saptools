import { describe, expect, it } from "vitest";

import { packageDataDir, profilesPath, fileSecretsPath } from "../../src/config/paths.js";
import { parseSecretStoreKind, resolveRuntime } from "../../src/config/resolve.js";

describe("path helpers", () => {
  it("uses SAPTOOLS_SHAREPOINT_EXCEL_HOME when provided", () => {
    const env = { SAPTOOLS_SHAREPOINT_EXCEL_HOME: "/tmp/sharepoint-excel" };

    expect(packageDataDir(env)).toBe("/tmp/sharepoint-excel");
    expect(profilesPath(env)).toBe("/tmp/sharepoint-excel/profiles.json");
    expect(fileSecretsPath(env)).toBe("/tmp/sharepoint-excel/secrets.json");
  });
});

describe("resolve helpers", () => {
  it("validates secret store kind", () => {
    expect(parseSecretStoreKind(undefined)).toBe("keyring");
    expect(parseSecretStoreKind("file")).toBe("file");
    expect(() => parseSecretStoreKind("plain")).toThrow(/Invalid secret store/);
  });

  it("throws when required runtime values are missing", async () => {
    await expect(resolveRuntime({ env: {}, profileStore: { readProfiles: async () => [], writeProfiles: async () => undefined } }))
      .rejects.toThrow(/Tenant ID is required/);
  });
});
