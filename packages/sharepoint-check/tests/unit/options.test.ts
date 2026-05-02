import { describe, expect, it } from "vitest";

import { parseDepth } from "../../src/cli/options.js";

describe("parseDepth", () => {
  it("returns undefined when depth is omitted or empty", () => {
    expect(parseDepth(undefined)).toBeUndefined();
    expect(parseDepth("")).toBeUndefined();
  });

  it("accepts non-negative integer strings", () => {
    expect(parseDepth("0")).toBe(0);
    expect(parseDepth("3")).toBe(3);
    expect(parseDepth(" 12 ")).toBe(12);
  });

  it("rejects partial, decimal, and negative values", () => {
    expect(() => parseDepth("1abc")).toThrow(/Invalid --depth/);
    expect(() => parseDepth("1.5")).toThrow(/Invalid --depth/);
    expect(() => parseDepth("-1")).toThrow(/Invalid --depth/);
  });
});
