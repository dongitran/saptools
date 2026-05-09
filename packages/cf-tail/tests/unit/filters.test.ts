import type { ParsedLogRow } from "@saptools/cf-logs";
import { describe, expect, it } from "vitest";

import {
  applyAppFilter,
  buildAppFilter,
  filterTailRows,
  matchesAppFilter,
  parseDurationMs,
  parseStatusRange,
} from "../../src/filters.js";
import type { TailLogRow } from "../../src/types.js";

function buildRow(overrides: Partial<TailLogRow>): TailLogRow {
  const base: ParsedLogRow = {
    id: 1,
    timestamp: "12:14:40",
    timestampRaw: "2026-04-12T09:14:40.00+0700",
    source: "APP/PROC/WEB/0",
    stream: "OUT",
    format: "text",
    level: "info",
    logger: "app",
    component: "",
    org: "",
    space: "",
    host: "app",
    method: "",
    request: "ready",
    status: "",
    latency: "",
    tenant: "",
    clientIp: "",
    requestId: "",
    message: "ready",
    rawBody: "ready",
    jsonPayload: null,
    searchableText: "ready",
  };
  return { ...base, appName: "demo-app", ...overrides };
}

describe("buildAppFilter", () => {
  it("normalizes comma-separated include lists", () => {
    const filter = buildAppFilter({ include: ["a, b ,c"] });
    expect([...filter.include]).toEqual(["a", "b", "c"]);
  });

  it("compiles regex patterns", () => {
    const filter = buildAppFilter({ includeRegex: ["^demo-"] });
    expect(filter.includeRegex.length).toBe(1);
    expect(filter.includeRegex[0]?.test("demo-app")).toBe(true);
  });
});

describe("matchesAppFilter", () => {
  it("returns true when no filter is set", () => {
    const filter = buildAppFilter({});
    expect(matchesAppFilter("any-app", filter)).toBe(true);
  });

  it("respects exclude before include", () => {
    const filter = buildAppFilter({ include: ["demo"], exclude: ["demo"] });
    expect(matchesAppFilter("demo", filter)).toBe(false);
  });

  it("matches via regex include", () => {
    const filter = buildAppFilter({ includeRegex: ["^api-"] });
    expect(matchesAppFilter("api-svc", filter)).toBe(true);
    expect(matchesAppFilter("worker", filter)).toBe(false);
  });

  it("rejects via regex exclude", () => {
    const filter = buildAppFilter({ excludeRegex: ["-canary$"] });
    expect(matchesAppFilter("api-canary", filter)).toBe(false);
    expect(matchesAppFilter("api-prod", filter)).toBe(true);
  });
});

describe("applyAppFilter", () => {
  it("filters and preserves order", () => {
    const filter = buildAppFilter({ includeRegex: ["^demo-"] });
    const apps = [
      { name: "demo-a", runningInstances: 1 },
      { name: "other", runningInstances: 1 },
      { name: "demo-b", runningInstances: 1 },
    ];
    expect(applyAppFilter(apps, filter).map((app) => app.name)).toEqual(["demo-a", "demo-b"]);
  });
});

describe("parseDurationMs", () => {
  it("parses common units", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("90")).toBe(90_000);
  });

  it("returns undefined for invalid input", () => {
    expect(parseDurationMs("")).toBeUndefined();
    expect(parseDurationMs("abc")).toBeUndefined();
    expect(parseDurationMs("-1s")).toBeUndefined();
  });
});

describe("parseStatusRange", () => {
  it("parses single, bucket, and range forms", () => {
    expect(parseStatusRange("404")).toEqual({ min: 404, max: 404 });
    expect(parseStatusRange("5xx")).toEqual({ min: 500, max: 599 });
    expect(parseStatusRange("400-499")).toEqual({ min: 400, max: 499 });
    expect(parseStatusRange("499-400")).toEqual({ min: 400, max: 499 });
  });

  it("returns undefined for invalid input", () => {
    expect(parseStatusRange("")).toBeUndefined();
    expect(parseStatusRange("99")).toBeUndefined();
    expect(parseStatusRange("not-a-status")).toBeUndefined();
  });
});

describe("filterTailRows", () => {
  it("filters by level", () => {
    const rows = [
      buildRow({ id: 1, level: "info" }),
      buildRow({ id: 2, level: "error" }),
    ];
    expect(filterTailRows(rows, { level: "error" })).toHaveLength(1);
  });

  it("filters by search term against searchable text", () => {
    const rows = [
      buildRow({ id: 1, searchableText: "ready" }),
      buildRow({ id: 2, searchableText: "save failed" }),
    ];
    expect(filterTailRows(rows, { searchTerm: "failed" })).toHaveLength(1);
  });

  it("filters by source token", () => {
    const rows = [
      buildRow({ id: 1, source: "APP/PROC/WEB/0" }),
      buildRow({ id: 2, source: "RTR/0" }),
    ];
    expect(filterTailRows(rows, { source: "rtr" })).toHaveLength(1);
  });

  it("filters by status range", () => {
    const rows = [
      buildRow({ id: 1, status: "200" }),
      buildRow({ id: 2, status: "500" }),
    ];
    expect(filterTailRows(rows, { statusMin: 500, statusMax: 599 })).toHaveLength(1);
  });

  it("respects newestFirst and maxRows together", () => {
    const rows = [
      buildRow({ id: 1, message: "first" }),
      buildRow({ id: 2, message: "second" }),
      buildRow({ id: 3, message: "third" }),
    ];
    const result = filterTailRows(rows, { newestFirst: true, maxRows: 2 });
    expect(result.map((row) => row.message)).toEqual(["third", "second"]);
  });

  it("filters by app list", () => {
    const rows = [
      buildRow({ id: 1, appName: "a" }),
      buildRow({ id: 2, appName: "b" }),
    ];
    expect(filterTailRows(rows, { apps: ["a"] })).toHaveLength(1);
  });

  it("filters by tenant exact match", () => {
    const rows = [
      buildRow({ id: 1, tenant: "tenant-a" }),
      buildRow({ id: 2, tenant: "tenant-b" }),
    ];
    expect(filterTailRows(rows, { tenant: "tenant-a" })).toHaveLength(1);
  });

  it("filters by stream out/err", () => {
    const rows = [
      buildRow({ id: 1, stream: "OUT" }),
      buildRow({ id: 2, stream: "ERR" }),
    ];
    expect(filterTailRows(rows, { stream: "err" })).toHaveLength(1);
    expect(filterTailRows(rows, { stream: "out" })).toHaveLength(1);
    expect(filterTailRows(rows, { stream: "all" })).toHaveLength(2);
  });

  it("filters by since/until duration windows", () => {
    const now = Date.now();
    const rows = [
      buildRow({
        id: 1,
        timestampRaw: new Date(now - 60_000).toISOString(),
      }),
      buildRow({
        id: 2,
        timestampRaw: new Date(now - 10 * 60_000).toISOString(),
      }),
    ];
    expect(filterTailRows(rows, { sinceMs: 5 * 60_000 })).toHaveLength(1);
  });

  it("returns oldest-first when newestFirst is false but maxRows is set", () => {
    const rows = [
      buildRow({ id: 1, message: "a" }),
      buildRow({ id: 2, message: "b" }),
      buildRow({ id: 3, message: "c" }),
    ];
    const result = filterTailRows(rows, { maxRows: 2 });
    expect(result.map((row) => row.message)).toEqual(["b", "c"]);
  });
});
