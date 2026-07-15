import { describeEntity, formatCsnExpression } from "../../src/describe.js";
import { PACKAGE_ANNOTATION, type HanaLensCsn, type HanaLensElement } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

const ast: HanaLensCsn = { definitions: {
  A: { elements: { ID: { type: "cds.String", key: true, length: 36 }, computed: { type: "cds.Timestamp", "@Core.Computed": true }, generatedID: { type: "cds.UUID", key: true, "@Core.Computed": true }, toB: { type: "cds.Association", target: "B" } } },
  B: { elements: { BID: { type: "cds.Integer" }, toA: { type: "cds.Association", target: "A" }, toMissing: { type: "cds.Composition", target: "Missing" } } },
  Empty: {},
  EmptyElements: { elements: {} },
} };

describe("describeEntity", () => {
  it("prints dense fields with key, computed, type, and length information", () => {
    expect(describeEntity(ast, "A", false)).toBe("[PK] ID: cds.String(36)\n[computed] computed: cds.Timestamp\n[PK] [computed] generatedID: cds.UUID\ntoB: cds.Association to B");
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
        status: { type: "cds.String", enum: { ACTIVE: { val: "A" }, INACTIVE: { val: "INACTIVE" }, PENDING: { val: 0 }, UNSET: { val: undefined } }, "@readonly": true, "@title": "Status", "@Common.ValueList": { CollectionPath: "Statuses" } },
      } },
    } };

    expect(describeEntity(csn, "Project", false)).toBe('status: cds.String enum[ACTIVE = "A", INACTIVE, PENDING = 0, UNSET]');
    expect(describeEntity(csn, "Project", false, true)).toBe('status: cds.String enum[ACTIVE = "A", INACTIVE, PENDING = 0, UNSET] @Common.ValueList={"CollectionPath":"Statuses"} @readonly=true @title="Status"');
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

    expect(describeEntity(csn, "Employee", false)).toContain("departmentRef: cds.Association to Department ON [departmentRef.deptID = deptID and departmentRef.tenantID = tenantID]");
    expect(describeEntity(csn, "Employee", false)).toContain("projectRef: cds.Association to Project ON [projectRef.projectID = projectID]");
  });

  it("prints composition ON conditions while preserving expanded target traversal", () => {
    const csn: HanaLensCsn = { definitions: {
      Project: { elements: {
        ID: { type: "cds.String", key: true },
        tasks: {
          type: "cds.Composition",
          target: "Task",
          cardinality: { max: "*" },
          on: [{ ref: ["tasks", "projectID"] }, "=", { ref: ["ID"] }],
        },
      } },
      Task: { elements: { taskID: { type: "cds.String", key: true }, projectID: { type: "cds.String" } } },
    } };

    const output = describeEntity(csn, "Project", true);

    expect(output).toContain("tasks: cds.Composition to many Task ON [tasks.projectID = ID]");
    expect(output).toContain("- [PK] taskID: cds.String");
  });

  it("does not print an empty ON marker for empty expression arrays", () => {
    const csn: HanaLensCsn = { definitions: {
      Employee: { elements: { departmentRef: { type: "cds.Association", target: "Department", on: [] } } },
      Department: { elements: { ID: { type: "cds.String", key: true } } },
    } };

    expect(describeEntity(csn, "Employee", false)).toBe("departmentRef: cds.Association to Department");
  });

  it("prints numeric cardinality targets and safely ignores malformed non-array ON values", () => {
    const manager: HanaLensElement = { type: "cds.Association", target: "Employee", cardinality: { max: 1 } };
    Object.defineProperty(manager, "on", { value: "malformed" });
    const csn: HanaLensCsn = { definitions: {
      Employee: { elements: {
        manager,
        reports: { type: "cds.Association", target: "Employee", cardinality: { max: 2 } },
      } },
    } };

    expect(describeEntity(csn, "Employee", false)).toBe("manager: cds.Association to Employee\nreports: cds.Association to many Employee");
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
    expect(describeEntity(ast, "EmptyElements", false)).toBe("(no elements)");
  });

  it("prints definition-level enum values when an enum type has no elements", () => {
    const csn: HanaLensCsn = { definitions: {
      RequestStatus: { kind: "type", type: "cds.String", enum: { SUBMITTED: { val: "S" }, REJECTED: { val: "REJECTED" }, WARNING: {}, ZERO: { val: 0 } } },
    } };

    expect(describeEntity(csn, "RequestStatus", false)).toBe('cds.String enum[SUBMITTED = "S", REJECTED, WARNING, ZERO = 0]');
  });

  it("prints scalar and association type definitions instead of an empty marker", () => {
    const csn: HanaLensCsn = { definitions: {
      UserName: { kind: "type", type: "cds.String", length: 255 },
      OwnerLink: { kind: "type", type: "cds.Association", target: "acme.Owner" },
    } };

    expect(describeEntity(csn, "UserName", false)).toBe("cds.String(255)");
    expect(describeEntity(csn, "OwnerLink", false)).toBe("cds.Association to acme.Owner");
  });

  it("prints action and function parameters plus return types", () => {
    const csn: HanaLensCsn = { definitions: {
      LookupOwner: {
        kind: "function",
        params: { ownerID: { type: "cds.UUID" }, includeInactive: { type: "cds.Boolean" } },
        returns: { type: "cds.String", length: 80 },
      },
      ArchiveOwner: { kind: "action", params: { ownerID: { type: "cds.UUID" } } },
    } };

    expect(describeEntity(csn, "LookupOwner", false)).toBe("(function)\n- param ownerID: cds.UUID\n- param includeInactive: cds.Boolean\n- returns: cds.String(80)");
    expect(describeEntity(csn, "ArchiveOwner", false)).toBe("(action)\n- param ownerID: cds.UUID");
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
