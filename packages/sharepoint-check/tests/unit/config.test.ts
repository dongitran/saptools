import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../src/config.js";

function env(
  values: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as NodeJS.ProcessEnv;
}

describe("resolveConfig", () => {
  const baseEnv = env({
    SHAREPOINT_TENANT_ID: "t",
    SHAREPOINT_CLIENT_ID: "c",
    SHAREPOINT_CLIENT_SECRET: "s",
    SHAREPOINT_SITE: "host.example/sites/demo",
  });

  it("resolves credentials + site from the environment", () => {
    const cfg = resolveConfig({ env: baseEnv });
    expect(cfg.target.credentials.tenantId).toBe("t");
    expect(cfg.target.site.hostname).toBe("host.example");
    expect(cfg.target.site.sitePath).toBe("sites/demo");
    expect(cfg.rootPath).toBe("");
    expect(cfg.subdirectories).toEqual([]);
  });

  it("prefers CLI overrides over env values", () => {
    const cfg = resolveConfig({
      env: baseEnv,
      overrides: { tenant: "t-override", site: "https://other.example/sites/x" },
    });
    expect(cfg.target.credentials.tenantId).toBe("t-override");
    expect(cfg.target.site.hostname).toBe("other.example");
    expect(cfg.target.site.sitePath).toBe("sites/x");
  });

  it("ignores empty overrides and falls back to env values", () => {
    const cfg = resolveConfig({
      env: baseEnv,
      overrides: { tenant: "", clientId: "", clientSecret: "", site: "" },
    });

    expect(cfg.target.credentials).toEqual({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(cfg.target.site.hostname).toBe("host.example");
  });

  it("splits comma/newline-separated subdirs and trims whitespace", () => {
    const cfg = resolveConfig({
      env: env({ ...baseEnv, SHAREPOINT_SUBDIRS: "alpha, beta\n gamma ,," }),
    });
    expect(cfg.subdirectories).toEqual(["alpha", "beta", "gamma"]);
  });

  it("uses subdir overrides instead of env subdirs", () => {
    const cfg = resolveConfig({
      env: env({ ...baseEnv, SHAREPOINT_SUBDIRS: "from-env" }),
      overrides: { subdirs: "from-flag, second" },
    });
    expect(cfg.subdirectories).toEqual(["from-flag", "second"]);
  });

  it("strips leading/trailing slashes from root", () => {
    const cfg = resolveConfig({ env: env({ ...baseEnv, SHAREPOINT_ROOT_DIR: "/Apps/sample/" }) });
    expect(cfg.rootPath).toBe("Apps/sample");
  });

  it("throws when tenant is missing", () => {
    const partial = env({
      SHAREPOINT_CLIENT_ID: "c",
      SHAREPOINT_CLIENT_SECRET: "s",
      SHAREPOINT_SITE: "host.example/sites/x",
    });
    expect(() => resolveConfig({ env: partial })).toThrow(/Tenant ID is required/);
  });

  it("throws when client id is missing", () => {
    const partial = env({
      SHAREPOINT_TENANT_ID: "t",
      SHAREPOINT_CLIENT_SECRET: "s",
      SHAREPOINT_SITE: "host.example/sites/x",
    });
    expect(() => resolveConfig({ env: partial })).toThrow(/Client ID is required/);
  });

  it("throws when client secret is missing", () => {
    const partial = env({
      SHAREPOINT_TENANT_ID: "t",
      SHAREPOINT_CLIENT_ID: "c",
      SHAREPOINT_SITE: "host.example/sites/x",
    });
    expect(() => resolveConfig({ env: partial })).toThrow(/Client secret is required/);
  });

  it("throws when site is missing", () => {
    const partial = env({
      SHAREPOINT_TENANT_ID: "t",
      SHAREPOINT_CLIENT_ID: "c",
      SHAREPOINT_CLIENT_SECRET: "s",
    });
    expect(() => resolveConfig({ env: partial })).toThrow(/Site reference is required/);
  });

  it("throws when requireRoot is true and no root provided", () => {
    expect(() => resolveConfig({ env: baseEnv, requireRoot: true })).toThrow(
      /Root directory is required/,
    );
  });
});
