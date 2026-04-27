import { describe, expect, it } from "vitest";

import { parseAppDetails, parseAppNames, parseNameTable } from "../../src/cf.js";

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

describe("parseAppDetails", () => {
  it("parses CF v8 process state, instance counts, and routes", () => {
    const stdout = [
      "Getting apps in org demo-org / space app as user@example.com...",
      "",
      "name                          requested state   processes              routes",
      "sample-service-a              started           web:1/1                sample-a.cfapps.example.com",
      "sample-worker                 started           web:0/1, worker:2/2    ",
      "sample-service-b              stopped           web:0/1                sample-b.cfapps.example.com",
      "",
    ].join("\n");

    expect(parseAppDetails(stdout)).toEqual([
      {
        name: "sample-service-a",
        requestedState: "started",
        runningInstances: 1,
        totalInstances: 1,
        routes: ["sample-a.cfapps.example.com"],
      },
      {
        name: "sample-worker",
        requestedState: "started",
        runningInstances: 2,
        totalInstances: 3,
        routes: [],
      },
      {
        name: "sample-service-b",
        requestedState: "stopped",
        runningInstances: 0,
        totalInstances: 1,
        routes: ["sample-b.cfapps.example.com"],
      },
    ]);
  });

  it("parses CF v7 instance column", () => {
    const stdout = [
      "name                          requested state   instances   routes",
      "sample-api                    started           0/1         sample-api.cfapps.example.com",
    ].join("\n");

    expect(parseAppDetails(stdout)).toEqual([
      {
        name: "sample-api",
        requestedState: "started",
        runningInstances: 0,
        totalInstances: 1,
        routes: ["sample-api.cfapps.example.com"],
      },
    ]);
  });

  it("parses comma-separated routes", () => {
    const stdout = [
      "name                          requested state   processes   routes",
      "sample-api                    started           web:1/1     sample-a.example.com,sample-b.example.com",
    ].join("\n");

    expect(parseAppDetails(stdout)[0]?.routes).toEqual(["sample-a.example.com", "sample-b.example.com"]);
  });

  it("returns name-only details when state columns are missing", () => {
    expect(parseAppDetails("name\nsample-api\n")).toEqual([{ name: "sample-api" }]);
  });

  it("returns empty when header is missing", () => {
    expect(parseAppDetails("unexpected output")).toEqual([]);
  });
});
