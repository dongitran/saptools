import type { ParsedLogRow } from "@saptools/cf-logs";
import { describe, expect, it } from "vitest";

import { formatGroupedByApp, formatRowText, formatRowsText, pickAppColor } from "../../src/format.js";
import type { TailLogRow } from "../../src/types.js";

const ESC = String.fromCharCode(27);

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

describe("pickAppColor", () => {
  it("returns the same color for the same app", () => {
    expect(pickAppColor("demo")).toBe(pickAppColor("demo"));
  });
});

describe("formatRowText", () => {
  it("renders plain text without ANSI when color is false", () => {
    const row = buildRow({ message: "ready" });
    const text = formatRowText(row);
    expect(text).toContain("[demo-app]");
    expect(text).toContain("INFO");
    expect(text).toContain("ready");
    expect(text.includes(ESC)).toBe(false);
  });

  it("emits ANSI color sequences when color is true", () => {
    const row = buildRow({ level: "error", message: "boom" });
    const text = formatRowText(row, { color: true });
    expect(text.includes(ESC)).toBe(true);
    expect(text).toContain("ERROR");
  });

  it("includes request meta when requested", () => {
    const row = buildRow({ status: "500", latency: "2 ms", tenant: "tenant-a" });
    const text = formatRowText(row, { showRequestMeta: true });
    expect(text).toContain("status=500");
    expect(text).toContain("latency=2 ms");
    expect(text).toContain("tenant=tenant-a");
  });

  it("collapses embedded newlines in messages to keep one row per line", () => {
    const row = buildRow({ message: "line1\nline2\nline3" });
    const text = formatRowText(row);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("line1↵ line2↵ line3");
  });

  it("truncates long messages to the configured character budget", () => {
    const row = buildRow({ message: "a".repeat(100) });
    const text = formatRowText(row, { truncateMessage: 20 });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(60 + row.appName.length);
  });

  it("does not truncate when truncateMessage is undefined", () => {
    const row = buildRow({ message: "a".repeat(100) });
    const text = formatRowText(row);
    expect(text).not.toContain("…");
  });
});

describe("formatRowsText", () => {
  it("aligns the app column across rows", () => {
    const lines = formatRowsText([
      buildRow({ appName: "a" }),
      buildRow({ appName: "longer-app" }),
    ]).split("\n");
    expect(lines[0]).toContain("[a         ]");
    expect(lines[1]).toContain("[longer-app]");
  });

  it("supports the showSource option in colored mode", () => {
    const text = formatRowsText(
      [buildRow({ message: "ready", source: "RTR/0" })],
      { color: true, showSource: true },
    );
    expect(text).toContain("RTR/0");
    expect(text.includes(ESC)).toBe(true);
  });
});

describe("formatGroupedByApp", () => {
  it("emits one section per app", () => {
    const text = formatGroupedByApp([
      buildRow({ appName: "alpha", id: 1 }),
      buildRow({ appName: "beta", id: 1 }),
      buildRow({ appName: "alpha", id: 2 }),
    ]);
    expect(text).toContain("=== alpha (2 rows) ===");
    expect(text).toContain("=== beta (1 rows) ===");
  });

  it("emits colored headers when color is enabled", () => {
    const text = formatGroupedByApp(
      [buildRow({ appName: "alpha" })],
      { color: true },
    );
    expect(text.includes(ESC)).toBe(true);
    expect(text).toContain("=== alpha (1 rows) ===");
  });
});
