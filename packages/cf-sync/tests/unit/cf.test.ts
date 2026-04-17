import { describe, expect, it } from "vitest";

import { parseAppNames, parseNameTable } from "../../src/cf.js";

describe("parseNameTable", () => {
  it("parses cf orgs output", () => {
    const stdout = [
      "Getting orgs as user@example.com...",
      "",
      "name",
      "org-one",
      "org-two",
      "",
    ].join("\n");

    expect(parseNameTable(stdout)).toEqual(["org-one", "org-two"]);
  });

  it("returns empty when header missing", () => {
    expect(parseNameTable("no header here\n")).toEqual([]);
  });

  it("handles empty string", () => {
    expect(parseNameTable("")).toEqual([]);
  });

  it("skips blank lines after header", () => {
    const stdout = ["name", "", "org-one", "", "org-two"].join("\n");
    expect(parseNameTable(stdout)).toEqual(["org-one", "org-two"]);
  });
});

describe("parseAppNames", () => {
  it("parses cf apps output", () => {
    const stdout = [
      "Getting apps in org ... / space ...",
      "",
      "name                          requested state   processes",
      "app-one                       started           web:1/1",
      "app-two                       stopped           web:0/1",
      "",
    ].join("\n");

    expect(parseAppNames(stdout)).toEqual(["app-one", "app-two"]);
  });

  it("returns empty when no apps", () => {
    const stdout = ["name                          requested state", ""].join("\n");
    expect(parseAppNames(stdout)).toEqual([]);
  });

  it("returns empty when header missing", () => {
    expect(parseAppNames("nothing to see")).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(parseAppNames("")).toEqual([]);
  });
});
