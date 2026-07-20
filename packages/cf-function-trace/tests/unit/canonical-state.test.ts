import { describe, expect, it } from "vitest";

import { canonicalizeState } from "../../src/canonical-state.js";

describe("canonical trace state", () => {
  it("produces insertion-order-independent text and hashes", () => {
    const left = canonicalizeState({ z: 1, nested: { b: 2, a: 1 } });
    const right = canonicalizeState({ nested: { a: 1, b: 2 }, z: 1 });
    expect(left).toEqual(right);
  });

  it("redacts before producing canonical text and hash input", () => {
    const canonical = canonicalizeState({ password: "raw-secret-sentinel", safe: true });
    expect(canonical.text).not.toContain("raw-secret-sentinel");
    expect(canonical.value).toEqual({ password: { kind: "redacted" }, safe: true });
  });

  it("normalizes non-JSON primitives without losing their meaning", () => {
    const canonical = canonicalizeState({
      missing: undefined,
      large: 42n,
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeZero: -0,
      symbol: Symbol("marker"),
      callback: (): void => undefined,
    });

    expect(canonical.value).toEqual({
      callback: { kind: "unavailable", description: "function" },
      large: { kind: "bigint", value: "42" },
      missing: { kind: "undefined" },
      nan: { kind: "special-number", value: "NaN" },
      negativeZero: { kind: "special-number", value: "-0" },
      positiveInfinity: { kind: "special-number", value: "Infinity" },
      symbol: { kind: "unavailable", description: "symbol" },
    });
  });

  it("canonicalizes arrays and cyclic input deterministically", () => {
    const value: { list: readonly unknown[]; self?: unknown } = { list: [3, null, false] };
    value.self = value;

    expect(canonicalizeState(value).value).toEqual({
      list: [3, null, false],
      self: { description: "cyclic-input", kind: "unavailable" },
    });
  });

  it("uses locale-independent key ordering", () => {
    expect(canonicalizeState({ "ä": 3, a: 2, Z: 1 }).text).toBe('{"Z":1,"a":2,"ä":3}');
  });

  it("preserves an own __proto__ key without mutating prototypes", () => {
    const input: unknown = JSON.parse('{"__proto__":{"token":"secret-value"},"safe":true}');
    const canonical = canonicalizeState(input);

    expect(canonical.text).toBe('{"__proto__":{"token":{"kind":"redacted"}},"safe":true}');
    expect(Object.hasOwn(Object.prototype, "token")).toBe(false);
  });
});
