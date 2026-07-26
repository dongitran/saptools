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

  it("does not broaden a resolved (not just unparseable) WITH-led statement to destructive when its real trailing keyword is an unrecognized, non-CALL kind", () => {
    // resolveWithStatement succeeds here (the CTE-list parses fine; the real
    // trailing keyword is EXPLAIN) - this must match its bare equivalent
    // exactly like the WITH-led DDL/CALL cases above do, not be swept into
    // the "genuinely unparseable" fallback just because the statement
    // happens to start with WITH.
    const result = inspectStatement(
      "WITH x AS (SELECT 1 FROM DUMMY) EXPLAIN PLAN FOR SELECT 1 FROM DUMMY",
    );
    expect(result.kind).toBe("unknown");
    expect(result.destructive).toBe(false);
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

  it("treats a genuinely unparseable WITH-led statement as destructive via the fallback, not just CALL", () => {
    // Failing closed here (rather than the prior "unknown -> not destructive"
    // default) is deliberate: an unparseable CTE-list means the real trailing
    // statement's shape could not be determined at all, so it must require
    // explicit authorization instead of silently being treated as safe.
    const result = inspectStatement("WITH not even close to a real CTE list");
    expect(result.kind).toBe("unknown");
    expect(result.destructive).toBe(true);
  });

  it("flags a quoted-CTE-name unscoped write as destructive, matching its unquoted equivalent", () => {
    const result = inspectStatement('WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T');
    expect(result.kind).toBe("dml");
    expect(result.destructive).toBe(true);
  });

  it("treats a WHERE-scoped quoted-CTE-name write as non-destructive, matching its unquoted equivalent", () => {
    const result = inspectStatement(
      'WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1',
    );
    expect(result.kind).toBe("dml");
    expect(result.destructive).toBe(false);
  });

  describe("multi-statement detection", () => {
    it("flags a genuine second statement as destructive and multiStatement", () => {
      const result = inspectStatement("SELECT 1 FROM DUMMY; DELETE FROM real_table");
      expect(result.multiStatement).toBe(true);
      expect(result.destructive).toBe(true);
    });

    it("does not flag a single statement with a lone trailing semicolon", () => {
      const result = inspectStatement("SELECT * FROM t;");
      expect(result.multiStatement).toBe(false);
    });

    it("does not flag a routine-body definition despite its internal semicolons", () => {
      const result = inspectStatement(
        "CREATE PROCEDURE my_proc AS BEGIN DECLARE x INT; END;",
      );
      expect(result.multiStatement).toBe(false);
      expect(result.kind).toBe("ddl");
      expect(result.destructive).toBe(false);
    });

    it("composes with WITH resolution: a legitimate WITH followed by a smuggled DELETE is caught", () => {
      const result = inspectStatement(
        "WITH x AS (SELECT 1 FROM DUMMY) SELECT * FROM x; DELETE FROM t",
      );
      expect(result.multiStatement).toBe(true);
      expect(result.destructive).toBe(true);
    });

    it("composes with a multi-line, human-formatted WITH and a smuggled DELETE after a blank line", () => {
      const sql =
        "WITH x AS (\n" +
        "    SELECT 1 AS n\n" +
        "    FROM DUMMY\n" +
        ")\n" +
        "SELECT n FROM x;\n" +
        "\n" +
        "DELETE FROM t";
      const result = inspectStatement(sql);
      expect(result.multiStatement).toBe(true);
      expect(result.destructive).toBe(true);
    });

    it("composes with a quoted-CTE-name WITH followed by a smuggled DELETE", () => {
      const result = inspectStatement(
        'WITH "x" AS (SELECT 1 FROM DUMMY) SELECT * FROM "x"; DELETE FROM t',
      );
      expect(result.multiStatement).toBe(true);
      expect(result.destructive).toBe(true);
    });
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

  it("blocks the quoted-CTE-name unscoped write under the destructive guard", () => {
    const decision = evaluateGuard('WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T', {
      readOnly: false,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("destructive");
  });

  it("blocks the quoted-CTE-name write under the read-only guard", () => {
    const decision = evaluateGuard(
      'WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1',
      { readOnly: true, allowDestructive: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("read-only");
  });

  it("allows a WHERE-scoped quoted-CTE-name write without requiring --allow-destructive", () => {
    const decision = evaluateGuard(
      'WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1',
      { readOnly: false, allowDestructive: false },
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks a genuinely unparseable WITH-led statement under the destructive guard", () => {
    const decision = evaluateGuard("WITH not even close to a real CTE list", {
      readOnly: false,
      allowDestructive: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violation).toBe("destructive");
  });

  it("permits a genuinely unparseable WITH-led statement once --allow-destructive is set", () => {
    const decision = evaluateGuard("WITH not even close to a real CTE list", {
      readOnly: false,
      allowDestructive: true,
    });
    expect(decision.allowed).toBe(true);
  });

  describe("multi-statement blocking", () => {
    it("blocks the severity-defining case with zero flags: a scoped write hiding an unscoped DROP", () => {
      const decision = evaluateGuard("DELETE FROM t WHERE id=1; DROP TABLE other", {
        readOnly: false,
        allowDestructive: false,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("blocks the UPDATE equivalent of the severity-defining case", () => {
      const decision = evaluateGuard("UPDATE t SET x=1 WHERE id=1; DROP TABLE other", {
        readOnly: false,
        allowDestructive: false,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("is not overridable by --allow-destructive", () => {
      const decision = evaluateGuard("DELETE FROM t WHERE id=1; DROP TABLE other", {
        readOnly: false,
        allowDestructive: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("still blocks under --read-only (with a multi-statement violation, not a read-only one)", () => {
      const decision = evaluateGuard("SELECT 1 FROM DUMMY; DELETE FROM real_table", {
        readOnly: true,
        allowDestructive: false,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("blocks even when every individual statement is independently harmless", () => {
      // Intentional, not an oversight: HANA itself already rejects this exact
      // input with a syntax error, so blocking it client-side with a clearer
      // message is a usability improvement, not a new restriction on
      // something that used to meaningfully work.
      const decision = evaluateGuard("SELECT 1 FROM DUMMY; SELECT 2 FROM DUMMY", {
        readOnly: false,
        allowDestructive: false,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("a dangerous-first statement is still blocked, and blocked as multi-statement too", () => {
      const decision = evaluateGuard("DROP TABLE other; SELECT 1 FROM DUMMY", {
        readOnly: false,
        allowDestructive: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("catches every destructive shape the guard already recognizes when smuggled second", () => {
      const fixtures = [
        "SELECT 1 FROM t WHERE id=1; TRUNCATE TABLE other",
        "UPDATE t SET x=1 WHERE id=1; ALTER TABLE other DROP COLUMN y",
        "SELECT 1 FROM t; MERGE INTO other USING src ON 1=1 WHEN MATCHED THEN DELETE",
        "SELECT 1 FROM t WHERE id=1; INSERT INTO other VALUES (1, 2, 3)",
        "SELECT 1 FROM t WHERE id=1; CALL some_proc()",
        "DELETE FROM a WHERE id=1; DELETE FROM b WHERE id=1; DROP TABLE c",
      ];
      for (const sql of fixtures) {
        const decision = evaluateGuard(sql, { readOnly: false, allowDestructive: true });
        expect(decision.allowed).toBe(false);
        expect(decision.violation).toBe("multi-statement");
      }
    });

    it("allows a routine-body definition through despite its internal semicolons", () => {
      const decision = evaluateGuard(
        "CREATE PROCEDURE my_proc AS BEGIN DECLARE x INT; END;",
        { readOnly: false, allowDestructive: false },
      );
      expect(decision.allowed).toBe(true);
    });

    it("blocks content appended after a routine body's own END (closed: was a disclosed limitation)", () => {
      const decision = evaluateGuard(
        "CREATE PROCEDURE p AS BEGIN DECLARE x INT; END; DROP TABLE other",
        { readOnly: false, allowDestructive: false },
      );
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("blocks a statement skipped over on the way to a later BEGIN...END, with zero flags (independent-review finding)", () => {
      const decision = evaluateGuard(
        "CREATE PROCEDURE p(x INT); DROP TABLE other; SELECT 1 BEGIN END",
        { readOnly: false, allowDestructive: false },
      );
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    it("the reason message is distinct from the WITH-refused/backup message and names the real cause", () => {
      const decision = evaluateGuard("DELETE FROM t WHERE id=1; DROP TABLE other", {
        readOnly: false,
        allowDestructive: false,
      });
      expect(decision.reason).not.toMatch(/backup/i);
      expect(decision.reason).not.toMatch(/WITH write refused/);
      expect(decision.reason).toMatch(/one SQL statement per call/);
    });

    it("case-insensitivity: the detection has no case-sensitivity assumptions", () => {
      const decision = evaluateGuard("SeLeCt 1 FROM dummy; DeLeTe FROM t", {
        readOnly: false,
        allowDestructive: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.violation).toBe("multi-statement");
    });

    describe("review-driven fixes", () => {
      it("blocks a routine-keyword statement with no real body, unconditionally (independent-review finding)", () => {
        const decision = evaluateGuard("CREATE PROCEDURE p; DROP TABLE other", {
          readOnly: false,
          allowDestructive: true,
        });
        expect(decision.allowed).toBe(false);
        expect(decision.violation).toBe("multi-statement");
      });

      it("allows a HANA anonymous DO block through despite its internal semicolons", () => {
        const decision = evaluateGuard(
          "DO BEGIN DECLARE x INT; SELECT 1 INTO x FROM DUMMY; END;",
          { readOnly: false, allowDestructive: false },
        );
        expect(decision.allowed).toBe(true);
      });

      it("does not block a single statement with a stray trailing zero-width space", () => {
        const decision = evaluateGuard("SELECT 1 FROM t;​", {
          readOnly: false,
          allowDestructive: false,
        });
        expect(decision.allowed).toBe(true);
      });

      it("blocks an unclosed top-level paren hiding a real separator, unconditionally", () => {
        const decision = evaluateGuard(
          "DELETE FROM t WHERE id IN (1, 2; DROP TABLE other",
          { readOnly: false, allowDestructive: true },
        );
        expect(decision.allowed).toBe(false);
        expect(decision.violation).toBe("multi-statement");
      });
    });
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
