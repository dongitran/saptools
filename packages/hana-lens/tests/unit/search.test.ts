// cspell:ignore businesrequest
import { performance } from "node:perf_hooks";

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
    const results = searchDefinitions(ast, "businesrequest", false);
    expect(results[0]?.name).toBe("srv.BusinessRequest");
    expect(formatSearchResults(results.slice(0, 1))).toBe("srv.BusinessRequest|@demo/sales");
  });

  it("sorts every regex match before the formatter applies its visible limit", () => {
    const results = searchDefinitions(ast, "^srv\\.", true);

    expect(results).toHaveLength(23);
    expect(results.slice(0, 4).map((result) => result.name)).toEqual([
      "srv.BusinessRequest",
      "srv.Customer",
      "srv.Generated00",
      "srv.Generated01",
    ]);
    const names = results.map((result) => result.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(formatSearchResults(results).split("\n").at(-1)).toBe("... showing 10 of 23 matches");
  });

  it("preserves JavaScript lookbehind searches without capture groups", () => {
    expect(searchDefinitions(ast, "(?<=srv\\.)BusinessRequest$", true).map((result) => result.name))
      .toEqual(["srv.BusinessRequest"]);
  });

  it("preserves JavaScript lookahead and backreference semantics", () => {
    const compatibilityAst: HanaLensCsn = { definitions: {
      "srv.NamedNamed": {},
      "srv.WordWord": {},
    } };

    expect(searchDefinitions(ast, "^srv\\.(?=Business)BusinessRequest$", true).map((result) => result.name))
      .toEqual(["srv.BusinessRequest"]);
    expect(searchDefinitions(compatibilityAst, "^srv\\.(Word)\\1$", true).map((result) => result.name))
      .toEqual(["srv.WordWord"]);
    expect(searchDefinitions(compatibilityAst, "^srv\\.(?<part>Named)\\k<part>$", true).map((result) => result.name))
      .toEqual(["srv.NamedNamed"]);
  });

  it("returns every fuzzy match and reports the formatter limit against the total", () => {
    const results = searchDefinitions(ast, "srv", false);

    expect(results).toHaveLength(23);
    expect(formatSearchResults(results).split("\n")).toHaveLength(11);
    expect(formatSearchResults(results).split("\n").at(-1)).toBe("... showing 10 of 23 matches");
    expect(formatSearchResults(results.slice(0, 10)).split("\n")).toHaveLength(10);
    expect(formatSearchResults(results.slice(0, 10)).includes("showing")).toBe(false);
  });

  it("filters fuzzy results to relevant matches while preserving substring hits", () => {
    const generated = searchDefinitions(ast, "generated", false);

    expect(generated).toHaveLength(20);
    expect(generated[0]?.name).toBe("srv.Generated00");
    expect(searchDefinitions(ast, "utterly-nonsensical-query", false)).toEqual([]);
    expect(searchDefinitions(ast, "requests", false)).toEqual([]);
    expect(searchDefinitions(ast, "request", false).map((result) => result.name)).toEqual(["srv.BusinessRequest"]);
  });

  it("formats an empty definition result without adding a total line", () => {
    expect(formatSearchResults([])).toBe("");
  });

  it("surfaces invalid regular expressions and rejects empty keywords", () => {
    expect(() => searchDefinitions(ast, "[", true)).toThrow();
    expect(() => searchDefinitions(ast, "   ", false)).toThrow("Search keyword must not be empty");
  });

  it("evaluates adversarial regex searches within a bounded time", () => {
    const adversarialName = `${"a".repeat(34)}!`;
    const adversarialAst: HanaLensCsn = { definitions: {
      [adversarialName]: { elements: { [adversarialName]: { type: "cds.String" } } },
    } };
    const startedAt = performance.now();

    expect(searchDefinitions(adversarialAst, "(a|aa)+$", true)).toEqual([]);
    expect(searchFields(adversarialAst, "(a|aa)+$", true)).toEqual([]);

    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("fails closed when a timed-out JavaScript pattern has no linear fallback", () => {
    const adversarialName = `${"a".repeat(34)}?`;
    const adversarialAst: HanaLensCsn = { definitions: { [adversarialName]: {} } };
    const startedAt = performance.now();

    expect(() => searchDefinitions(adversarialAst, "(a|aa)+(?=!)$", true))
      .toThrow("Regex evaluation exceeded the safe time limit");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("searchFields", () => {
  const fieldAst: HanaLensCsn = { definitions: {
    Employee: { elements: { ID: { type: "cds.String" }, status: { type: "cds.String" }, statusText: { type: "cds.String" }, tenantID: { type: "cds.String" } } },
    Project: { elements: { projectID: { type: "cds.String" }, status: { type: "cds.String" } } },
    Task: { elements: { taskStatus: { type: "cds.String" } } },
    Department: {},
  } };

  it("keeps every matching field per entity with exact and matched labels", () => {
    const results = searchFields(fieldAst, "status", false);

    expect(formatFieldSearchResults("status", results)).toBe('Field matching "status" found in:\n- Employee (exact: status)\n- Project (exact: status)\n- Employee (matched: statusText)\n- Task (matched: taskStatus)');
  });

  it("treats regex field hits as name-ranked matches rather than literal exact matches", () => {
    const regexAst: HanaLensCsn = { definitions: {
      Record: { elements: {
        statusZulu: { type: "cds.String" },
        status: { type: "cds.String" },
        statusAlpha: { type: "cds.String" },
      } },
    } };
    const results = searchFields(regexAst, "status", true);

    expect(results.map((result) => ({ exact: result.exact, matchedField: result.matchedField, score: result.score }))).toEqual([
      { exact: false, matchedField: "status", score: 0 },
      { exact: false, matchedField: "statusAlpha", score: 0 },
      { exact: false, matchedField: "statusZulu", score: 0 },
    ]);
    expect(formatFieldSearchResults("status", results).includes("exact")).toBe(false);
  });

  it("caps formatted field rows and reports the full match total", () => {
    const manyFields: HanaLensCsn = { definitions: {
      Record: { elements: Object.fromEntries(Array.from({ length: 30 }, (_value, index) => [
        `match${index.toString().padStart(2, "0")}`,
        { type: "cds.String" },
      ])) },
    } };
    const results = searchFields(manyFields, "^match", true);
    const output = formatFieldSearchResults("^match", results);

    expect(results).toHaveLength(30);
    expect(output.split("\n")).toHaveLength(27);
    expect(output.split("\n").at(-1)).toBe("... showing 25 of 30 matches");
    expect(formatFieldSearchResults("^match", results.slice(0, 25)).split("\n")).toHaveLength(26);
    expect(formatFieldSearchResults("^match", results.slice(0, 25)).includes("showing")).toBe(false);
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
      EmployeeTask: { elements: {
        zProjectRef: { type: "cds.Association", target: "Project" },
        aProjectRef: { type: "cds.Association", target: "Project" },
      } },
      Department: { elements: { activeProject: { type: "cds.Composition", target: "Project" } } },
      Employee: { elements: { department: { type: "cds.Association", target: "Department" } } },
    } };

    expect(formatIncomingReferences("Project", findIncomingReferences(csn, "Project"))).toBe("Incoming References to [Project]:\n- Department (via field: activeProject)\n- EmployeeTask (via field: aProjectRef)\n- EmployeeTask (via field: zProjectRef)");
  });

  it("finds projection and query sources once per referencing definition", () => {
    const csn: HanaLensCsn = { definitions: {
      "acme.Project": { elements: { ID: { type: "cds.UUID", key: true } } },
      "acme.ProjectProjection": { projection: { from: { ref: ["acme.Project"] } } },
      "acme.ProjectQuery": { query: { SELECT: { from: { ref: ["acme.Project"] } } } },
      "acme.ProjectUnion": {
        query: {
          SET: {
            args: [
              { SELECT: { from: { ref: ["acme.Project"] } } },
              { join: "inner", args: [{ ref: ["acme.Project"] }, { ref: ["acme.Other"] }] },
            ],
          },
        },
      },
      "acme.UnrelatedProjection": { projection: { from: { ref: ["acme.Other"] }, columns: [{ ref: ["acme.Project"] }] } },
      "acme.Other": { elements: { ID: { type: "cds.UUID", key: true } } },
    } };

    expect(formatIncomingReferences("acme.Project", findIncomingReferences(csn, "acme.Project"))).toBe("Incoming References to [acme.Project]:\n- acme.ProjectProjection (via field: (projection))\n- acme.ProjectQuery (via field: (projection))\n- acme.ProjectUnion (via field: (projection))");
  });

  it("throws for non-existent entities", () => {
    expect(() => findIncomingReferences({ definitions: {} }, "Missing")).toThrow("Entity not found: Missing");
  });

  it("keeps the compact header when an existing entity has no incoming references", () => {
    const csn: HanaLensCsn = { definitions: { Project: { elements: {} } } };

    expect(formatIncomingReferences("Project", findIncomingReferences(csn, "Project"))).toBe("Incoming References to [Project]:");
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

  it("caps formatted references and reports the full total", () => {
    const references = Array.from({ length: 30 }, (_value, index) => ({
      entityName: `acme.Source${index.toString().padStart(2, "0")}`,
      fieldName: "project",
    }));
    const output = formatIncomingReferences("acme.Project", references);

    expect(output.split("\n")).toHaveLength(27);
    expect(output.split("\n").at(-1)).toBe("... showing 25 of 30 references");
    expect(formatIncomingReferences("acme.Project", references.slice(0, 25)).includes("showing")).toBe(false);
  });
});
