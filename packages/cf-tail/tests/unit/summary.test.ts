import type { ParsedLogRow } from "@saptools/cf-logs";
import { describe, expect, it } from "vitest";

import { summarizeRows } from "../../src/summary.js";
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

describe("summarizeRows", () => {
  it("counts levels, sources, statuses, and tenants per app", () => {
    const rows = [
      buildRow({ id: 1, appName: "a", level: "info", source: "RTR/0", status: "200" }),
      buildRow({ id: 2, appName: "a", level: "error", source: "APP/PROC/WEB/0" }),
      buildRow({ id: 3, appName: "a", level: "warn", source: "RTR/0", status: "404" }),
      buildRow({ id: 4, appName: "b", level: "info", tenant: "tenant-x" }),
    ];
    const summary = summarizeRows(rows);
    expect(summary.total).toBe(4);
    expect(summary.levels.info).toBe(2);
    expect(summary.levels.error).toBe(1);
    const appA = summary.apps.find((entry) => entry.appName === "a");
    const appB = summary.apps.find((entry) => entry.appName === "b");
    expect(appA?.total).toBe(3);
    expect(appA?.sources.get("RTR/0")).toBe(2);
    expect(appA?.statusBuckets.get("2xx")).toBe(1);
    expect(appA?.statusBuckets.get("4xx")).toBe(1);
    expect(appB?.tenants.get("tenant-x")).toBe(1);
  });

  it("handles empty input", () => {
    const summary = summarizeRows([]);
    expect(summary.total).toBe(0);
    expect(summary.apps).toHaveLength(0);
  });

  it("tracks first and last timestamps per app", () => {
    const rows = [
      buildRow({
        id: 1,
        appName: "a",
        timestampRaw: "2026-04-12T09:14:40.00+0700",
      }),
      buildRow({
        id: 2,
        appName: "a",
        timestampRaw: "2026-04-12T09:14:50.00+0700",
      }),
    ];
    const summary = summarizeRows(rows);
    const appA = summary.apps.find((entry) => entry.appName === "a");
    expect(appA?.firstAt).toBe("2026-04-12T09:14:40.00+0700");
    expect(appA?.lastAt).toBe("2026-04-12T09:14:50.00+0700");
  });
});
