import { describe, expect, it } from "vitest";

import {
  parsePositiveInteger,
  validateFunctionSelector,
  validateRunId,
  validateRuntimeFile,
} from "../../src/validation.js";

describe("trace input validation", () => {
  it("accepts bounded selectors, runtime paths, run IDs, and integers", () => {
    expect(validateFunctionSelector("OrderService.create")).toBe("OrderService.create");
    expect(validateRuntimeFile("/home/vcap/app/dist/order.js")).toBe("/home/vcap/app/dist/order.js");
    expect(validateRunId("t0123456789abcdef")).toBe("t0123456789abcdef");
    expect(parsePositiveInteger("25", "limit", 100)).toBe(25);
  });

  it("rejects traversal, ambiguous selector syntax, and out-of-range values", () => {
    expect(() => validateRunId("../manifest.json")).toThrowError(expect.objectContaining({ code: "INVALID_RUN_ID" }));
    expect(() => validateFunctionSelector("service[request.name]")).toThrowError(expect.objectContaining({ code: "INVALID_SELECTOR" }));
    expect(() => validateRuntimeFile("bad\0path.js")).toThrowError(expect.objectContaining({ code: "INVALID_RUNTIME_FILE" }));
    expect(() => parsePositiveInteger("101", "limit", 100)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("rejects traversal segments and non-canonical integer syntax", () => {
    expect(() => validateRuntimeFile("dist/../../secret.js")).toThrowError(expect.objectContaining({
      code: "INVALID_RUNTIME_FILE",
    }));
    expect(() => validateRuntimeFile("./../secret.js")).toThrowError(expect.objectContaining({
      code: "INVALID_RUNTIME_FILE",
    }));
    for (const raw of ["0", "-1", "1.5", "+1", "01", "1 "]) {
      expect(() => parsePositiveInteger(raw, "limit", 100)).toThrowError(expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }));
    }
  });

  it("trims valid selectors and runtime paths but keeps run IDs exact", () => {
    expect(validateFunctionSelector("  handler.run  ")).toBe("handler.run");
    expect(validateRuntimeFile("  dist/order.js  ")).toBe("dist/order.js");
    expect(() => validateRunId(" t0123456789abcdef ")).toThrowError(expect.objectContaining({
      code: "INVALID_RUN_ID",
    }));
  });
});
