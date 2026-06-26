import { describe, expect, it } from "vitest";

import {
  isSshDisabledError,
  parseAppNames,
  parseCurrentCfTarget,
  parseNameTable,
  requireCurrentCfRegion,
} from "../../src/cf.js";

describe("isSshDisabledError", () => {
  it("detects the 'not authorized' variant", () => {
    expect(isSshDisabledError("Error: You are not authorized to perform this action.")).toBe(true);
  });
  it("detects the 'ssh support is disabled' variant", () => {
    expect(isSshDisabledError("SSH support is disabled for this app.")).toBe(true);
  });
  it("detects disabled SSH errors regardless of casing", () => {
    expect(isSshDisabledError("ssh SUPPORT is DISABLED for this application")).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isSshDisabledError("App my-demo not found")).toBe(false);
  });
});

describe("parseNameTable", () => {
  it("extracts names from a cf orgs-style table", () => {
    const stdout = [
      "Getting orgs as user@example.com...",
      "",
      "name",
      "org-a",
      "org-b",
      "",
    ].join("\n");
    expect(parseNameTable(stdout)).toEqual(["org-a", "org-b"]);
  });

  it("returns an empty array when the header is missing", () => {
    expect(parseNameTable("nope")).toEqual([]);
  });

  it("ignores banner and blank lines around name rows", () => {
    const stdout = [
      "Getting spaces as user@example.com...",
      "",
      "  name  ",
      "  dev  ",
      "",
      "  qa  ",
      "",
    ].join("\n");
    expect(parseNameTable(stdout)).toEqual(["dev", "qa"]);
  });
});

describe("parseAppNames", () => {
  it("extracts names from a cf apps-style table", () => {
    const stdout = [
      "Getting apps in org 'x' / space 'dev' as user@example.com...",
      "",
      "name               requested state   processes                      routes",
      "demo-app           started           web:1/1                         demo-app.example.com",
      "demo-worker        stopped           web:0/1                         ",
      "",
    ].join("\n");
    expect(parseAppNames(stdout)).toEqual(["demo-app", "demo-worker"]);
  });

  it("returns an empty array when the apps header is absent", () => {
    expect(parseAppNames("No apps found")).toEqual([]);
  });

  it("ignores empty rows after the apps header", () => {
    const stdout = [
      "name               requested state   processes                      routes",
      "",
      "api-app            started           web:1/1                         api.example.com",
      "",
      "worker-app         stopped           web:0/1                         ",
    ].join("\n");
    expect(parseAppNames(stdout)).toEqual(["api-app", "worker-app"]);
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
