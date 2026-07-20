import { describe, expect, it } from "vitest";

import { resolveFunctionSelector } from "../../src/function-selector.js";

const SOURCE = `
function handle(input) { return input + 1; }
const calculate = (value) => value * 2;
class OrderService { create(order) { return order.id; } }
const handlers = { update(value) { return value; } };
`;

describe("runtime JavaScript function selector", () => {
  it("resolves declarations, arrows, class methods, and object methods", () => {
    const declaration = resolveFunctionSelector("runtime.js", SOURCE, "handle").candidate;
    expect(declaration.kind).toBe("function");
    expect(declaration.bodyStartOffset).toBeGreaterThan(declaration.startOffset);
    expect(declaration.bodyEndOffset).toBeLessThanOrEqual(declaration.endOffset);
    expect(resolveFunctionSelector("runtime.js", SOURCE, "calculate").candidate.kind).toBe("arrow");
    expect(resolveFunctionSelector("runtime.js", SOURCE, "OrderService.create").candidate.kind).toBe("class-method");
    expect(resolveFunctionSelector("runtime.js", SOURCE, "handlers.update").candidate.kind).toBe("object-method");
  });

  it("fails closed on ambiguous bare names", () => {
    const source = "class A { run() {} } class B { run() {} }";
    expect(() => resolveFunctionSelector("runtime.js", source, "run")).toThrowError(expect.objectContaining({
      code: "AMBIGUOUS_FUNCTION",
      candidates: expect.arrayContaining([
        expect.objectContaining({ selector: "A.run" }),
        expect.objectContaining({ selector: "B.run" }),
      ]),
    }));
  });

  it("treats one object method as one selectable candidate", () => {
    const selection = resolveFunctionSelector(
      "runtime.js",
      "const handlers = { update(value) { return value; } };",
      "update",
    );

    expect(selection.candidate.selector).toBe("handlers.update");
    expect(selection.candidates.filter((candidate) => candidate.localName === "update")).toHaveLength(1);
  });

  it("rejects async and await-bearing functions in the synchronous MVP", () => {
    expect(() => resolveFunctionSelector("runtime.js", "async function run() {}", "run")).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ASYNC_FUNCTION" }));
    expect(resolveFunctionSelector(
      "runtime.js",
      "function run() { return async () => await work(); }",
      "run",
    ).candidate.containsAwait).toBe(false);
  });

  it("resolves named function expressions and object function properties", () => {
    const source = [
      "const calculate = function internal(value) { return value * 2; };",
      "const handlers = { run: (value) => value, stop: function () { return false; } };",
    ].join("\n");

    expect(resolveFunctionSelector("runtime.js", source, "calculate").candidate.kind).toBe("function-expression");
    expect(resolveFunctionSelector("runtime.js", source, "handlers.run").candidate.selector).toBe("handlers.run");
    expect(resolveFunctionSelector("runtime.js", source, "handlers.stop").candidate.selector).toBe("handlers.stop");
  });

  it("reports a stable not-found error for unsupported or absent selectors", () => {
    expect(() => resolveFunctionSelector("runtime.js", SOURCE, "missing")).toThrowError(expect.objectContaining({
      code: "FUNCTION_NOT_FOUND",
    }));
  });

  it("resolves constructors, accessors, and class-field arrows", () => {
    const source = [
      "class Order {",
      "  constructor(id) { this.id = id; }",
      "  get identifier() { return this.id; }",
      "  handle = (value) => value;",
      "}",
      "const handlers = { get status() { return 'ready'; } };",
    ].join("\n");

    expect(resolveFunctionSelector("runtime.js", source, "Order.constructor").candidate.kind).toBe("constructor");
    expect(resolveFunctionSelector("runtime.js", source, "Order.identifier").candidate.kind).toBe("getter");
    expect(resolveFunctionSelector("runtime.js", source, "Order.handle").candidate.kind).toBe("arrow");
    expect(resolveFunctionSelector("runtime.js", source, "handlers.status").candidate.kind).toBe("getter");
  });

  it("resolves one-level runtime assignments", () => {
    const source = "handlers.run = function (value) { return value; };";

    expect(resolveFunctionSelector("runtime.js", source, "handlers.run").candidate).toMatchObject({
      kind: "function-expression",
      localName: "run",
    });
  });
});
