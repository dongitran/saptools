import { describe, expect, it } from "vitest";

import {
  formatDurationNanos,
  formatPercent,
  formatSignedDuration,
  formatSignedPercent,
} from "../../src/cli/display.js";

describe("formatDurationNanos", () => {
  it("formats nanoseconds", () => {
    expect(formatDurationNanos(500)).toBe("500ns");
  });

  it("formats microseconds", () => {
    expect(formatDurationNanos(4_500)).toBe("4.5µs");
  });

  it("formats milliseconds", () => {
    expect(formatDurationNanos(4_231_000)).toBe("4.231ms");
  });

  it("formats seconds", () => {
    expect(formatDurationNanos(124_236_000_000)).toBe("124.236s");
  });

  it("keeps the sign for a negative duration instead of formatting the raw negative number", () => {
    // gaps.ts reports negative gaps for overlapping children (see gaps.test.ts) —
    // this must render as "-100.000ms", not the unsigned-lookalike "-100000000ns".
    expect(formatDurationNanos(-100_000_000)).toBe("-100.000ms");
  });

  it("formats a negative sub-microsecond duration", () => {
    expect(formatDurationNanos(-500)).toBe("-500ns");
  });
});

describe("formatPercent", () => {
  it("formats a percentage to two decimals", () => {
    expect(formatPercent(51.234)).toBe("51.23%");
  });

  it("returns an empty string for undefined", () => {
    expect(formatPercent(undefined)).toBe("");
  });
});

describe("formatSignedDuration", () => {
  it("prefixes a positive delta with +", () => {
    expect(formatSignedDuration(2_000_000_000)).toBe("+2.000s");
  });

  it("prefixes a negative delta with -", () => {
    expect(formatSignedDuration(-2_000_000_000)).toBe("-2.000s");
  });

  it("has no sign for a zero delta", () => {
    expect(formatSignedDuration(0)).toBe("0ns");
  });
});

describe("formatSignedPercent", () => {
  it("computes a positive percent change", () => {
    expect(formatSignedPercent(100, 140)).toBe("+40.0%");
  });

  it("computes a negative percent change", () => {
    expect(formatSignedPercent(100, 60)).toBe("-40.0%");
  });

  it("returns an empty string when the baseline is zero", () => {
    expect(formatSignedPercent(0, 100)).toBe("");
  });
});
