import { describe, expect, it } from "vitest";

import { errorMessage, runWithConcurrency } from "../../src/utils.js";

describe("runWithConcurrency", () => {
  it("processes all items", async () => {
    const processed: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      processed.push(n);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs with concurrency 1 sequentially", async () => {
    const order: number[] = [];
    await runWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("handles an empty array", async () => {
    const processed: number[] = [];
    await runWithConcurrency([], 5, async (n: number) => {
      processed.push(n);
    });
    expect(processed).toHaveLength(0);
  });

  it("does not exceed concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(errorMessage(new Error("something failed"))).toBe("something failed");
  });

  it("converts non-Error to string", () => {
    expect(errorMessage("raw string")).toBe("raw string");
    expect(errorMessage(42)).toBe("42");
  });

  it("handles null and undefined", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
