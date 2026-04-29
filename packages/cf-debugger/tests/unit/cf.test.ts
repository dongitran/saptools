import { describe, expect, it } from "vitest";

import { isSshDisabledError, parseAppNames, parseNameTable } from "../../src/cf.js";

describe("isSshDisabledError", () => {
  it("detects the 'not authorized' variant", () => {
    expect(isSshDisabledError("Error: You are not authorized to perform this action.")).toBe(true);
  });
  it("detects the 'ssh support is disabled' variant", () => {
    expect(isSshDisabledError("SSH support is disabled for this app.")).toBe(true);
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
});
