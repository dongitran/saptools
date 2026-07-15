import { describeEntity, formatCsnExpression } from "../../src/describe.js";
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
    expect(describeEntity(ast, "A", false)).toBe("[PK] ID: cds.String(36)\n[computed] computed: cds.Timestamp\ntoB: cds.Association");
  });

  it("prints Decimal precision and scale while preserving length parameters", () => {
    const csn: HanaLensCsn = { definitions: {
      Measurement: { elements: {
        lowerTolerance: { type: "cds.Decimal", precision: 3, scale: 1 },
        upperTolerance: { type: "cds.Decimal", precision: 5 },
        label: { type: "cds.String", length: 255 },
      } },
    } };

    expect(describeEntity(csn, "Measurement", false)).toBe("lowerTolerance: cds.Decimal(3, 1)\nupperTolerance: cds.Decimal(5)\nlabel: cds.String(255)");
  });

  it("prints arrays of scalar and anonymous structured items", () => {
    const requiredStringItem = { type: "cds.String", notNull: true };
    const csn: HanaLensCsn = { definitions: {
      Request: { elements: {
        history: { items: { type: "cds.Map" } },
        tags: { items: requiredStringItem },
        labels: { items: { elements: { value: { type: "cds.String" }, label: { type: "cds.String" } } } },
      } },
    } };

    expect(describeEntity(csn, "Request", false)).toBe("history: array of cds.Map\ntags: array of cds.String\nlabels: array of { value, label }");
  });

  it("always prints enum keys and gates element annotations behind an option", () => {
    const csn: HanaLensCsn = { definitions: {
      Project: { elements: {
        status: { type: "cds.String", enum: { ACTIVE: {}, INACTIVE: {} }, "@readonly": true, "@title": "Status", "@Common.ValueList": { CollectionPath: "Statuses" } },
      } },
    } };

    expect(describeEntity(csn, "Project", false)).toBe("status: cds.String enum[ACTIVE, INACTIVE]");
    expect(describeEntity(csn, "Project", false, true)).toBe('status: cds.String enum[ACTIVE, INACTIVE] @Common.ValueList={"CollectionPath":"Statuses"} @readonly=true @title="Status"');
  });

  it("expands associations with circular and missing target guards", () => {
    const output = describeEntity(ast, "A", true);
    expect(output).toContain("-- A: circular");
    expect(output).toContain("-- Missing: missing");
  });

  it("prints association ON conditions for single-key and composite relationships", () => {
    const csn: HanaLensCsn = { definitions: {
      Employee: { elements: {
        employeeID: { type: "cds.String", key: true },
        tenantID: { type: "cds.String", key: true },
        deptID: { type: "cds.String" },
        departmentRef: {
          type: "cds.Association",
          target: "Department",
          on: [{ ref: ["departmentRef", "deptID"] }, "=", { ref: ["deptID"] }, "and", { ref: ["departmentRef", "tenantID"] }, "=", { ref: ["tenantID"] }],
        },
        projectRef: {
          type: "cds.Association",
          target: "Project",
          on: [{ ref: ["projectRef", "projectID"] }, "=", { ref: ["projectID"] }],
        },
      } },
      Department: { elements: { deptID: { type: "cds.String", key: true }, tenantID: { type: "cds.String", key: true } } },
      Project: { elements: { projectID: { type: "cds.String", key: true } } },
    } };

    expect(describeEntity(csn, "Employee", false)).toContain("departmentRef: cds.Association ON [departmentRef.deptID = deptID and departmentRef.tenantID = tenantID]");
    expect(describeEntity(csn, "Employee", false)).toContain("projectRef: cds.Association ON [projectRef.projectID = projectID]");
  });

  it("prints composition ON conditions while preserving expanded target traversal", () => {
    const csn: HanaLensCsn = { definitions: {
      Project: { elements: {
        ID: { type: "cds.String", key: true },
        tasks: {
          type: "cds.Composition",
          target: "Task",
          on: [{ ref: ["tasks", "projectID"] }, "=", { ref: ["ID"] }],
        },
      } },
      Task: { elements: { taskID: { type: "cds.String", key: true }, projectID: { type: "cds.String" } } },
    } };

    const output = describeEntity(csn, "Project", true);

    expect(output).toContain("tasks: cds.Composition ON [tasks.projectID = ID]");
    expect(output).toContain("- [PK] taskID: cds.String");
  });

  it("does not print an empty ON marker for empty expression arrays", () => {
    const csn: HanaLensCsn = { definitions: {
      Employee: { elements: { departmentRef: { type: "cds.Association", target: "Department", on: [] } } },
      Department: { elements: { ID: { type: "cds.String", key: true } } },
    } };

    expect(describeEntity(csn, "Employee", false)).toBe("departmentRef: cds.Association");
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

  it("prints definition-level enum values when an enum type has no elements", () => {
    const csn: HanaLensCsn = { definitions: {
      RequestStatus: { kind: "type", type: "cds.String", enum: { SUBMITTED: {}, REJECTED: {}, WARNING: {} } },
    } };

    expect(describeEntity(csn, "RequestStatus", false)).toBe("cds.String enum[SUBMITTED, REJECTED, WARNING]");
  });

  it("throws for missing entities", () => {
    expect(() => describeEntity(ast, "Missing", false)).toThrow("Entity not found: Missing");
  });
});

describe("formatCsnExpression", () => {
  it("formats refs, operators, and literal values densely", () => {
    expect(formatCsnExpression([{ ref: ["status"] }, "=", { val: "Active" }, "and", { ref: ["priority"] }, ">", { val: 3 }])).toBe("status = \"Active\" and priority > 3");
  });

  it("falls back to JSON for unknown nodes without throwing", () => {
    expect(formatCsnExpression([{ SELECT: { from: { ref: ["Tasks"] } } }, "=", { val: true }])).toBe("{\"SELECT\":{\"from\":{\"ref\":[\"Tasks\"]}}} = true");
  });

  it("formats nested expressions, function arguments, lists, and filtered refs", () => {
    expect(formatCsnExpression([
      { xpr: [{ ref: ["task", "status"] }, "=", { val: "Open" }, "or", { ref: ["task", "priority"] }, ">", { val: 3 }] },
      "and",
      { func: "contains", args: [{ ref: ["task", "title"] }, { val: "urgent" }] },
      "and",
      { ref: [{ id: "task", where: [{ ref: ["active"] }, "=", { val: true }] }, "ownerID"] },
      "in",
      { list: [{ val: "A" }, { val: "B" }] },
    ])).toBe("(task.status = \"Open\" or task.priority > 3) and contains(task.title, \"urgent\") and task[active = true].ownerID in (\"A\", \"B\")");
  });

  it("keeps fallback safe when an unknown node cannot be JSON serialized", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(formatCsnExpression([circular])).toBe("[unserializable]");
  });

  it("formats unusual primitive and undefined-serialization values deterministically", () => {
    const undefinedJson = { toJSON: (): undefined => undefined };

    expect(formatCsnExpression([{ val: 9007199254740993n }, "=", undefinedJson])).toBe("9007199254740993 = [unserializable]");
  });
});
