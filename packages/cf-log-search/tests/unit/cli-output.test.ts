import { describe, expect, it } from "vitest";

import { checkUpperLimit, parseFormat, parseNonNegativeIntOption, parsePositiveIntOption } from "../../src/cli/output.js";

describe("parseFormat", () => {
  it("accepts each of the four valid formats", () => {
    for (const format of ["table", "json", "json-compact", "csv"]) {
      expect(parseFormat(format)).toBe(format);
    }
  });
  it("rejects an unknown format", () => {
    expect(() => parseFormat("yaml")).toThrow(/Invalid --format/);
  });
  it("defaults to table when undefined", () => {
    expect(parseFormat(undefined)).toBe("table");
  });
});

describe("parseNonNegativeIntOption", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeIntOption("0")).toBe(0);
  });
  it("rejects a negative value", () => {
    expect(() => parseNonNegativeIntOption("-1")).toThrow(/non-negative/);
  });
});

describe("parsePositiveIntOption", () => {
  it("rejects zero", () => {
    expect(() => parsePositiveIntOption("0")).toThrow(/positive/);
  });
});

describe("checkUpperLimit", () => {
  it("throws when the limit exceeds MAX_RESULT_WINDOW", () => {
    expect(() => {
      checkUpperLimit(10_001);
    }).toThrow(/exceeds OpenSearch's single-page result-window ceiling/);
  });
  it("passes for a limit at or below the ceiling", () => {
    expect(() => {
      checkUpperLimit(10_000);
    }).not.toThrow();
  });
});
