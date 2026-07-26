import { describe, expect, it } from "vitest";

import { isAnonymousBlock, isRoutineDefinition } from "../../src/routine-carve-out.js";
import {
  assertParamArity,
  classifyStatement,
  countPlaceholders,
  firstKeyword,
  hasMultipleStatements,
  qualifiedName,
  quoteIdentifier,
  resolveWithStatement,
  splitTopLevelStatements,
} from "../../src/statements.js";

describe("classifyStatement", () => {
  it("classifies SELECT and a WITH-led read as select", () => {
    expect(classifyStatement("SELECT * FROM T")).toBe("select");
    expect(classifyStatement("with cte as (select 1) select * from cte")).toBe("select");
  });

  it("classifies INSERT/UPDATE/DELETE as dml", () => {
    expect(classifyStatement("INSERT INTO T VALUES (1)")).toBe("dml");
    expect(classifyStatement("update t set x = 1")).toBe("dml");
    expect(classifyStatement("DELETE FROM t")).toBe("dml");
  });

  it("classifies CREATE/DROP/ALTER as ddl", () => {
    expect(classifyStatement("CREATE TABLE T (ID INT)")).toBe("ddl");
    expect(classifyStatement("drop table t")).toBe("ddl");
  });

  it("skips leading comments and whitespace", () => {
    expect(classifyStatement("-- a comment\n  SELECT 1 FROM DUMMY")).toBe("select");
    expect(classifyStatement("/* block */ INSERT INTO T VALUES (1)")).toBe("dml");
  });

  it("returns unknown for unrecognized statements", () => {
    expect(classifyStatement("EXPLAIN PLAN FOR SELECT 1")).toBe("unknown");
    expect(classifyStatement("")).toBe("unknown");
  });

  it("classifies a WITH-led write as dml rather than select", () => {
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1")).toBe(
      "dml",
    );
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) UPDATE T SET X = 1")).toBe("dml");
    expect(
      classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) INSERT INTO T VALUES (1)"),
    ).toBe("dml");
    expect(
      classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) MERGE INTO T USING S ON T.ID = S.ID " +
        "WHEN MATCHED THEN DELETE"),
    ).toBe("dml");
  });

  it("resolves the real DML keyword past multiple CTE definitions", () => {
    expect(
      classifyStatement(
        "WITH a AS (SELECT 1 FROM DUMMY), b AS (SELECT 2 FROM DUMMY) DELETE FROM T",
      ),
    ).toBe("dml");
  });

  it("does not mistake a DML keyword inside a CTE's string literal or comment for the real trailing keyword", () => {
    expect(
      classifyStatement("WITH x AS (SELECT 'DELETE' AS NOTE FROM DUMMY) SELECT * FROM x"),
    ).toBe("select");
    expect(
      classifyStatement("WITH x AS (SELECT 1 FROM DUMMY /* DELETE later */) SELECT * FROM x"),
    ).toBe("select");
  });

  it("classifies a WITH-led CALL as unknown, not select", () => {
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) CALL SOME_PROC()")).toBe("unknown");
  });

  it("classifies a WITH-led DDL statement as ddl, not select", () => {
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) DROP TABLE T")).toBe("ddl");
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) TRUNCATE TABLE T")).toBe("ddl");
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) ALTER TABLE T ADD C INT")).toBe(
      "ddl",
    );
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) RENAME TABLE T TO T2")).toBe("ddl");
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) COMMENT ON TABLE T IS 'x'")).toBe(
      "ddl",
    );
    expect(classifyStatement("WITH x AS (SELECT 1 FROM DUMMY) CREATE TABLE T (ID INT)")).toBe(
      "ddl",
    );
  });

  it("classifies a WITH-led statement with an explicit CTE column list as select", () => {
    expect(
      classifyStatement("WITH x (a, b) AS (SELECT 1, 2 FROM DUMMY) SELECT * FROM x"),
    ).toBe("select");
  });

  it("classifies an unparseable WITH-led statement as unknown rather than select", () => {
    expect(classifyStatement("WITH not even close to a real CTE list")).toBe("unknown");
    expect(classifyStatement("WITH x SELECT * FROM x")).toBe("unknown");
  });

  it("resolves a WITH-led read whose CTE name is a quoted identifier", () => {
    expect(
      classifyStatement('WITH "x" AS (SELECT 1 AS N FROM DUMMY) SELECT N FROM "x"'),
    ).toBe("select");
  });

  it("classifies a WITH-led write as dml (not unknown) when its CTE name is quoted", () => {
    expect(
      classifyStatement('WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1'),
    ).toBe("dml");
  });
});

describe("resolveWithStatement", () => {
  it("resolves a WITH-led read to its real SELECT keyword and position", () => {
    expect(resolveWithStatement("WITH x AS (SELECT 1 FROM DUMMY) SELECT * FROM x")).toEqual({
      keyword: "SELECT",
      index: expect.any(Number),
    });
  });

  it("returns undefined for a statement with no leading WITH", () => {
    expect(resolveWithStatement("SELECT * FROM T")).toBeUndefined();
  });

  it("finds the real keyword and its position past the CTE definitions", () => {
    const sql = "WITH x AS (SELECT 1 FROM DUMMY) DELETE FROM T WHERE ID = 1";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T WHERE ID = 1");
  });

  it("finds CALL past the CTE definitions", () => {
    const sql = "WITH x AS (SELECT 1 FROM DUMMY) CALL SOME_PROC()";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("CALL");
    expect(sql.slice(result?.index ?? -1)).toBe("CALL SOME_PROC()");
  });

  it("resolves past multiple CTE definitions", () => {
    const sql = "WITH a AS (SELECT 1 FROM DUMMY), b AS (SELECT 2 FROM DUMMY) DELETE FROM T";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a CTE with an explicit column list", () => {
    const sql = "WITH x (a, b) AS (SELECT 1, 2 FROM DUMMY) DELETE FROM T";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("returns undefined for a malformed CTE list", () => {
    expect(resolveWithStatement("WITH not even close to a real CTE list")).toBeUndefined();
    expect(resolveWithStatement("WITH x SELECT * FROM x")).toBeUndefined();
    expect(resolveWithStatement("WITH x AS SELECT * FROM x")).toBeUndefined();
  });

  it("returns undefined for an unterminated CTE body paren", () => {
    expect(
      resolveWithStatement("WITH x AS (SELECT 1 FROM DUMMY DELETE FROM T"),
    ).toBeUndefined();
  });

  it("returns undefined for an unterminated explicit column list paren", () => {
    expect(
      resolveWithStatement("WITH x (a, b AS (SELECT 1 FROM DUMMY) DELETE FROM T"),
    ).toBeUndefined();
  });

  it("resolves past a quoted CTE name in the first (and only) position", () => {
    const sql = 'WITH "x" AS (SELECT 1 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name in a non-first position", () => {
    const sql = 'WITH a AS (SELECT 1 FROM DUMMY), "b" AS (SELECT 2 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name that is the last of three or more CTEs", () => {
    const sql =
      'WITH a AS (SELECT 1 FROM DUMMY), b AS (SELECT 2 FROM DUMMY), ' +
      '"c" AS (SELECT 3 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name with an explicit column list", () => {
    const sql = 'WITH "x" (a, b) AS (SELECT 1, 2 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name containing an escaped quote", () => {
    const sql = 'WITH "a""b" AS (SELECT 1 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name preceded by unusual whitespace and a block comment", () => {
    const sql = 'WITH\n/* note */\t"x" AS (SELECT 1 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("resolves past a quoted CTE name preceded by a line comment", () => {
    const sql = 'WITH -- note\n"x" AS (SELECT 1 FROM DUMMY) DELETE FROM T';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("DELETE");
    expect(sql.slice(result?.index ?? -1)).toBe("DELETE FROM T");
  });

  it("does not mistake a string literal elsewhere in the query for the quoted CTE name", () => {
    const sql = "WITH \"x\" AS (SELECT 'DELETE' AS NOTE FROM DUMMY) SELECT NOTE FROM \"x\"";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("SELECT");
  });

  it("does not mistake a DML keyword hidden in a comment inside a quoted-name CTE body for the real trailing keyword", () => {
    const sql = 'WITH "x" AS (SELECT 1 FROM DUMMY /* DELETE later */) SELECT * FROM "x"';
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("SELECT");
  });

  it("resolves a CALL with nested-paren arguments past a quoted CTE name", () => {
    const sql = "WITH \"x\" AS (SELECT 1 FROM DUMMY) CALL PROC(FUNC(1, 2), 'a)b')";
    const result = resolveWithStatement(sql);
    expect(result?.keyword).toBe("CALL");
    expect(sql.slice(result?.index ?? -1)).toBe("CALL PROC(FUNC(1, 2), 'a)b')");
  });
});

describe("firstKeyword", () => {
  it("returns the upper-cased leading keyword", () => {
    expect(firstKeyword("  select 1")).toBe("SELECT");
  });

  it("handles long sequences of leading whitespace and comments", () => {
    const leadingTrivia = " \t/* block */\n-- line comment\r\n".repeat(2_000);
    expect(firstKeyword(`${leadingTrivia}merge into TARGET`)).toBe("MERGE");
  });

  it("treats a trailing line comment as having no keyword", () => {
    expect(firstKeyword(" \t-- comment without a newline")).toBe("");
  });

  it("does not read keywords from an unterminated block comment", () => {
    expect(firstKeyword(" \n/* unfinished SELECT FROM TARGET")).toBe("");
  });
});

describe("quoteIdentifier", () => {
  it("double-quotes identifiers and escapes embedded quotes", () => {
    expect(quoteIdentifier("ORDERS")).toBe('"ORDERS"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("rejects empty identifiers", () => {
    expect(() => quoteIdentifier("")).toThrow(/must not be empty/);
  });

  it("rejects identifiers containing a NUL character", () => {
    expect(() => quoteIdentifier("a\0b")).toThrow(/NUL/);
  });
});

describe("qualifiedName", () => {
  it("builds a quoted schema.table name", () => {
    expect(qualifiedName("APP", "ORDERS")).toBe('"APP"."ORDERS"');
  });
});

describe("countPlaceholders", () => {
  it("counts bare placeholders", () => {
    expect(countPlaceholders("SELECT * FROM T WHERE A = ? AND B = ?")).toBe(2);
  });

  it("ignores placeholders inside string literals", () => {
    expect(countPlaceholders("SELECT '?' FROM T WHERE A = ?")).toBe(1);
  });

  it("ignores placeholders inside quoted identifiers", () => {
    expect(countPlaceholders('SELECT "c?" FROM T WHERE A = ?')).toBe(1);
  });

  it("ignores placeholders inside line and block comments", () => {
    expect(countPlaceholders("SELECT 1 -- ? ignored\nWHERE A = ?")).toBe(1);
    expect(countPlaceholders("SELECT /* ? ignored */ 1 WHERE A = ?")).toBe(1);
  });

  it("handles doubled quotes inside string literals", () => {
    expect(countPlaceholders("SELECT 'it''s ?' FROM T WHERE A = ?")).toBe(1);
  });
});

describe("assertParamArity", () => {
  it("accepts a matching parameter count", () => {
    expect(() => {
      assertParamArity("A = ? AND B = ?", ["x", "y"]);
    }).not.toThrow();
  });

  it("throws on a parameter-count mismatch", () => {
    expect(() => {
      assertParamArity("A = ?", ["x", "y"]);
    }).toThrow(/expects 1/);
  });
});

describe("splitTopLevelStatements", () => {
  it("returns the whole string as one segment when there is no top-level semicolon", () => {
    expect(splitTopLevelStatements("SELECT * FROM T")).toEqual(["SELECT * FROM T"]);
  });

  it("splits on a genuine top-level semicolon", () => {
    expect(splitTopLevelStatements("SELECT 1; DELETE FROM T")).toEqual([
      "SELECT 1",
      " DELETE FROM T",
    ]);
  });

  it("does not split on a semicolon nested inside parens", () => {
    expect(splitTopLevelStatements("SELECT (SELECT 1 FROM DUMMY) FROM T")).toEqual([
      "SELECT (SELECT 1 FROM DUMMY) FROM T",
    ]);
  });

  it("does not split on a semicolon inside a string literal or comment", () => {
    expect(splitTopLevelStatements("SELECT ';' FROM T")).toEqual(["SELECT ';' FROM T"]);
    expect(splitTopLevelStatements("SELECT 1 /* ; */ FROM T")).toEqual([
      "SELECT 1 /* ; */ FROM T",
    ]);
  });

  it("returns unmodified original-text slices, not masked text", () => {
    expect(splitTopLevelStatements("SELECT ';' FROM T; DELETE FROM other")).toEqual([
      "SELECT ';' FROM T",
      " DELETE FROM other",
    ]);
  });
});

describe("isRoutineDefinition", () => {
  it("recognizes CREATE PROCEDURE/FUNCTION/TRIGGER", () => {
    expect(isRoutineDefinition("CREATE PROCEDURE my_proc AS BEGIN END")).toBe(true);
    expect(isRoutineDefinition("CREATE FUNCTION my_func() RETURNS INT AS BEGIN END")).toBe(true);
    expect(isRoutineDefinition("CREATE TRIGGER my_trigger BEFORE INSERT AS BEGIN END")).toBe(
      true,
    );
  });

  it("recognizes CREATE OR REPLACE PROCEDURE/FUNCTION/TRIGGER", () => {
    expect(isRoutineDefinition("CREATE OR REPLACE PROCEDURE my_proc AS BEGIN END")).toBe(true);
  });

  it("rejects CREATE OR <something other than REPLACE>", () => {
    expect(isRoutineDefinition("CREATE OR SOMETHING PROCEDURE my_proc AS BEGIN END")).toBe(
      false,
    );
  });

  it("is case-insensitive", () => {
    expect(isRoutineDefinition("create procedure my_proc as begin end")).toBe(true);
    expect(isRoutineDefinition("Create Or Replace Procedure my_proc AS BEGIN END")).toBe(true);
  });

  it("tolerates unusual whitespace and comments between CREATE and the routine keyword", () => {
    expect(isRoutineDefinition("CREATE\n/* note */\tPROCEDURE   my_proc AS BEGIN END")).toBe(
      true,
    );
  });

  it("does not exempt CREATE TABLE/VIEW/INDEX", () => {
    expect(isRoutineDefinition("CREATE TABLE t (id INT)")).toBe(false);
    expect(isRoutineDefinition("CREATE VIEW v AS SELECT * FROM t")).toBe(false);
    expect(isRoutineDefinition("CREATE INDEX idx ON t (id)")).toBe(false);
  });

  it("returns false for non-CREATE statements", () => {
    expect(isRoutineDefinition("SELECT * FROM T")).toBe(false);
    expect(isRoutineDefinition("")).toBe(false);
  });

  describe("requires a real BEGIN/END body, not just the leading keyword pair", () => {
    // Found in independent review: without this, the leading keyword pair
    // alone was sufficient to exempt *anything* from the multi-statement
    // check, with no body required at all - a much easier bypass than the
    // already-disclosed "content after a routine body's own END" limitation.
    it("does not exempt CREATE PROCEDURE with no body at all", () => {
      expect(isRoutineDefinition("CREATE PROCEDURE p")).toBe(false);
      expect(isRoutineDefinition("CREATE PROCEDURE p; DROP TABLE other")).toBe(false);
    });

    it("does not exempt CREATE FUNCTION/TRIGGER with no body at all", () => {
      expect(isRoutineDefinition("CREATE FUNCTION f; DROP TABLE other")).toBe(false);
      expect(isRoutineDefinition("CREATE TRIGGER t; DROP TABLE other")).toBe(false);
    });

    it("does not exempt CREATE OR REPLACE PROCEDURE with no body at all", () => {
      expect(isRoutineDefinition("CREATE OR REPLACE PROCEDURE p; DROP TABLE other")).toBe(false);
    });

    it("still exempts a routine definition that does have a real body", () => {
      expect(isRoutineDefinition("CREATE PROCEDURE p AS BEGIN DECLARE x INT; END")).toBe(true);
    });
  });
});

describe("isAnonymousBlock", () => {
  // Found in independent review: HANA SQLScript anonymous blocks
  // (`DO [(...)] BEGIN ... END`) are a legitimate single statement with
  // internal semicolons, just like a CREATE PROCEDURE/FUNCTION/TRIGGER body,
  // but were not recognized by the original routine-only carve-out.
  it("recognizes a plain DO BEGIN...END block", () => {
    expect(
      isAnonymousBlock("DO BEGIN DECLARE x INT; SELECT 1 INTO x FROM DUMMY; END"),
    ).toBe(true);
  });

  it("recognizes a parameterized DO (...) BEGIN...END block", () => {
    expect(
      isAnonymousBlock("DO (IN a INT, OUT b INT) BEGIN b := a + 1; END"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAnonymousBlock("do begin declare x int; end")).toBe(true);
  });

  it("does not exempt a DO with no real body", () => {
    expect(isAnonymousBlock("DO SOMETHING; DROP TABLE other")).toBe(false);
  });

  it("returns false for non-DO statements", () => {
    expect(isAnonymousBlock("SELECT * FROM T")).toBe(false);
    expect(isAnonymousBlock("")).toBe(false);
  });
});

describe("hasMultipleStatements", () => {
  describe("category A - single legitimate statement stays single despite messy whitespace", () => {
    const singleStatementFixtures: readonly [string, string][] = [
      ["clean, no semicolon", "SELECT * FROM t"],
      ["clean, one trailing semicolon", "SELECT * FROM t;"],
      ["space before the semicolon", "SELECT * FROM t ;"],
      ["trailing spaces after the semicolon", "SELECT * FROM t;   "],
      ["trailing newline", "SELECT * FROM t;\n"],
      ["several trailing blank lines", "SELECT * FROM t;\n\n\n"],
      ["tabs around the semicolon", "SELECT * FROM t\t;\t\n"],
      ["leading and trailing whitespace around the whole statement", "   SELECT * FROM t;   "],
      ["several trailing semicolons", "SELECT * FROM t;;;"],
      ["CRLF line ending", "SELECT * FROM t;\r\n"],
      ["trailing line comment after the semicolon", "SELECT * FROM t;\n-- done\n"],
      ["trailing block comment after the semicolon", "SELECT * FROM t;\n/* done */\n"],
      [
        "naturally multi-line, human-formatted query ending in one semicolon",
        "SELECT\n    col1,\n    col2\nFROM\n    schema.table\nWHERE\n    col1 = 'value'\n;",
      ],
      [
        "same query with a stray blank line and a tab before the final semicolon",
        "SELECT col1, col2\nFROM schema.table\nWHERE col1 = 'value'\n\n    ;",
      ],
    ];

    it.each(singleStatementFixtures)("%s", (_label, sql) => {
      expect(hasMultipleStatements(sql)).toBe(false);
    });
  });

  describe("category B - genuine multiple statements are always detected", () => {
    const multiStatementFixtures: readonly [string, string][] = [
      ["the baseline gap", "SELECT 1 FROM DUMMY; DELETE FROM real_table"],
      [
        "a scoped write hides an unscoped DROP behind it",
        "DELETE FROM t WHERE id=1; DROP TABLE other",
      ],
      ["the UPDATE equivalent", "UPDATE t SET x=1 WHERE id=1; DROP TABLE other"],
      ["three chained statements", "SELECT 1; SELECT 2; DELETE FROM t"],
      ["multiple consecutive semicolons, then real content", "SELECT 1;;DELETE FROM t"],
      ["an empty statement in between, then real content", "SELECT 1; ; DELETE FROM t"],
      [
        "messy whitespace a human would actually paste in",
        "DELETE FROM t WHERE id = 1;\n\nDROP TABLE other;",
      ],
      ["second statement indented with a tab", "DELETE FROM t WHERE id=1;\n\tDROP TABLE other"],
      ["a line comment between the two statements", "SELECT 1; -- leftover note\nDELETE FROM t"],
      [
        "a block comment spanning several lines between the two statements",
        "SELECT 1;\n/*\n TODO: also clean up old rows here\n*/\nDELETE FROM t",
      ],
      ["CRLF between the two statements", "SELECT 1;\r\nDELETE FROM t"],
    ];

    it.each(multiStatementFixtures)("%s", (_label, sql) => {
      expect(hasMultipleStatements(sql)).toBe(true);
    });
  });

  describe("category C - a semicolon inside a string/comment is never a separator", () => {
    it("a semicolon inside a string literal", () => {
      expect(hasMultipleStatements("SELECT ';' FROM t")).toBe(false);
    });

    it("the same, with extra spaces scattered around", () => {
      expect(hasMultipleStatements("SELECT   ';'   FROM   t")).toBe(false);
    });

    it("multiple semicolons inside one string literal", () => {
      expect(hasMultipleStatements("SELECT 'a;b;c' FROM t")).toBe(false);
    });

    it("a semicolon inside a line comment", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t -- what about a ; here\n")).toBe(false);
    });

    it("a semicolon inside a block comment", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t /* ; not a separator */")).toBe(false);
    });

    it("a string-literal semicolon sitting immediately next to a real separator is still blocked", () => {
      expect(hasMultipleStatements("SELECT ';' FROM t; DELETE FROM other")).toBe(true);
    });
  });

  describe("category D - the routine-body carve-out", () => {
    it("allows a clean procedure body despite its internal semicolons", () => {
      const sql =
        "CREATE PROCEDURE my_proc AS\n" +
        "BEGIN\n" +
        "  DECLARE x INT;\n" +
        "  SELECT 1 INTO x FROM DUMMY;\n" +
        "  UPDATE t SET col = x;\n" +
        "END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("allows the OR REPLACE variant", () => {
      expect(
        hasMultipleStatements(
          "CREATE OR REPLACE PROCEDURE my_proc AS BEGIN DECLARE x INT; END;",
        ),
      ).toBe(false);
    });

    it("allows a schema-qualified routine name", () => {
      expect(
        hasMultipleStatements(
          "CREATE PROCEDURE my_schema.my_proc AS BEGIN DECLARE x INT; END;",
        ),
      ).toBe(false);
    });

    it("allows extra whitespace/tabs/newlines between CREATE and PROCEDURE", () => {
      expect(
        hasMultipleStatements(
          "CREATE\n\tPROCEDURE   my_proc AS\nBEGIN\n  DECLARE x INT;\nEND;",
        ),
      ).toBe(false);
    });

    it("allows lowercase/mixed case", () => {
      expect(
        hasMultipleStatements("create procedure my_proc as begin declare x int; end;"),
      ).toBe(false);
    });

    it("allows the FUNCTION variant", () => {
      expect(
        hasMultipleStatements(
          "CREATE FUNCTION my_func(a INT) RETURNS INT AS BEGIN DECLARE x INT; " +
            "RETURN x; END;",
        ),
      ).toBe(false);
    });

    it("allows the TRIGGER variant", () => {
      expect(
        hasMultipleStatements(
          "CREATE TRIGGER my_trigger AFTER INSERT ON t BEGIN DECLARE x INT; END;",
        ),
      ).toBe(false);
    });

    it("is not confused by a string literal that looks like a dangerous statement", () => {
      const sql =
        "CREATE PROCEDURE my_proc AS\n" +
        "BEGIN\n" +
        "  SELECT 'DROP TABLE not_a_real_command' FROM DUMMY;\n" +
        "  UPDATE t SET col = 1;\n" +
        "END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("negative control: CREATE TABLE is not swept into the exemption", () => {
      expect(hasMultipleStatements("CREATE TABLE t (id INT); DROP TABLE other")).toBe(true);
    });

    it("negative control: CREATE VIEW is not swept into the exemption", () => {
      expect(
        hasMultipleStatements("CREATE VIEW v AS SELECT * FROM t; DROP TABLE other"),
      ).toBe(true);
    });

    it("closed limitation: content genuinely appended after a routine body's own END is now caught", () => {
      // Previously an accepted, disclosed gap (see CHANGELOG): exempting the
      // whole leading routine-creation statement meant a smuggled statement
      // after its real END was not detected either. Depth-tracked BEGIN/END
      // pairing (added to close the ordering bypass below) finds where the
      // body genuinely ends and requires nothing real to follow, closing
      // this as a side effect - it is no longer a residual limitation.
      expect(
        hasMultipleStatements("CREATE PROCEDURE p AS BEGIN DECLARE x INT; END; DROP TABLE other"),
      ).toBe(true);
    });

    it("blocks a reordered BEGIN/END that previously defeated the carve-out entirely", () => {
      expect(
        hasMultipleStatements("CREATE PROCEDURE p AS DELETE FROM t WHERE id=1; DROP TABLE other; END BEGIN"),
      ).toBe(true);
      expect(
        hasMultipleStatements("DO DELETE FROM t WHERE id=1; DROP TABLE other; END BEGIN"),
      ).toBe(true);
    });

    it("blocks both keywords appearing early with real content trailing the close", () => {
      expect(
        hasMultipleStatements("CREATE PROCEDURE p AS BEGIN END DELETE FROM t WHERE id=1; DROP TABLE other"),
      ).toBe(true);
    });

    it("blocks arbitrary content skipped over on the way to a later, legitimate-looking BEGIN...END (independent-review finding)", () => {
      // Depth-tracking BEGIN/END alone is not enough: without also
      // validating the header region itself, the search for "the first
      // top-level BEGIN" can skip straight over an entire independent
      // statement (semicolons and all) on its way to a real BEGIN...END
      // much later in the string, exempting the smuggled statement along
      // with it. Each of these was confirmed live-reproduced against this
      // package before the header-validation fix landed.
      const exploits = [
        "CREATE PROCEDURE p(x INT); DROP TABLE other; SELECT 1 BEGIN END",
        "DO DROP TABLE other; SELECT 1 BEGIN END",
        "CREATE PROCEDURE p AS DROP TABLE customers; SELECT 1; BEGIN DECLARE x INT; END;",
        "CREATE FUNCTION f() DROP TABLE other; SELECT 1 BEGIN END",
        "CREATE TRIGGER t DROP TABLE other; SELECT 1 BEGIN END",
        "CREATE OR REPLACE PROCEDURE p DROP TABLE other; SELECT 1 BEGIN END",
        "CREATE PROCEDURE p DELETE FROM customers; BEGIN END",
        "CREATE PROCEDURE p UPDATE customers SET flag=1; BEGIN END",
      ];
      for (const sql of exploits) {
        expect(hasMultipleStatements(sql)).toBe(true);
      }
    });

    it("blocks a disqualifying keyword smuggled before a chunk's own BEGIN even with no semicolon at all (independent-review finding)", () => {
      // A statement sandwiched between two chained chunks, where the
      // second chunk's own header-to-BEGIN region contains no semicolon
      // at all (so the semicolon check alone would miss it), is still
      // caught because the disqualifying-keyword region check applies
      // independently of whether a `;` is present.
      const sql =
        "CREATE PROCEDURE legit AS BEGIN SELECT 1 FROM DUMMY; END; " +
        "CREATE PROCEDURE p2 DROP TABLE evil BEGIN END";
      expect(hasMultipleStatements(sql)).toBe(true);
    });

    it("does not reject a legitimate TRIGGER header for referencing INSERT/UPDATE/DELETE as its own event keywords", () => {
      // The keyword-disqualification check above must not confuse a
      // TRIGGER's own event vocabulary (BEFORE/AFTER INSERT/UPDATE/
      // DELETE) with a smuggled DML statement - regression coverage
      // distinct from the pre-existing "recognizes/allows" TRIGGER tests,
      // specifically for the new header-validation logic.
      expect(hasMultipleStatements("CREATE TRIGGER t BEFORE INSERT ON tbl BEGIN DECLARE x INT; END;")).toBe(
        false,
      );
      expect(hasMultipleStatements("CREATE TRIGGER t AFTER UPDATE ON tbl BEGIN DECLARE x INT; END;")).toBe(
        false,
      );
      expect(
        hasMultipleStatements("CREATE TRIGGER t INSTEAD OF DELETE ON tbl BEGIN DECLARE x INT; END;"),
      ).toBe(false);
    });

    it("MERGE/UPSERT/REPLACE stay disqualifying even for a TRIGGER header (independent-review finding: no legitimate trigger role)", () => {
      // Only INSERT/UPDATE/DELETE are real HANA trigger event keywords;
      // MERGE/UPSERT/REPLACE have no legitimate role in a trigger header
      // at all, so - unlike those three - they are never exempted, for
      // any header type including TRIGGER. This narrows the residual
      // limitation below to exactly the three real event keywords instead
      // of all six DML verbs. A bare, semicolon-free single statement can
      // never trip hasMultipleStatements regardless of the carve-out
      // (there is nothing for the fallback segment-count to find, with or
      // without the exemption), so - to actually exercise this
      // observably - each case chains the disguised trigger chunk after a
      // separate legitimate definition, matching the main fix's own
      // sandwiched-chunk regression tests.
      const withMerge = "CREATE PROCEDURE legit AS BEGIN X; END; CREATE TRIGGER t2 MERGE customers BEGIN END";
      const withUpsert =
        "CREATE PROCEDURE legit AS BEGIN X; END; " +
        "CREATE TRIGGER t2 UPSERT customers VALUES (1) BEGIN END";
      const withReplace =
        "CREATE PROCEDURE legit AS BEGIN X; END; CREATE TRIGGER t2 REPLACE customers BEGIN END";
      expect(hasMultipleStatements(withMerge)).toBe(true);
      expect(hasMultipleStatements(withUpsert)).toBe(true);
      expect(hasMultipleStatements(withReplace)).toBe(true);
    });

    it("known, narrow residual limitation: a bare (unprefixed) INSERT/UPDATE/DELETE in a TRIGGER-typed chunk's header is not caught", () => {
      // Excluding INSERT/UPDATE/DELETE from the TRIGGER header's
      // disqualifying-keyword set (required so ordinary trigger event
      // clauses keep working - see the regression test above) means a
      // *specifically TRIGGER-typed* chunk whose header references one of
      // those three real event keywords with no BEFORE/AFTER/INSTEAD OF
      // prefix at all is not rejected by this check. This is deliberately
      // not closed further: distinguishing a legitimate event-clause
      // keyword from a bare one requires validating that it is actually
      // preceded by a trigger-timing keyword, which edges into full
      // SQLScript-header grammar parsing - explicitly out of scope for
      // this fix, the same way body-internal parsing is out of scope for
      // the routine-body carve-out itself. Narrower than the finding
      // above (only 3 keywords, not 6) and narrower than the main fix's
      // exploit family: it requires specifically choosing TRIGGER (not
      // PROCEDURE/FUNCTION/DO) as the disguise. Chained after a separate
      // legitimate definition (so a genuine `;` exists for the fallback
      // segment-count to have found, had the chain-check correctly
      // rejected this chunk) to make the gap concretely observable rather
      // than a bare, semicolon-free string that would return `false`
      // regardless of this check's precision. Documented here, not
      // silently left unexamined.
      const sql = "CREATE PROCEDURE legit AS BEGIN X; END; CREATE TRIGGER t2 DELETE FROM customers BEGIN END";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("does not reject a routine/trigger named exactly after a disqualifying keyword (independent-review finding)", () => {
      // The header-to-BEGIN scan must skip the routine's own name before
      // applying the disqualifying-keyword check - otherwise a routine
      // legitimately named e.g. `replace` would be mistaken for a
      // smuggled REPLACE statement's leading verb. Skipping exactly one
      // (optionally schema-qualified, optionally quoted) identifier is
      // safe: a single identifier token can never itself contain a real
      // top-level `;` or a second keyword, so this cannot be abused to
      // also skip real smuggled content.
      expect(hasMultipleStatements("CREATE PROCEDURE replace(x INT) AS BEGIN DECLARE y INT; END;")).toBe(
        false,
      );
      expect(hasMultipleStatements("CREATE PROCEDURE merge AS BEGIN DECLARE y INT; END;")).toBe(false);
      expect(hasMultipleStatements("CREATE PROCEDURE my_schema.upsert AS BEGIN DECLARE y INT; END;")).toBe(
        false,
      );
      expect(
        hasMultipleStatements('CREATE PROCEDURE "replace; DROP TABLE other" AS BEGIN DECLARE y INT; END;'),
      ).toBe(false);
    });

    it("still blocks a genuinely smuggled statement placed right after a plausibly-named routine", () => {
      // Regression guard for the fix above: skipping the routine's own
      // name must not accidentally widen into skipping real smuggled
      // content placed immediately after it.
      expect(
        hasMultipleStatements("CREATE PROCEDURE replace_data; DROP TABLE other; SELECT 1 BEGIN END"),
      ).toBe(true);
      expect(
        hasMultipleStatements("CREATE PROCEDURE replace DROP TABLE other; SELECT 1 BEGIN END"),
      ).toBe(true);
    });

    it("blocks a nested BEGIN whose depth never returns to 0, falling through to the real smuggled statement", () => {
      // The outer BEGIN never finds its matching END (only the inner
      // pair's END is present), so the carve-out itself fails to match
      // regardless of what follows - this exercises that failure path
      // directly, with a real trailing statement so the fallback
      // segment-count check has something genuine to catch.
      expect(hasMultipleStatements("CREATE PROCEDURE p AS BEGIN BEGIN END; DROP TABLE other")).toBe(true);
    });

    it("blocks a stray top-level END with no preceding BEGIN at all", () => {
      expect(
        hasMultipleStatements("CREATE PROCEDURE p AS END DELETE FROM t WHERE id=1; DROP TABLE other"),
      ).toBe(true);
    });

    it("blocks a statement smuggled between two otherwise-legitimate chained routine definitions", () => {
      const sql =
        "CREATE PROCEDURE p1 AS BEGIN X; END; DELETE FROM t WHERE id=1; DROP TABLE other; " +
        "CREATE PROCEDURE p2 AS BEGIN Y; END;";
      expect(hasMultipleStatements(sql)).toBe(true);
    });

    it("still allows two independently-legitimate routine definitions chained back to back", () => {
      const sql = "CREATE PROCEDURE p1 AS BEGIN X; END; CREATE PROCEDURE p2 AS BEGIN Y; END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("allows a multi-clause header (parameter list, LANGUAGE clause) before BEGIN", () => {
      const sql =
        "CREATE PROCEDURE my_proc(IN x INT, OUT y INT)\n" +
        "LANGUAGE SQLSCRIPT\n" +
        "AS\n" +
        "BEGIN\n" +
        "  DECLARE z INT;\n" +
        "END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("allows a nested BEGIN/END block inside an otherwise-normal procedure body", () => {
      const sql =
        "CREATE PROCEDURE p AS\n" +
        "BEGIN\n" +
        "  DECLARE x INT;\n" +
        "  BEGIN\n" +
        "    x := 1;\n" +
        "  END;\n" +
        "  SELECT x FROM DUMMY;\n" +
        "END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });

    it("does not create a bypass when combined with OR REPLACE", () => {
      expect(
        hasMultipleStatements(
          "CREATE OR REPLACE PROCEDURE p AS DELETE FROM t WHERE id=1; DROP TABLE other; END BEGIN",
        ),
      ).toBe(true);
    });

    it("is not confused by comments containing the literal words BEGIN/END", () => {
      const sql =
        "CREATE PROCEDURE p AS\n" +
        "-- BEGIN a note about END behavior\n" +
        "BEGIN\n" +
        "  DECLARE x INT;\n" +
        "END;";
      expect(hasMultipleStatements(sql)).toBe(false);
    });
  });

  describe("review-driven fixes", () => {
    it("no longer exempts a routine-keyword statement with no real body (independent-review finding)", () => {
      expect(hasMultipleStatements("CREATE PROCEDURE p; DROP TABLE other")).toBe(true);
      expect(hasMultipleStatements("CREATE FUNCTION f; DROP TABLE other")).toBe(true);
      expect(hasMultipleStatements("CREATE TRIGGER t; DROP TABLE other")).toBe(true);
      expect(
        hasMultipleStatements("CREATE OR REPLACE PROCEDURE p; DROP TABLE other"),
      ).toBe(true);
    });

    it("exempts a HANA anonymous DO block despite its internal semicolons (independent-review finding)", () => {
      expect(
        hasMultipleStatements(
          "DO BEGIN DECLARE x INT; SELECT 1 INTO x FROM DUMMY; END;",
        ),
      ).toBe(false);
    });

    it("does not exempt a DO block with no real body (mirrors the routine-body fix)", () => {
      expect(hasMultipleStatements("DO SOMETHING; DROP TABLE other")).toBe(true);
    });

    it("does not treat a lone trailing zero-width space as a second statement (independent-review finding)", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t;​")).toBe(false);
      expect(hasMultipleStatements("SELECT 1 FROM t;⁠")).toBe(false);
      expect(hasMultipleStatements("SELECT 1 FROM t;﻿")).toBe(false);
    });

    it("still blocks real content even when padded with zero-width characters", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t;​DROP TABLE other")).toBe(true);
    });

    it("blocks an unclosed top-level paren that would otherwise hide a real separator (independent-review finding)", () => {
      expect(
        hasMultipleStatements("DELETE FROM t WHERE id IN (1, 2; DROP TABLE other"),
      ).toBe(true);
    });

    it("does not flag a single statement with ordinary, fully-balanced parens", () => {
      expect(hasMultipleStatements("DELETE FROM t WHERE id IN (1, 2)")).toBe(false);
    });
  });

  describe("category O - Unicode-property-based zero-width detection covers the whole Cf category", () => {
    // Every character below is built from an explicit \u{...} escape (never
    // a literal invisible character pasted into this file), so the exact
    // code point under test stays legible in source rather than vanishing
    // into whitespace. Each is a genuinely invisible Unicode "Format" (Cf)
    // character that the previous hand-picked code-point list missed - a
    // realistic artifact of copy-pasting SQL out of a chat app, word
    // processor, or web page. Each must remain ALLOWED (not treated as a
    // second statement) now that detection is Unicode-property-based.
    const newlyCoveredFormatChars: readonly [string, string][] = [
      ["U+200E LEFT-TO-RIGHT MARK", "\u{200E}"],
      ["U+200F RIGHT-TO-LEFT MARK", "\u{200F}"],
      ["U+061C ARABIC LETTER MARK", "\u{061C}"],
      ["U+00AD SOFT HYPHEN", "\u{00AD}"],
      ["U+2061 FUNCTION APPLICATION", "\u{2061}"],
      ["U+2062 INVISIBLE TIMES", "\u{2062}"],
      ["U+2063 INVISIBLE SEPARATOR", "\u{2063}"],
      ["U+2064 INVISIBLE PLUS", "\u{2064}"],
      ["U+202A LEFT-TO-RIGHT EMBEDDING", "\u{202A}"],
      ["U+2066 LEFT-TO-RIGHT ISOLATE", "\u{2066}"],
    ];

    it.each(newlyCoveredFormatChars)("%s trailing the final semicolon is not a second statement", (_label, char) => {
      expect(hasMultipleStatements(`SELECT * FROM t;${char}`)).toBe(false);
    });

    const originallyCoveredFormatChars: readonly [string, string][] = [
      ["U+200B ZERO WIDTH SPACE", "\u{200B}"],
      ["U+200C ZERO WIDTH NON-JOINER", "\u{200C}"],
      ["U+200D ZERO WIDTH JOINER", "\u{200D}"],
      ["U+2060 WORD JOINER", "\u{2060}"],
      ["U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)", "\u{FEFF}"],
    ];

    it.each(originallyCoveredFormatChars)("regression: %s (originally hand-listed) still matches", (_label, char) => {
      expect(hasMultipleStatements(`SELECT * FROM t;${char}`)).toBe(false);
    });

    it("a newly-covered format character does not hide real trailing content", () => {
      expect(hasMultipleStatements("SELECT * FROM t;\u{200E}DROP TABLE other")).toBe(true);
    });
  });

  describe("category H - adversarial obfuscation does not defeat or falsely trigger detection", () => {
    it("a fake semicolon inside a comment placed immediately before the real one", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t/*;*/; DELETE FROM other")).toBe(true);
    });

    it("a semicolon inside a line comment, followed by the real separator on the next line", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t -- ;\n; DELETE FROM other")).toBe(true);
    });

    it("a block comment containing several semicolons, immediately followed by the real separator", () => {
      const sql =
        "SELECT 1 FROM t\n" +
        "/*\n" +
        " note; to; self; this; comment; has; many; semicolons\n" +
        "*/\n" +
        "; DELETE FROM other";
      expect(hasMultipleStatements(sql)).toBe(true);
    });

    it("a semicolon inside a string literal nested in a function call, immediately before the real separator", () => {
      expect(
        hasMultipleStatements("SELECT CONCAT(col1, ';', col2) FROM t; DELETE FROM other"),
      ).toBe(true);
    });

    it("is not confused by paren depth from nested subqueries", () => {
      expect(
        hasMultipleStatements(
          "SELECT (SELECT (SELECT 1 FROM DUMMY) FROM DUMMY) FROM DUMMY; DELETE FROM other",
        ),
      ).toBe(true);
    });

    it("a full-width Unicode semicolon is not treated as a separator (matches HANA's own grammar)", () => {
      // Researched, not assumed: standard SQL lexical grammar - which HANA's
      // SQLScript follows - defines the statement terminator as the ASCII
      // semicolon (U+003B) specifically. No SAP HANA documentation indicates
      // any special handling of Unicode look-alike punctuation, so a
      // fullwidth semicolon (U+FF1B, "；") has no grammatical
      // significance to HANA - it is ordinary (almost certainly
      // syntax-error-inducing) content, not a separator. cf-hana correctly
      // matches that: this is one statement as far as the client-side
      // classifier is concerned, same as HANA would see it.
      expect(hasMultipleStatements("SELECT 1 FROM t；DELETE FROM other")).toBe(false);
    });

    it("a zero-width space adjacent to the real semicolon does not hide the smuggled tail", () => {
      expect(hasMultipleStatements("SELECT 1 FROM t​; DELETE FROM other")).toBe(true);
    });
  });

  describe("category I - degenerate input never throws and never changes single/zero-statement behavior", () => {
    const degenerateFixtures: readonly [string, string][] = [
      ["empty string", ""],
      ["nothing but semicolons", ";;;"],
      ["nothing but whitespace", "   \n\t  "],
      ["nothing but a line comment", "-- just a comment\n"],
      ["nothing but a block comment", "/* just a comment */"],
      ["a single semicolon alone", ";"],
    ];

    it.each(degenerateFixtures)("%s does not throw and is not multi-statement", (_label, sql) => {
      expect(() => hasMultipleStatements(sql)).not.toThrow();
      expect(hasMultipleStatements(sql)).toBe(false);
    });
  });

  describe("category L - case-insensitivity of the new detection logic itself", () => {
    it("the routine-body carve-out detection is case-insensitive", () => {
      expect(
        hasMultipleStatements("create procedure my_proc as begin declare x int; end;"),
      ).toBe(false);
    });

    it("the multi-statement detection itself has no case-sensitivity assumptions", () => {
      expect(hasMultipleStatements("SeLeCt 1 FROM dummy; DeLeTe FROM t")).toBe(true);
    });

    it("the reordered-BEGIN/END detection is also case-insensitive", () => {
      expect(
        hasMultipleStatements("create procedure p as delete from t where id=1; drop table other; end begin"),
      ).toBe(true);
    });
  });

  describe("category M - mid-CTE-list semicolon probe", () => {
    it("detects a semicolon placed inside a multi-CTE list rather than after it", () => {
      // This malformed input places a ';' between two CTE definitions
      // instead of after the whole WITH clause. Verified (not assumed): the
      // existing cteListEndIndex parser does NOT already fail closed here by
      // returning undefined - it returns a defined result with an empty
      // "" keyword instead (see the resolveWithStatement-level test below),
      // which is a separate, pre-existing gap this task's independent
      // multi-statement check happens to also close, but does not itself
      // fix. That gap is flagged in the CHANGELOG rather than patched here.
      const sql =
        "WITH a AS (SELECT 1 FROM DUMMY); DELETE FROM t, b AS (SELECT 2 FROM DUMMY) " +
        "SELECT * FROM a, b";
      expect(hasMultipleStatements(sql)).toBe(true);
    });

    it("closed: resolveWithStatement now fails closed for this probe instead of returning an empty keyword", () => {
      // Previously, cteListEndIndex's final fallback returned the position
      // right after the CTE list whenever the next character wasn't a
      // comma, without checking that a real keyword actually starts there -
      // so this malformed input resolved to a *defined* result with an
      // empty "" keyword instead of undefined. Fixed by requiring the
      // character at that position to be keyword-shaped (alphabetic);
      // otherwise the whole resolution now fails closed, exactly like an
      // already-malformed CTE list does.
      const sql =
        "WITH a AS (SELECT 1 FROM DUMMY); DELETE FROM t, b AS (SELECT 2 FROM DUMMY) " +
        "SELECT * FROM a, b";
      expect(resolveWithStatement(sql)).toBeUndefined();
    });
  });

  describe("category N - WITH-continuation validation (closes a gap broader than the semicolon case above)", () => {
    it("fails closed when nonsense punctuation follows a well-formed, semicolon-free CTE list", () => {
      const sql = "WITH a AS (SELECT 1 FROM DUMMY) !!! DELETE FROM customers";
      expect(resolveWithStatement(sql)).toBeUndefined();
      expect(classifyStatement(sql)).toBe("unknown");
    });

    it("still resolves an alphabetic-looking but unrecognized trailing keyword (not swept into the fail-closed fix)", () => {
      // The bug this task fixes is specifically the empty-string-keyword
      // case slipping past the unresolvedWith check - an unrecognized but
      // genuinely keyword-shaped continuation (already correctly handled
      // today, matching a bare equivalent's classification) must keep
      // resolving, not start failing closed too.
      const sql = "WITH a AS (SELECT 1 FROM DUMMY) XYZ123 SELECT * FROM a";
      const result = resolveWithStatement(sql);
      expect(result).toEqual({ keyword: "XYZ123", index: expect.any(Number) });
      expect(classifyStatement(sql)).toBe("unknown");
    });

    it("regression: a comma-free single-CTE statement with a real trailing SELECT still resolves", () => {
      expect(resolveWithStatement("WITH a AS (SELECT 1 FROM DUMMY) SELECT * FROM a")).toEqual({
        keyword: "SELECT",
        index: expect.any(Number),
      });
    });

    it("regression: a well-formed multi-CTE list with a real trailing SELECT still resolves", () => {
      const sql = "WITH a AS (SELECT 1 FROM DUMMY), b AS (SELECT 2 FROM DUMMY) SELECT * FROM a, b";
      expect(resolveWithStatement(sql)).toEqual({ keyword: "SELECT", index: expect.any(Number) });
    });
  });
});
