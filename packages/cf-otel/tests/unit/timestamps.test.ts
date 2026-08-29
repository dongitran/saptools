import { describe, expect, it } from "vitest";

import { parseNanoTimestamp, toEpochNanos } from "../../src/timestamps.js";

describe("parseNanoTimestamp", () => {
  it("parses a real 9-fractional-digit timestamp without truncating or throwing", () => {
    const parsed = parseNanoTimestamp("2026-08-28T03:05:46.542228853Z");
    expect(parsed.epochMillis).toBe(Date.parse("2026-08-28T03:05:46.542Z"));
    expect(parsed.nanosWithinMilli).toBe(228853);
  });

  it("pads a millisecond-only timestamp to zero sub-millisecond nanos", () => {
    expect(parseNanoTimestamp("2026-08-28T03:05:46.542Z").nanosWithinMilli).toBe(0);
  });

  it("handles a timestamp with no fractional seconds at all", () => {
    const parsed = parseNanoTimestamp("2026-08-28T03:05:46Z");
    expect(parsed.epochMillis).toBe(Date.parse("2026-08-28T03:05:46.000Z"));
    expect(parsed.nanosWithinMilli).toBe(0);
  });

  it("truncates a longer-than-9-digit fraction to nanosecond precision instead of throwing or silently rounding", () => {
    const parsed = parseNanoTimestamp("2026-08-28T03:05:46.1234567891234Z");
    expect(parsed.epochMillis).toBe(Date.parse("2026-08-28T03:05:46.123Z"));
    expect(parsed.nanosWithinMilli).toBe(456789);
  });

  it("throws on an invalid timestamp", () => {
    expect(() => parseNanoTimestamp("not-a-timestamp")).toThrow(/Invalid OTel timestamp/);
  });
});

describe("toEpochNanos", () => {
  it("produces the exact nanosecond-precision epoch value as a bigint", () => {
    const nanos = toEpochNanos("2026-08-28T03:05:46.542228853Z");
    const expectedMillis = BigInt(Date.parse("2026-08-28T03:05:46.542Z"));
    expect(nanos).toBe(expectedMillis * 1_000_000n + 228853n);
  });

  it("orders two timestamps that differ only in sub-millisecond precision correctly", () => {
    const a = toEpochNanos("2026-08-28T03:05:46.542228853Z");
    const b = toEpochNanos("2026-08-28T03:05:46.542228900Z");
    expect(a < b).toBe(true);
  });
});
