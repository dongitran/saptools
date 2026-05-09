import type { ParsedLogRow } from "@saptools/cf-logs";
import { describe, expect, it } from "vitest";

import {
  compareTailRows,
  mergeAppRows,
  parseTimestampEpoch,
  tagRowsWithApp,
} from "../../src/merge.js";

function buildRow(overrides: Partial<ParsedLogRow>): ParsedLogRow {
  return {
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
    ...overrides,
  };
}

describe("parseTimestampEpoch", () => {
  it("parses CF-style timestamps with offset", () => {
    expect(parseTimestampEpoch("2026-04-12T09:14:40.00+0700")).toBe(
      Date.parse("2026-04-12T09:14:40.00+07:00"),
    );
  });

  it("returns undefined for blank or N/A", () => {
    expect(parseTimestampEpoch("")).toBeUndefined();
    expect(parseTimestampEpoch("N/A")).toBeUndefined();
  });
});

describe("tagRowsWithApp", () => {
  it("attaches the app name to every row", () => {
    const rows = [buildRow({ id: 1 }), buildRow({ id: 2 })];
    const tagged = tagRowsWithApp("demo", rows);
    expect(tagged.every((row) => row.appName === "demo")).toBe(true);
  });
});

describe("mergeAppRows", () => {
  it("merges rows from multiple apps in chronological order", () => {
    const rows = new Map([
      [
        "a",
        [
          buildRow({ id: 1, timestampRaw: "2026-04-12T09:14:42.00+0700", message: "a-late" }),
          buildRow({ id: 2, timestampRaw: "2026-04-12T09:14:40.00+0700", message: "a-early" }),
        ],
      ],
      [
        "b",
        [
          buildRow({ id: 1, timestampRaw: "2026-04-12T09:14:41.00+0700", message: "b-mid" }),
        ],
      ],
    ]);

    const merged = mergeAppRows(rows);
    expect(merged.map((row) => row.message)).toEqual(["a-early", "b-mid", "a-late"]);
  });

  it("falls back to app name and id when timestamps tie", () => {
    const sameTs = "2026-04-12T09:14:40.00+0700";
    const rows = new Map([
      ["b", [buildRow({ id: 1, timestampRaw: sameTs, message: "b1" })]],
      ["a", [buildRow({ id: 1, timestampRaw: sameTs, message: "a1" })]],
    ]);
    const merged = mergeAppRows(rows);
    expect(merged.map((row) => `${row.appName}:${row.message}`)).toEqual([
      "a:a1",
      "b:b1",
    ]);
  });
});

describe("compareTailRows", () => {
  it("treats N/A timestamps as last", () => {
    const validTs = "2026-04-12T09:14:40.00+0700";
    const aRow = { ...buildRow({ timestampRaw: "N/A" }), appName: "a" };
    const bRow = { ...buildRow({ timestampRaw: validTs }), appName: "b" };
    expect(compareTailRows(aRow, bRow)).toBeGreaterThan(0);
    expect(compareTailRows(bRow, aRow)).toBeLessThan(0);
  });
});
