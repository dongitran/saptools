import { describe, expect, it } from "vitest";

import {
  isSshDisabledError,
  isSshPermissionError,
  parseCurrentCfTarget,
  requireCurrentCfRegion,
} from "../../src/cf.js";

describe("isSshDisabledError", () => {
  it("does not classify a generic authorization failure as disabled SSH", () => {
    const stderr = "Error: You are not authorized to perform this action.";
    expect(isSshDisabledError(stderr)).toBe(false);
    expect(isSshPermissionError(stderr)).toBe(true);
  });
  it("detects the 'ssh support is disabled' variant", () => {
    expect(isSshDisabledError("SSH support is disabled for this app.")).toBe(true);
  });
  it("detects disabled SSH errors regardless of casing", () => {
    expect(isSshDisabledError("ssh SUPPORT is DISABLED for this application")).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isSshDisabledError("App my-demo not found")).toBe(false);
    expect(isSshPermissionError("App my-demo not found")).toBe(false);
  });
});

describe("parseCurrentCfTarget", () => {
  it("extracts API endpoint, region, org, and space from cf target output", () => {
    const target = parseCurrentCfTarget([
      "API endpoint:   https://api.cf.ap10.hana.ondemand.com",
      "API version:    3.156.0",
      "user:           user@example.com",
      "org:            demo-org",
      "space:          dev",
    ].join("\n"));

    expect(target).toEqual({
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      region: "ap10",
      org: "demo-org",
      space: "dev",
    });
  });

  it("extracts indexed SAP regions from current cf target output", () => {
    const target = parseCurrentCfTarget([
      "API endpoint:   https://api.cf.eu10-005.hana.ondemand.com/",
      "org:            demo-org",
      "space:          dev",
    ].join("\n"));

    expect(target).toEqual({
      apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com/",
      region: "eu10-005",
      org: "demo-org",
      space: "dev",
    });
  });

  it("extracts China SAP regions from current cf target output", () => {
    const target = parseCurrentCfTarget([
      "API endpoint:   https://api.cf.cn40.platform.sapcloud.cn",
      "org:            demo-org",
      "space:          dev",
    ].join("\n"));

    expect(target).toEqual({
      apiEndpoint: "https://api.cf.cn40.platform.sapcloud.cn",
      region: "cn40",
      org: "demo-org",
      space: "dev",
    });
  });

  it("accepts newly added SAP CF endpoint-shaped current targets", () => {
    const target = parseCurrentCfTarget([
      "API endpoint:   https://api.cf.eu10-999.hana.ondemand.com",
      "org:            demo-org",
      "space:          dev",
    ].join("\n"));

    expect(target?.region).toBe("eu10-999");
    expect(() => requireCurrentCfRegion(target ?? { apiEndpoint: "" })).not.toThrow();
  });

  it("returns undefined when the user is not fully targeted", () => {
    expect(parseCurrentCfTarget("API endpoint: https://api.example.test\norg:\nspace:")).toBeUndefined();
  });

  it("requires a known SAP region when deriving CLI target keys", () => {
    const target = parseCurrentCfTarget([
      "API endpoint:   https://api.example.test",
      "org:            demo-org",
      "space:          dev",
    ].join("\n"));

    expect(target).toEqual({
      apiEndpoint: "https://api.example.test",
      org: "demo-org",
      space: "dev",
    });
    expect(() => requireCurrentCfRegion(target ?? { apiEndpoint: "https://api.example.test" }))
      .toThrow(/does not match/);
  });
});
