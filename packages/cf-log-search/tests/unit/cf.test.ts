import { describe, expect, it } from "vitest";

import { getApiEndpointForRegion, isCfAuthFailure, parseCfTargetOutput } from "../../src/cf.js";

describe("getApiEndpointForRegion", () => {
  it("resolves a known region", () => {
    expect(getApiEndpointForRegion("br10")).toBe("https://api.cf.br10.hana.ondemand.com");
  });
  it("returns undefined for an unknown region", () => {
    expect(getApiEndpointForRegion("nowhere")).toBeUndefined();
  });
});

describe("parseCfTargetOutput", () => {
  it("parses api endpoint, org, and space from real cf target output", () => {
    const stdout = "api endpoint:   https://api.cf.br10.hana.ondemand.com\napi version:    3.226.0\nuser:           e@x.com\norg:            acme-demo-org\nspace:          app";
    expect(parseCfTargetOutput(stdout)).toEqual({
      apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
      orgName: "acme-demo-org",
      spaceName: "app",
      regionKey: "br10",
    });
  });
  it("returns undefined when not logged in", () => {
    expect(parseCfTargetOutput("FAILED\nNot logged in.")).toBeUndefined();
  });
});

describe("isCfAuthFailure", () => {
  it("recognizes an expired-token message", () => {
    expect(isCfAuthFailure(new Error("cf curl /v3/x failed: token expired"))).toBe(true);
  });
  it("does not misclassify an unrelated failure", () => {
    expect(isCfAuthFailure(new Error("cf curl /v3/x failed: connection reset"))).toBe(false);
  });
});
