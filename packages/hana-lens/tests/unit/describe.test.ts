import { describeEntity } from "../../src/describe.js";
import { PACKAGE_ANNOTATION, type HanaLensCsn } from "../../src/types.js";
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

  it("expands a short association target when it uniquely resolves to a full definition name", () => {
    const csn: HanaLensCsn = { definitions: {
      "demo.sales.Order": {
        [PACKAGE_ANNOTATION]: "@demo/sales",
        elements: { customer: { type: "cds.Association", target: "Customer" } },
      },
      "demo.master.Customer": {
        [PACKAGE_ANNOTATION]: "@demo/master",
        elements: { ID: { type: "cds.Integer", key: true } },
      },
    } };

    const output = describeEntity(csn, "demo.sales.Order", true);

    expect(output).toContain("- [PK] ID: cds.Integer");
    expect(output.includes("Customer: missing")).toBe(false);
  });

  it("reports ambiguous short association targets instead of expanding an arbitrary match", () => {
    const csn: HanaLensCsn = { definitions: {
      "demo.sales.Order": {
        [PACKAGE_ANNOTATION]: "@demo/sales",
        elements: { customer: { type: "cds.Association", target: "Customer" } },
      },
      "demo.master.Customer": {
        [PACKAGE_ANNOTATION]: "@demo/master",
        elements: { ID: { type: "cds.Integer", key: true } },
      },
      "demo.crm.Customer": {
        [PACKAGE_ANNOTATION]: "@demo/crm",
        elements: { number: { type: "cds.String" } },
      },
    } };

    expect(describeEntity(csn, "demo.sales.Order", true)).toContain("- Customer: ambiguous");
  });

  it("prefers a same-package short association target when suffix matches are otherwise ambiguous", () => {
    const csn: HanaLensCsn = { definitions: {
      "demo.sales.Order": {
        [PACKAGE_ANNOTATION]: "@demo/sales",
        elements: { customer: { type: "cds.Association", target: "Customer" } },
      },
      "demo.sales.Customer": {
        [PACKAGE_ANNOTATION]: "@demo/sales",
        elements: { localID: { type: "cds.Integer", key: true } },
      },
      "demo.master.Customer": {
        [PACKAGE_ANNOTATION]: "@demo/master",
        elements: { remoteID: { type: "cds.Integer", key: true } },
      },
    } };

    const output = describeEntity(csn, "demo.sales.Order", true);

    expect(output).toContain("- [PK] localID: cds.Integer");
    expect(output.includes("- [PK] remoteID: cds.Integer")).toBe(false);
  });

  it("prints a compact empty marker for definitions without elements", () => {
    expect(describeEntity(ast, "Empty", false)).toBe("(no elements)");
  });

  it("throws for missing entities", () => {
    expect(() => describeEntity(ast, "Missing", false)).toThrow("Entity not found: Missing");
  });
});
