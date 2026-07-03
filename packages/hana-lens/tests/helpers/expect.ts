import assert from "node:assert/strict";

interface SyncMatchers {
  readonly resolves: AsyncMatchers;
  readonly rejects: RejectMatchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeLessThan(expected: number): void;
  toThrow(expected?: string): void;
}

interface AsyncMatchers {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
}

interface RejectMatchers {
  toThrow(expected?: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function expect(actual: unknown): SyncMatchers {
  return {
    resolves: {
      async toBe(expected: unknown): Promise<void> {
        assert.equal(await actual, expected);
      },
      async toEqual(expected: unknown): Promise<void> {
        assert.deepEqual(await actual, expected);
      },
    },
    rejects: {
      async toThrow(expected?: string): Promise<void> {
        await assert.rejects(async () => await actual, (error: unknown) => expected === undefined || messageOf(error).includes(expected));
      },
    },
    toBe(expected: unknown): void {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown): void {
      assert.deepEqual(actual, expected);
    },
    toContain(expected: unknown): void {
      assert.equal(String(actual).includes(String(expected)), true);
    },
    toHaveLength(expected: number): void {
      assert.equal((actual as { readonly length?: unknown }).length, expected);
    },
    toBeLessThan(expected: number): void {
      assert.equal(typeof actual, "number");
      assert.equal((actual as number) < expected, true);
    },
    toThrow(expected?: string): void {
      assert.equal(typeof actual, "function");
      assert.throws(actual as () => unknown, (error: unknown) => expected === undefined || messageOf(error).includes(expected));
    },
  };
}
