import { describe, expect, it } from "vitest";

import { parseRecentLogs } from "../../src/parser.js";
import {
  filterRowsSince,
  formatRowsAsRawText,
  parseSinceDurationMs,
} from "../../src/time-window.js";

describe("time window helpers", () => {
  it("parses compact duration values", () => {
    expect(parseSinceDurationMs("15m")).toBe(15 * 60_000);
    expect(parseSinceDurationMs("45m")).toBe(45 * 60_000);
    expect(parseSinceDurationMs("1h")).toBe(60 * 60_000);
    expect(parseSinceDurationMs("2d")).toBe(2 * 24 * 60 * 60_000);
  });

  it("rejects invalid duration values", () => {
    expect(() => parseSinceDurationMs("0m")).toThrow("--since");
    expect(() => parseSinceDurationMs("1x")).toThrow("--since");
    expect(() => parseSinceDurationMs("1.5h")).toThrow("--since");
  });

  it("filters rows by outer CF timestamp and renumbers kept rows", () => {
    const rows = parseRecentLogs(
      [
        "2026-04-12T09:00:00.00+0700 [APP/PROC/WEB/0] OUT before window",
        "2026-04-12T09:30:00.00+0700 [APP/PROC/WEB/0] OUT inside window",
        "2026-04-12T10:00:00.00+0700 [RTR/0] OUT host.example.test - [2026-04-12T03:00:00.000Z] \"GET /health HTTP/1.1\" 200 0 2 \"-\" \"agent/1.0\" \"10.0.0.1:1\" \"10.0.0.2:2\" response_time:0.002",
      ].join("\n"),
    );

    const filtered = filterRowsSince(rows, 45 * 60_000, new Date("2026-04-12T03:00:00.000Z"));

    expect(filtered.map((row) => row.id)).toEqual([1, 2]);
    expect(filtered[0]?.message).toBe("inside window");
    expect(filtered[1]?.request).toBe("GET /health");
  });

  it("omits rows without a usable timestamp when a time window is active", () => {
    const rows = parseRecentLogs(
      [
        "plain leading line",
        "2026-04-12T10:00:00.00+0700 [APP/PROC/WEB/0] OUT inside window",
      ].join("\n"),
    );

    const filtered = filterRowsSince(rows, 60 * 60_000, new Date("2026-04-12T03:00:00.000Z"));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.message).toBe("inside window");
  });

  it("formats filtered rows back to bounded raw text", () => {
    const rows = parseRecentLogs(
      "2026-04-12T10:00:00.00+0700 [APP/PROC/WEB/0] OUT inside window",
    );

    expect(formatRowsAsRawText(rows)).toBe(
      "2026-04-12T10:00:00.00+0700 [APP/PROC/WEB/0] OUT inside window",
    );
  });
});
