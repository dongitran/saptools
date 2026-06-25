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

  it("ignores WHERE-like text in comments and quoted identifiers", () => {
    expect(inspectStatement("DELETE FROM T -- where ID = 1").destructive).toBe(true);
    expect(inspectStatement('UPDATE T SET X = 1 WHERE "where" = ?').destructive).toBe(false);
    expect(inspectStatement('DELETE FROM T WHERE "not where" = ?').destructive).toBe(false);
    expect(inspectStatement('DELETE FROM T "where"').destructive).toBe(true);
  });

  it("treats SELECT as non-destructive", () => {
    expect(inspectStatement("SELECT * FROM T").destructive).toBe(false);
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
