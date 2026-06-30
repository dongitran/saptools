import { describe, expect, it } from "vitest";

import { listKnownRegionKeys, resolveApiEndpoint } from "../../src/regions.js";

describe("resolveApiEndpoint", () => {
  it("maps a known region key to its SAP CF API endpoint", () => {
    expect(resolveApiEndpoint("eu10")).toBe("https://api.cf.eu10.hana.ondemand.com");
  });

  it.each([
    ["eu10-002", "https://api.cf.eu10-002.hana.ondemand.com"],
    ["eu10-003", "https://api.cf.eu10-003.hana.ondemand.com"],
    ["eu10-004", "https://api.cf.eu10-004.hana.ondemand.com"],
    ["eu10-005", "https://api.cf.eu10-005.hana.ondemand.com"],
    ["eu20-001", "https://api.cf.eu20-001.hana.ondemand.com"],
    ["eu20-002", "https://api.cf.eu20-002.hana.ondemand.com"],
    ["us10-001", "https://api.cf.us10-001.hana.ondemand.com"],
    ["us10-002", "https://api.cf.us10-002.hana.ondemand.com"],
  ])("maps indexed SAP region %s", (region, endpoint) => {
    expect(resolveApiEndpoint(region)).toBe(endpoint);
  });

  it("maps China regions to the SAP China domain", () => {
    expect(resolveApiEndpoint("cn20")).toBe("https://api.cf.cn20.platform.sapcloud.cn");
    expect(resolveApiEndpoint("cn40")).toBe("https://api.cf.cn40.platform.sapcloud.cn");
  });

  it("honours an override when provided", () => {
    expect(resolveApiEndpoint("eu10", "https://custom.example.com")).toBe(
      "https://custom.example.com",
    );
  });

  it("throws for unknown keys when no override is given", () => {
    expect(() => resolveApiEndpoint("xx99")).toThrow(/Unknown region key/);
  });

  it("lists at least a handful of known regions", () => {
    const keys = listKnownRegionKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("eu10");
    expect(keys).toContain("ap10");
    expect(keys).toContain("eu10-005");
    expect(keys).toContain("cn20");
  });
});
