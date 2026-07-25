import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { applyAutoLimit, evaluateGuard, inspectStatement } from "../../src/safety.js";

describe("inspectStatement", () => {
  it("flags DROP/TRUNCATE/ALTER as destructive DDL", () => {
    expect(inspectStatement("DROP TABLE T").destructive).toBe(true);
    expect(inspectStatement("TRUNCATE TABLE T").destructive).toBe(true);
    expect(inspectStatement("ALTER TABLE T ADD C INT").destructive).toBe(true);
  });

  it("treats CREATE as non-destructive DDL", () => {
    const result = inspectStatement("CREATE TABLE T (ID INT)");
    expect(result.kind).toBe("ddl");
    expect(result.destructive).toBe(false);
  });

  it("flags unscoped UPDATE/DELETE as destructive", () => {
    expect(inspectStatement("UPDATE T SET X = 1").destructive).toBe(true);
    expect(inspectStatement("DELETE FROM T").destructive).toBe(true);
  });

  it("treats UPDATE/DELETE with a WHERE clause as non-destructive", () => {
    expect(inspectStatement("UPDATE T SET X = 1 WHERE ID = 2").destructive).toBe(false);
    expect(inspectStatement("DELETE FROM T WHERE ID = 2").destructive).toBe(false);
  });

  it("does not mistake a nested subquery WHERE for an outer UPDATE scope", () => {
    expect(
      inspectStatement(
        "UPDATE T SET TOTAL = (SELECT COUNT(*) FROM ITEMS WHERE ITEMS.T_ID = T.ID)",
      ).destructive,
    ).toBe(true);
  });

  it("guards unconditional matched MERGE deletes but not conditional matches", () => {
    expect(
      inspectStatement(
        "MERGE INTO T USING S ON T.ID = S.ID WHEN MATCHED THEN DELETE",
      ).destructive,
    ).toBe(true);
    expect(
      inspectStatement(
        "MERGE INTO T USING S ON T.ID = S.ID WHEN MATCHED AND T.STATE = 'OLD' THEN DELETE",
      ).destructive,
    ).toBe(false);
    expect(
      inspectStatement(
        "MERGE INTO T USING S ON T.ID = S.ID WHEN MATCHED THEN UPDATE SET T.X = S.X",
      ).destructive,
    ).toBe(false);
  });

  it("keeps supported REPLACE values consistent with UPSERT and flags malformed REPLACE", () => {
    expect(inspectStatement("REPLACE T VALUES (1)").destructive).toBe(false);
    expect(inspectStatement("REPLACE").destructive).toBe(true);
  });

  it("ignores WHERE-like text in comments and quoted identifiers", () => {
    expect(inspectStatement("DELETE FROM T -- where ID = 1").destructive).toBe(true);
    expect(inspectStatement('UPDATE T SET X = 1 WHERE "where" = ?').destructive).toBe(false);
    expect(inspectStatement('DELETE FROM T WHERE "not where" = ?').destructive).toBe(false);
    expect(inspectStatement('DELETE FROM T "where"').destructive).toBe(true);
  });

  it("treats SELECT as non-destructive", () => {
    expect(inspectStatement("SELECT * FROM T").destructive).toBe(false);
  });

  it("treats a WITH-led SELECT as non-destructive", () => {
    const result = inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) SELECT * FROM x");
    expect(result.kind).toBe("select");
    expect(result.destructive).toBe(false);
  });

  it("flags an unscoped WITH-led DELETE/UPDATE as destructive", () => {
    expect(inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T").destructive).toBe(
      true,
    );
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) UPDATE T SET X = 1").destructive,
    ).toBe(true);
  });

  it("treats a scoped WITH-led DELETE/UPDATE as non-destructive", () => {
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1").destructive,
    ).toBe(false);
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) UPDATE T SET X = 1 WHERE ID = 1")
        .destructive,
    ).toBe(false);
  });

  it("never flags a WITH-led INSERT as destructive", () => {
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) INSERT INTO T VALUES (1)").destructive,
    ).toBe(false);
  });

  it("resolves the real keyword past multiple CTE definitions", () => {
    expect(
      inspectStatement(
        "WITH a AS (SELECT 1 FROM DUMMY), b AS (SELECT 2 FROM DUMMY) DELETE FROM T",
      ).destructive,
    ).toBe(true);
  });

  it("does not mistake a DML keyword inside a CTE's string/comment for the real trailing keyword", () => {
    const result = inspectStatement(
      "WITH x AS (SELECT 'DELETE' AS NOTE FROM DUMMY) SELECT * FROM x",
    );
    expect(result.kind).toBe("select");
    expect(result.destructive).toBe(false);
  });

  it("does not let a WITH-led statement's own leading WITH satisfy the malformed-REPLACE value-source check", () => {
    // A genuine value source after the real REPLACE keyword is not malformed...
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) REPLACE T VALUES (1)").destructive,
    ).toBe(false);
    // ...but a REPLACE with no real value source at all is still malformed,
    // even though the full statement's own leading keyword is "WITH" (which
    // would trivially satisfy an unscoped `hasTopLevelKeyword(sql, "WITH")`
    // check if the malformed-REPLACE check were not scoped to the tail).
    expect(inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) REPLACE T").destructive).toBe(true);
  });

  it("flags CALL as destructive regardless of nested parens/function calls in its arguments", () => {
    expect(inspectStatement("CALL SOME_PROC()").destructive).toBe(true);
    expect(inspectStatement("CALL SOME_PROC(UPPER('x'), 1 + 2)").destructive).toBe(true);
  });

  it("does not broaden destructive to unrecognized statement kinds other than CALL", () => {
    expect(inspectStatement("EXPLAIN PLAN FOR SELECT 1 FROM DUMMY").destructive).toBe(false);
  });

  it("flags a WITH-led CALL as destructive too, not just a bare CALL", () => {
    const result = inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) CALL SOME_PROC()");
    expect(result.kind).toBe("unknown");
    expect(result.destructive).toBe(true);
  });

  it("flags a WITH-led DDL statement as destructive/non-destructive exactly like its non-WITH equivalent", () => {
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) DROP TABLE T").destructive,
    ).toBe(true);
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) TRUNCATE TABLE T").destructive,
    ).toBe(true);
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) ALTER TABLE T ADD C INT").destructive,
    ).toBe(true);
    expect(
      inspectStatement("WITH x AS (SELECT 1 FROM DUMMY) CREATE TABLE T (ID INT)").destructive,
    ).toBe(false);
  });

  it("treats an unparseable WITH-led statement as unknown and not destructive", () => {
    const result = inspectStatement("WITH not even close to a real CTE list");
    expect(result.kind).toBe("unknown");
    expect(result.destructive).toBe(false);
  });
});

describe("evaluateGuard", () => {
  it("allows SELECT in read-only mode", () => {
    const decision = evaluateGuard("SELECT 1 FROM DUMMY", {
      readOnly: true,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks DML in read-only mode with a read-only violation", () => {
    const decision = evaluateGuard("INSERT INTO T VALUES (1)", {
      readOnly: true,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("read-only");
  });

  it("blocks unknown statements in read-only mode", () => {
    const decision = evaluateGuard("EXPLAIN PLAN FOR SELECT 1 FROM DUMMY", {
      readOnly: true,
      allowDestructive: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("read-only");
  });

  it("blocks destructive statements with a destructive violation", () => {
    const decision = evaluateGuard("DROP TABLE T", {
      readOnly: false,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("destructive");
  });

  it("permits destructive statements when explicitly allowed", () => {
    const decision = evaluateGuard("DROP TABLE T", {
      readOnly: false,
      allowDestructive: true,
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks CALL in read-only mode with a read-only violation", () => {
    const decision = evaluateGuard("CALL SOME_PROC()", {
      readOnly: true,
      allowDestructive: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("read-only");
  });

  it("blocks CALL as destructive when not read-only and not explicitly allowed", () => {
    const decision = evaluateGuard("CALL SOME_PROC()", {
      readOnly: false,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("destructive");
  });

  it("permits CALL once explicitly allowed", () => {
    const decision = evaluateGuard("CALL SOME_PROC()", {
      readOnly: false,
      allowDestructive: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.destructive).toBe(true);
  });

  it("blocks an unscoped WITH-led DELETE under the destructive guard", () => {
    const decision = evaluateGuard("WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T", {
      readOnly: false,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("destructive");
  });

  it("blocks a WITH-led DELETE under the read-only guard", () => {
    const decision = evaluateGuard(
      "WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1",
      { readOnly: true, allowDestructive: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("read-only");
  });

  it("blocks a WITH-led CALL under both the read-only and destructive guards", () => {
    const withCall = "WITH x AS (SELECT 1 FROM DUMMY) CALL SOME_PROC()";
    expect(
      evaluateGuard(withCall, { readOnly: true, allowDestructive: true }).violation,
    ).toBe("read-only");
    expect(
      evaluateGuard(withCall, { readOnly: false, allowDestructive: false }).violation,
    ).toBe("destructive");
    expect(
      evaluateGuard(withCall, { readOnly: false, allowDestructive: true }).allowed,
    ).toBe(true);
  });

  it("blocks a WITH-led DROP under both the read-only and destructive guards", () => {
    const withDrop = "WITH x AS (SELECT 1 FROM DUMMY) DROP TABLE T";
    expect(
      evaluateGuard(withDrop, { readOnly: true, allowDestructive: true }).violation,
    ).toBe("read-only");
    expect(
      evaluateGuard(withDrop, { readOnly: false, allowDestructive: false }).violation,
    ).toBe("destructive");
    expect(
      evaluateGuard(withDrop, { readOnly: false, allowDestructive: true }).allowed,
    ).toBe(true);
  });
});

describe("applyAutoLimit", () => {
  it("appends LIMIT to a bare SELECT", () => {
    expect(applyAutoLimit("SELECT * FROM T", 100)).toEqual({
      sql: "SELECT * FROM T LIMIT 101",
      applied: true,
      requestedLimit: 100,
    });
  });

  it("strips a trailing semicolon before appending LIMIT", () => {
    expect(applyAutoLimit("SELECT * FROM T;", 10).sql).toBe("SELECT * FROM T LIMIT 11");
  });

  it("handles adversarial trailing SQL text within a bounded time", () => {
    const sql = `SELECT 1${"\t".repeat(50_000)}x`;
    const startedAt = performance.now();

    expect(applyAutoLimit(sql, 10).sql).toBe(`${sql} LIMIT 11`);
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it("removes mixed whitespace and semicolons before a limit or trailing comment", () => {
    expect(applyAutoLimit("SELECT 1; \t;\n", 10).sql).toBe("SELECT 1 LIMIT 11");
    expect(applyAutoLimit("SELECT 1; \t; -- note", 10).sql).toBe("SELECT 1 LIMIT 11 -- note");
  });

  it("does not touch a SELECT that already has a LIMIT", () => {
    expect(applyAutoLimit("SELECT * FROM T LIMIT 5", 100).applied).toBe(false);
  });

  it("ignores LIMIT-like text in comments and quoted identifiers", () => {
    expect(applyAutoLimit('SELECT "limit" FROM T -- limit 5', 100)).toEqual({
      sql: 'SELECT "limit" FROM T LIMIT 101 -- limit 5',
      applied: true,
      requestedLimit: 100,
    });
  });

  it("inserts LIMIT before a trailing line comment and removes a preceding semicolon", () => {
    expect(applyAutoLimit("SELECT * FROM T; -- note", 100)).toEqual({
      sql: "SELECT * FROM T LIMIT 101 -- note",
      applied: true,
      requestedLimit: 100,
    });
  });

  it("does not limit non-SELECT statements", () => {
    expect(applyAutoLimit("INSERT INTO T VALUES (1)", 100).applied).toBe(false);
  });

  it("is disabled when the limit is false", () => {
    expect(applyAutoLimit("SELECT * FROM T", false).applied).toBe(false);
  });
});
