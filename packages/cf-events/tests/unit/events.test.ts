import { describe, expect, it } from "vitest";

import {
  durationToCreatedAfter,
  filterByTypes,
  isCrashEvent,
  isSshEvent,
  parseDuration,
  parseTypeFilter,
  sortEventsNewestFirst,
  summarizeCrashes,
  toCrashRecord,
} from "../../src/events.js";

import { makeEvent } from "./factories.js";

describe("isCrashEvent / isSshEvent", () => {
  it("detects crash event types", () => {
    expect(isCrashEvent(makeEvent({ type: "audit.app.process.crash" }))).toBe(true);
    expect(isCrashEvent(makeEvent({ type: "audit.app.crash" }))).toBe(true);
    expect(isCrashEvent(makeEvent({ type: "audit.app.start" }))).toBe(false);
  });

  it("detects ssh event types", () => {
    expect(isSshEvent(makeEvent({ type: "audit.app.ssh-authorized" }))).toBe(true);
    expect(isSshEvent(makeEvent({ type: "audit.app.ssh-unauthorized" }))).toBe(true);
    expect(isSshEvent(makeEvent({ type: "audit.app.stop" }))).toBe(false);
  });
});

describe("filterByTypes", () => {
  it("returns all events unchanged when no types are given", () => {
    const events = [makeEvent()];
    expect(filterByTypes(events, [])).toBe(events);
  });

  it("keeps only matching event types", () => {
    const events = [
      makeEvent({ guid: "a", type: "audit.app.start" }),
      makeEvent({ guid: "b", type: "audit.app.stop" }),
    ];
    expect(filterByTypes(events, ["audit.app.stop"]).map((event) => event.guid)).toEqual(["b"]);
  });
});

describe("sortEventsNewestFirst", () => {
  it("orders events by createdAt descending", () => {
    const events = [
      makeEvent({ guid: "old", createdAt: "2026-05-20T00:00:00Z" }),
      makeEvent({ guid: "new", createdAt: "2026-05-22T00:00:00Z" }),
    ];
    expect(sortEventsNewestFirst(events).map((event) => event.guid)).toEqual(["new", "old"]);
  });
});

describe("parseDuration", () => {
  it("parses second, minute, hour, and day units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("tolerates whitespace and uppercase units", () => {
    expect(parseDuration(" 10 M ")).toBe(600_000);
  });

  it("rejects malformed or zero durations", () => {
    expect(() => parseDuration("abc")).toThrow(/Invalid duration/);
    expect(() => parseDuration("0h")).toThrow(/Invalid duration/);
    expect(() => parseDuration("10y")).toThrow(/Invalid duration/);
  });
});

describe("durationToCreatedAfter", () => {
  it("subtracts the duration and formats without fractional seconds", () => {
    const now = new Date("2026-07-06T00:00:00.000Z");
    expect(durationToCreatedAfter("24h", now)).toBe("2026-07-05T00:00:00Z");
  });

  it("drops non-zero milliseconds for CF audit-event filters", () => {
    const now = new Date("2026-07-06T08:19:03.456Z");
    expect(durationToCreatedAfter("30m", now)).toBe("2026-07-06T07:49:03Z");
  });
});

describe("parseTypeFilter", () => {
  it("returns an empty list when no filter is provided", () => {
    expect(parseTypeFilter(undefined)).toEqual([]);
  });

  it("expands the ssh and crash shorthands", () => {
    expect(parseTypeFilter("ssh")).toEqual([
      "audit.app.ssh-authorized",
      "audit.app.ssh-unauthorized",
    ]);
    expect(parseTypeFilter("crash")).toEqual(["audit.app.crash", "audit.app.process.crash"]);
  });

  it("accepts full event types and removes duplicates", () => {
    expect(parseTypeFilter("audit.app.start, audit.app.start")).toEqual(["audit.app.start"]);
  });

  it("rejects unknown tokens", () => {
    expect(() => parseTypeFilter("nonsense")).toThrow(/Unknown event type/);
  });
});

describe("toCrashRecord / summarizeCrashes", () => {
  it("extracts crash details from event data", () => {
    const record = toCrashRecord(
      makeEvent({
        type: "audit.app.process.crash",
        createdAt: "2026-05-22T09:00:00Z",
        data: { index: 2, reason: "CRASHED", exit_status: 1 },
      }),
    );
    expect(record).toEqual({
      at: "2026-05-22T09:00:00Z",
      index: 2,
      reason: "CRASHED",
      exitStatus: 1,
    });
  });

  it("falls back to exit_description for the crash reason", () => {
    const record = toCrashRecord(makeEvent({ data: { exit_description: "out of memory" } }));
    expect(record.reason).toBe("out of memory");
  });

  it("summarizes crashes with the newest crash first", () => {
    const summary = summarizeCrashes("orders-srv", [
      makeEvent({ guid: "x", type: "audit.app.start" }),
      makeEvent({ guid: "c1", type: "audit.app.crash", createdAt: "2026-05-20T00:00:00Z" }),
      makeEvent({
        guid: "c2",
        type: "audit.app.crash",
        createdAt: "2026-05-22T00:00:00Z",
        data: { reason: "boom" },
      }),
    ]);
    expect(summary.crashCount).toBe(2);
    expect(summary.lastCrashAt).toBe("2026-05-22T00:00:00Z");
    expect(summary.lastCrashReason).toBe("boom");
  });

  it("reports zero crashes for an app with none", () => {
    const summary = summarizeCrashes("orders-srv", [makeEvent()]);
    expect(summary.crashCount).toBe(0);
    expect(summary.lastCrashAt).toBeUndefined();
    expect(summary.lastCrashReason).toBeUndefined();
  });
});
