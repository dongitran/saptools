import { afterEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import type { CurrentCfTarget } from "../../src/cf.js";
import { resolveAppBindings, selectBinding, toConnectionTarget } from "../../src/credentials.js";
import { CredentialsNotFoundError } from "../../src/errors.js";

import { sampleBinding, sampleCredentials } from "./fixtures/samples.js";

const sampleTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  orgName: "example-org",
  spaceName: "space-demo",
  regionKey: "eu10",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveAppBindings", () => {
  it("resolves bare using current target + direct (no SAP needed)", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(sampleTarget as CurrentCfTarget);
    vi.spyOn(cf, "cfEnvDirect").mockResolvedValue(`VCAP_SERVICES:
{"hana":[{"name":"hana-primary","credentials":{"host":"hana.example.internal","port":"443","user":"DB_USER","password":"db-password","schema":"APP_SCHEMA","hdi_user":"HDI_USER","hdi_password":"HDI_PASSWORD","url":"","database_id":"DB-1","certificate":"test-certificate"}}]}
VCAP_APPLICATION:{}`);

    const resolved = await resolveAppBindings("app-demo", {});
    expect(resolved.source).toBe("live");
    expect(resolved.bindings).toHaveLength(1);
  });

  it("falls back to SAP auth only on classified auth error for bare", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(sampleTarget as CurrentCfTarget);
    vi.spyOn(cf, "cfEnvDirect").mockRejectedValue({ stderr: "not logged in" });
    vi.spyOn(cf, "withCfSession").mockImplementation(async (_work: unknown) => [sampleBinding()]);
    vi.stubEnv("SAP_EMAIL", "u@example.com");
    vi.stubEnv("SAP_PASSWORD", "p");

    const resolved = await resolveAppBindings("app-demo", {});
    expect(resolved.source).toBe("live");
  });

  it("throws specific error for non-auth problem in bare (no SAP forced)", async () => {
    vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(sampleTarget as CurrentCfTarget);
    vi.spyOn(cf, "cfEnvDirect").mockRejectedValue({ stderr: "app not found" });

    await expect(resolveAppBindings("ghost-app", {})).rejects.toThrow(/current target/);
  });
});

describe("selectBinding", () => {
  it("returns the only binding when there is exactly one", () => {
    const binding = sampleBinding();
    expect(selectBinding([binding], {})).toBe(binding);
  });

  it("throws when multiple bindings are ambiguous", () => {
    expect(() =>
      selectBinding([sampleBinding({ name: "a" }), sampleBinding({ name: "b" })], {}),
    ).toThrow(/multiple HANA bindings/);
  });

  it("selects a binding by name", () => {
    const target = sampleBinding({ name: "wanted" });
    expect(
      selectBinding([sampleBinding({ name: "other" }), target], { bindingName: "wanted" }),
    ).toBe(target);
  });

  it("throws when a named binding is missing", () => {
    expect(() => selectBinding([sampleBinding()], { bindingName: "missing" })).toThrow(
      /No HANA binding named/,
    );
  });

  it("selects a binding by index", () => {
    const target = sampleBinding({ name: "second" });
    expect(
      selectBinding([sampleBinding({ name: "first" }), target], { bindingIndex: 1 }),
    ).toBe(target);
  });

  it("throws when a binding index is out of range", () => {
    expect(() => selectBinding([sampleBinding()], { bindingIndex: 9 })).toThrow(
      /No HANA binding at index/,
    );
  });

  it("throws when there are no bindings", () => {
    expect(() => selectBinding([], {})).toThrow(CredentialsNotFoundError);
  });
});

describe("toConnectionTarget", () => {
  it("maps the runtime user by default", () => {
    expect(toConnectionTarget(sampleBinding(), "runtime")).toMatchObject({
      user: "DB_USER",
      password: "db-password",
      port: 443,
      schema: "APP_SCHEMA",
    });
  });

  it("maps the HDI user for the hdi role", () => {
    expect(toConnectionTarget(sampleBinding(), "hdi")).toMatchObject({
      user: "HDI_USER",
      password: "HDI_PASSWORD",
    });
  });

  it("rejects an invalid port", () => {
    const binding = sampleBinding({ credentials: sampleCredentials({ port: "not-a-port" }) });
    expect(() => toConnectionTarget(binding, "runtime")).toThrow(/Invalid HANA port/);
  });
});

it("exercises cf helpers for coverage (classify, extract, api, format)", () => {
  expect(cf.classifyCfError("not logged in")).toEqual({ isAuthError: true, reason: "auth/session issue" });
  const stdout = `VCAP_SERVICES:
{"hana":[{"name":"h","credentials":{"host":"h","port":"443","user":"u","password":"p","schema":"s","hdi_user":"hu","hdi_password":"hp","url":"j","database_id":"d","certificate":"c"}}]}
VCAP_APPLICATION:{}`;
  const bs = cf.extractHanaBindingsFromCfEnv(stdout);
  expect(bs).toHaveLength(1);
  expect(cf.getApiEndpointForRegion("eu10")).toBeDefined();
  const t: CurrentCfTarget = { apiEndpoint: "https://api...", orgName: "o", spaceName: "s", regionKey: "eu10" };
  expect(cf.formatCurrentCfAppSelector(t, "app")).toBe("eu10/o/s/app");
});
