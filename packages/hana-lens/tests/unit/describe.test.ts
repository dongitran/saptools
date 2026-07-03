import { describeEntity } from "../../src/describe.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

const ast: HanaLensCsn = { definitions: {
  A: { elements: { ID: { type: "cds.String", key: true, length: 36 }, computed: { type: "cds.Timestamp", "@Core.Computed": true }, toB: { type: "cds.Association", target: "B" } } },
  B: { elements: { BID: { type: "cds.Integer" }, toA: { type: "cds.Association", target: "A" }, toMissing: { type: "cds.Composition", target: "Missing" } } },
  Empty: {},
} };

describe("describeEntity", () => {
  it("prints dense fields with key, computed, type, and length information", () => {
    expect(describeEntity(ast, "A", false)).toBe("[PK] ID: cds.String(36)\n[PK] computed: cds.Timestamp\ntoB: cds.Association");
  });

  it("expands associations with circular and missing target guards", () => {
    const output = describeEntity(ast, "A", true);
    expect(output).toContain("-- A: circular");
    expect(output).toContain("-- Missing: missing");
  });

  it("prints a compact empty marker for definitions without elements", () => {
    expect(describeEntity(ast, "Empty", false)).toBe("(no elements)");
  });

  it("throws for missing entities", () => {
    expect(() => describeEntity(ast, "Missing", false)).toThrow("Entity not found: Missing");
  });
});