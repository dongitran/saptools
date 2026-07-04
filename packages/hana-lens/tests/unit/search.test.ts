import { findIncomingReferences, formatFieldSearchResults, formatIncomingReferences, formatSearchResults, searchDefinitions, searchFields } from "../../src/search.js";
import type { HanaLensCsn } from "../../src/types.js";
import { expect } from "../helpers/expect.js";
import { describe, it } from "../helpers/test.js";

const ast: HanaLensCsn = { definitions: {
  "srv.BusinessRequest": { "@hanaLens.packageName": "@demo/sales" },
  "srv.Customer": { "@hanaLens.packageName": "@demo/master" },
  "srv.Order": { "@hanaLens.packageName": "@demo/sales" },
  ...Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`srv.Generated${index.toString().padStart(2, "0")}`, { "@hanaLens.packageName": "@demo/generated" }])),
} };

describe("searchDefinitions", () => {
  it("returns dense case-insensitive fuzzy matches", () => {
    const results = searchDefinitions(ast, "businesreq", false);
    expect(results[0]?.name).toBe("srv.BusinessRequest");
    expect(formatSearchResults(results.slice(0, 1))).toBe("srv.BusinessRequest|@demo/sales");
  });

  it("uses regex without fuzzy ordering", () => {
    expect(searchDefinitions(ast, "Customer$", true)).toEqual([{ name: "srv.Customer", packageName: "@demo/master", score: 0 }]);
  });

  it("limits output to the top ten matches", () => {
    expect(searchDefinitions(ast, "srv", false)).toHaveLength(10);
  });

  it("surfaces invalid regular expressions and rejects empty keywords", () => {
    expect(() => searchDefinitions(ast, "[", true)).toThrow();
    expect(() => searchDefinitions(ast, "   ", false)).toThrow("Search keyword must not be empty");
  });
});

describe("searchFields", () => {
  const fieldAst: HanaLensCsn = { definitions: {
    Employee: { elements: { ID: { type: "cds.String" }, status: { type: "cds.String" }, tenantID: { type: "cds.String" } } },
    Project: { elements: { projectID: { type: "cds.String" }, status: { type: "cds.String" } } },
    Task: { elements: { taskStatus: { type: "cds.String" } } },
    Department: {},
  } };

  it("groups field-name matches by entity with exact and matched labels", () => {
    const results = searchFields(fieldAst, "status", false);

    expect(formatFieldSearchResults("status", results)).toBe('Field matching "status" found in:\n- Employee (exact match)\n- Project (exact match)\n- Task (matched: taskStatus)');
  });

  it("returns a dense empty result header without crashing", () => {
    expect(formatFieldSearchResults("missing", searchFields(fieldAst, "missing", false))).toBe('Field matching "missing" found in:');
  });

  it("validates unsafe regex patterns before constructing them", () => {
    expect(() => searchFields(fieldAst, "(a+)+", true)).toThrow("Unsafe regex pattern");
  });
});

describe("findIncomingReferences", () => {
  it("finds associations and compositions that target the requested entity", () => {
    const csn: HanaLensCsn = { definitions: {
      Project: { elements: { ID: { type: "cds.String" } } },
      EmployeeTask: { elements: { projectRef: { type: "cds.Association", target: "Project" } } },
      Department: { elements: { activeProject: { type: "cds.Composition", target: "Project" } } },
      Employee: { elements: { department: { type: "cds.Association", target: "Department" } } },
    } };

    expect(formatIncomingReferences("Project", findIncomingReferences(csn, "Project"))).toBe("Incoming References to [Project]:\n- Department (via field: activeProject)\n- EmployeeTask (via field: projectRef)");
  });

  it("handles non-existent entities without crashing", () => {
    expect(formatIncomingReferences("Missing", findIncomingReferences({ definitions: {} }, "Missing"))).toBe("Incoming References to [Missing]:");
  });

  it("uses same-package target resolution and skips ambiguous short targets", () => {
    const csn: HanaLensCsn = { definitions: {
      "demo.sales.Project": { "@hanaLens.packageName": "@demo/sales", elements: { ID: { type: "cds.String" } } },
      "demo.master.Project": { "@hanaLens.packageName": "@demo/master", elements: { ID: { type: "cds.String" } } },
      "demo.sales.Task": { "@hanaLens.packageName": "@demo/sales", elements: { projectRef: { type: "cds.Association", target: "Project" } } },
      "demo.other.Task": { "@hanaLens.packageName": "@demo/other", elements: { projectRef: { type: "cds.Association", target: "Project" } } },
    } };

    expect(formatIncomingReferences("demo.sales.Project", findIncomingReferences(csn, "demo.sales.Project"))).toBe("Incoming References to [demo.sales.Project]:\n- demo.sales.Task (via field: projectRef)");
  });
});
