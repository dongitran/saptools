import { describe, expect, it } from "vitest";

import {
  getApiEndpointForRegion,
  getRegionKeyForApi,
  normalizeSapCfApiEndpoint,
  parseCfTargetOutput,
} from "../../src/cf.js";

describe("SAP CF region and endpoint resolution", () => {
  it.each([
    ["eu10", "https://api.cf.eu10.hana.ondemand.com"],
    ["eu10-002", "https://api.cf.eu10-002.hana.ondemand.com"],
    ["eu10-003", "https://api.cf.eu10-003.hana.ondemand.com"],
    ["eu10-004", "https://api.cf.eu10-004.hana.ondemand.com"],
    ["eu10-005", "https://api.cf.eu10-005.hana.ondemand.com"],
    ["eu20-001", "https://api.cf.eu20-001.hana.ondemand.com"],
    ["eu20-002", "https://api.cf.eu20-002.hana.ondemand.com"],
    ["us10-001", "https://api.cf.us10-001.hana.ondemand.com"],
    ["us10-002", "https://api.cf.us10-002.hana.ondemand.com"],
    ["eu01", "https://api.cf.eu01.hana.ondemand.com"],
    ["ap31", "https://api.cf.ap31.hana.ondemand.com"],
    ["cn40", "https://api.cf.cn40.platform.sapcloud.cn"],
  ])("resolves %s", (region, endpoint) => {
    expect(getApiEndpointForRegion(region)).toBe(endpoint);
    expect(getRegionKeyForApi(`${endpoint.toUpperCase()}/`)).toBe(region);
  });

  it("does not derive explicit endpoints for unknown region keys", () => {
    expect(getApiEndpointForRegion("zz99-123")).toBeUndefined();
  });

  it("derives display keys from validated SAP-owned current endpoints", () => {
    expect(getRegionKeyForApi("https://api.cf.zz99-123.hana.ondemand.com")).toBe("zz99-123");
  });

  it.each(["eu", "eu100", "eu10-5", "eu10-0001", "eu10.example"])("rejects malformed key %s", (region) => {
    expect(getApiEndpointForRegion(region)).toBeUndefined();
  });

  it.each([
    "http://api.cf.eu10.hana.ondemand.com",
    "https://user:pass@api.cf.eu10.hana.ondemand.com",
    "https://api.cf.eu10.hana.ondemand.com:443",
    "https://api.cf.eu10.hana.ondemand.com/path",
    "https://api.cf.eu10.hana.ondemand.com?x=1",
    "https://api.cf.eu10.hana.ondemand.com#frag",
    "https://api.cf.eu10.hana.ondemand.com.attacker.example",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => normalizeSapCfApiEndpoint(endpoint)).toThrow(/Invalid or untrusted CF API endpoint/);
    expect(getRegionKeyForApi(endpoint)).toBeUndefined();
  });
});

describe("parseCfTargetOutput", () => {
  it("parses and normalizes an indexed current target", () => {
    const target = parseCfTargetOutput(`API endpoint:   HTTPS://API.CF.EU10-005.HANA.ONDEMAND.COM/
org:            example-org
space:          space-demo`);
    expect(target).toEqual({
      apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
      orgName: "example-org",
      spaceName: "space-demo",
      regionKey: "eu10-005",
    });
  });

  it("recognizes China endpoints", () => {
    expect(parseCfTargetOutput(`API endpoint: https://api.cf.cn40.platform.sapcloud.cn
org: demo
space: dev`)?.regionKey).toBe("cn40");
  });

  it("rejects missing target fields and malformed endpoints", () => {
    expect(parseCfTargetOutput("API endpoint: https://api.cf.eu10.hana.ondemand.com\norg: demo\n")).toBeUndefined();
    expect(parseCfTargetOutput("API endpoint: http://api.cf.eu10.hana.ondemand.com\norg: demo\nspace: dev\n")).toBeUndefined();
  });
});
