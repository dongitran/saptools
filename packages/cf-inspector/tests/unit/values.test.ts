import { describe, expect, it } from "vitest";

import { formatPrimitive, isPrimitive, toStructuredValue } from "../../src/snapshot/values.js";
import type { VariableSnapshot } from "../../src/types.js";

function variable(
  name: string,
  value: string,
  type?: string,
  children?: readonly VariableSnapshot[],
): VariableSnapshot {
  const base: VariableSnapshot = { name, value };
  const withType = type === undefined ? base : { ...base, type };
  return children === undefined ? withType : { ...withType, children };
}

describe("isPrimitive", () => {
  it("recognizes primitive typeof results", () => {
    expect(isPrimitive("x")).toBe(true);
    expect(isPrimitive(7)).toBe(true);
    expect(isPrimitive(true)).toBe(true);
    expect(isPrimitive(7n)).toBe(true);
    expect(isPrimitive(Symbol("s"))).toBe(true);
  });

  it("rejects objects, null, undefined, and functions", () => {
    expect(isPrimitive({})).toBe(false);
    expect(isPrimitive([])).toBe(false);
    expect(isPrimitive(null)).toBe(false);
    expect(isPrimitive(undefined)).toBe(false);
    expect(isPrimitive(() => undefined)).toBe(false);
  });
});

describe("formatPrimitive", () => {
  it("renders bigint with the trailing n suffix used by JS literal syntax", () => {
    expect(formatPrimitive(42n)).toBe("42n");
  });

  it("renders symbols via their canonical toString form", () => {
    const s = Symbol("token");
    expect(formatPrimitive(s)).toBe(s.toString());
  });

  it("renders other primitives via String() coercion", () => {
    expect(formatPrimitive(42)).toBe("42");
    expect(formatPrimitive(true)).toBe("true");
    expect(formatPrimitive("hi")).toBe("hi");
  });
});

describe("toStructuredValue scalar branches", () => {
  it("decodes a JSON-quoted string back to its raw form", () => {
    expect(toStructuredValue(variable("k", '"hello"', "string"))).toBe("hello");
  });

  it("falls back to the raw value when a string cannot be JSON-decoded", () => {
    expect(toStructuredValue(variable("k", "not-quoted", "string"))).toBe("not-quoted");
  });

  it("parses finite numbers", () => {
    expect(toStructuredValue(variable("k", "42", "number"))).toBe(42);
  });

  it("preserves the raw string when number coercion is non-finite", () => {
    expect(toStructuredValue(variable("k", "Infinity", "number"))).toBe("Infinity");
  });

  it("decodes booleans only on the canonical 'true' / 'false' literals", () => {
    expect(toStructuredValue(variable("k", "true", "boolean"))).toBe(true);
    expect(toStructuredValue(variable("k", "false", "boolean"))).toBe(false);
    // Unexpected boolean rendering — fall through to the raw string so we
    // do not silently lie about the value.
    expect(toStructuredValue(variable("k", "weird", "boolean"))).toBe("weird");
  });

  it("renders undefined as a sentinel string so JSON.stringify does not drop the key", () => {
    expect(toStructuredValue(variable("k", "undefined", "undefined"))).toBe("[undefined]");
  });

  it("keeps bigint values as their string representation (not JSON-serializable as native)", () => {
    expect(toStructuredValue(variable("k", "7n", "bigint"))).toBe("7n");
  });

  it("decodes the literal string 'null' as a real null when the type is unspecified", () => {
    expect(toStructuredValue(variable("k", "null"))).toBeNull();
  });
});

describe("toStructuredValue collection branches", () => {
  it("returns a dense array when all children look numeric (and length is ignored)", () => {
    const arr = variable("arr", "[1,2,3]", "object", [
      variable("0", "1", "number"),
      variable("1", "2", "number"),
      variable("2", "3", "number"),
      variable("length", "3", "number"),
    ]);
    expect(toStructuredValue(arr)).toEqual([1, 2, 3]);
  });

  it("fills sparse holes with null when indexes skip entries", () => {
    const sparse = variable("arr", "[, 'b']", "object", [
      variable("1", '"b"', "string"),
    ]);
    expect(toStructuredValue(sparse)).toEqual([null, "b"]);
  });

  it("rejects leading-zero indexes so '01' stays a string key", () => {
    const obj = variable("obj", "{}", "object", [
      variable("01", '"a"', "string"),
    ]);
    expect(toStructuredValue(obj)).toEqual({ "01": "a" });
  });

  it("keeps mixed numeric and string keys as an object so string keys are not dropped", () => {
    // Without the array/object discriminator, `0` would force the array path
    // and silently drop `name` — a real-world hit for sparse arrays decorated
    // with extra properties.
    const mixed = variable("obj", "{0:'a',name:'b'}", "object", [
      variable("0", '"a"', "string"),
      variable("name", '"b"', "string"),
    ]);
    expect(toStructuredValue(mixed)).toEqual({ "0": "a", name: "b" });
  });

  it("returns a plain object for purely string-keyed children", () => {
    const obj = variable("obj", "{}", "object", [
      variable("a", "1", "number"),
      variable("b", '"x"', "string"),
    ]);
    expect(toStructuredValue(obj)).toEqual({ a: 1, b: "x" });
  });

  it("recurses into nested children of either shape", () => {
    const tree = variable("root", "{}", "object", [
      variable("user", "{}", "object", [
        variable("id", "7", "number"),
        variable("name", '"alice"', "string"),
      ]),
      variable("ids", "[1,2]", "object", [
        variable("0", "1", "number"),
        variable("1", "2", "number"),
        variable("length", "2", "number"),
      ]),
    ]);
    expect(toStructuredValue(tree)).toEqual({
      user: { id: 7, name: "alice" },
      ids: [1, 2],
    });
  });
});
