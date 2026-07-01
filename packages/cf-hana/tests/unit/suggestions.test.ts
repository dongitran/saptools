import { describe, expect, it } from "vitest";

import { QueryError } from "../../src/errors.js";
import {
  extractMissingObjectName,
  extractMissingObjectNameFromError,
  isInvalidCatalogObjectError,
  rankCatalogSuggestions,
} from "../../src/suggestions.js";

const candidates = [
  { schema: "APP_SCHEMA", name: "MISSING_TABLE_FIXED", type: "TABLE" as const },
  { schema: "APP_SCHEMA", name: "MISSING_TABLE_VIEW", type: "VIEW" as const },
  { schema: "APP_SCHEMA", name: "STATUS_ITEM", type: "TABLE" as const },
  { schema: "OTHER_SCHEMA", name: "MISSING_TABLE", type: "TABLE" as const },
];

describe("invalid catalog object suggestions", () => {
  it("detects HANA invalid object failures conservatively", () => {
    expect(isInvalidCatalogObjectError(new QueryError("invalid table name", { sqlState: "42S02" }))).toBe(true);
    expect(isInvalidCatalogObjectError(new QueryError("syntax error"))).toBe(false);
    expect(isInvalidCatalogObjectError(new Error("invalid table name"))).toBe(false);
  });

  it("prefers conservative missing object extraction from HANA error text", () => {
    expect(
      extractMissingObjectNameFromError(
        new QueryError(
          "invalid table name: \"APP_SCHEMA\".\"Missing Table\"",
          { sqlState: "42S02" },
        ),
      ),
    ).toEqual({ schema: "APP_SCHEMA", name: "Missing Table" });
    expect(
      extractMissingObjectNameFromError(
        new QueryError("table APP_SCHEMA.MISSING_TABLE does not exist", { sqlState: "42S02" }),
      ),
    ).toEqual({ schema: "APP_SCHEMA", name: "MISSING_TABLE" });
    expect(extractMissingObjectNameFromError(new Error("invalid table name: ORDERS"))).toBeUndefined();
  });

  it.each([
    ["select *\n\n\n From \n\n MISSING_TABLE\n where ID = ?", "MISSING_TABLE", undefined],
    ["SELECT t.ID FROM /* leading table comment */ APP_SCHEMA.MISSING_TABLE t WHERE t.STATUS = 'FROM nope'", "MISSING_TABLE", "APP_SCHEMA"],
    ["UPDATE\n APP_SCHEMA\n .\n MISSING_TABLE\nSET STATUS = ? WHERE ID = ?", "MISSING_TABLE", "APP_SCHEMA"],
    ["INSERT\nINTO \"APP_SCHEMA\".\"MISSING_TABLE\" (ID, STATUS) VALUES (?, ?)", "MISSING_TABLE", "APP_SCHEMA"],
    ["DELETE\nFROM\n APP_SCHEMA.MISSING_TABLE WHERE ID = ?", "MISSING_TABLE", "APP_SCHEMA"],
    ["MERGE\nINTO\nAPP_SCHEMA.MISSING_TABLE AS target USING SOURCE_TABLE AS source ON target.ID = source.ID WHEN MATCHED THEN UPDATE SET STATUS = source.STATUS", "MISSING_TABLE", "APP_SCHEMA"],
    ["TRUNCATE TABLE APP_SCHEMA.MISSING_TABLE", "MISSING_TABLE", "APP_SCHEMA"],
    ["SeLeCt t.ID FrOm App_Schema.Missing_Table t", "Missing_Table", "App_Schema"],
    ["SELECT * FROM EXISTING_TABLE e LEFT OUTER JOIN APP_SCHEMA.MISSING_TABLE m ON m.ID = e.ID", "MISSING_TABLE", "APP_SCHEMA"],
    ["SELECT * FROM EXISTING_TABLE e, MISSING_TABLE m WHERE e.ID = m.ID", "MISSING_TABLE", undefined],
    ["SELECT ID FROM EXISTING_TABLE UNION ALL SELECT ID FROM MISSING_TABLE", "MISSING_TABLE", undefined],
    ["SELECT * FROM ( SELECT * FROM MISSING_TABLE ) derived_alias", "MISSING_TABLE", undefined],
    ["SELECT * FROM \"APP_SCHEMA\".\"my.service::MissingEntity\"", "my.service::MissingEntity", "APP_SCHEMA"],
    ["SELECT * FROM \"APP_SCHEMA\".\"Name \"\"With Quote\"\"\"", "Name \"With Quote\"", "APP_SCHEMA"],
    ["SELECT *\r\nFROM -- table comes next\r\n MISSING_TABLE", "MISSING_TABLE", undefined],
  ])("extracts %s", (sql, name, schema) => {
    expect(extractMissingObjectName(sql)).toEqual(schema === undefined ? { name } : { schema, name });
  });

  it("skips strings, CTE references, derived aliases, and function-like FROM expressions", () => {
    expect(extractMissingObjectName("SELECT 'FROM MISSING_TABLE' AS TEXT_VALUE FROM EXISTING_TABLE WHERE NOTE = 'JOIN OTHER_MISSING_TABLE'")).toEqual({ name: "EXISTING_TABLE" });
    expect(extractMissingObjectName("WITH MISSING_TABLE AS (SELECT * FROM EXISTING_TABLE) SELECT * FROM MISSING_TABLE")).toEqual({ name: "EXISTING_TABLE" });
    expect(extractMissingObjectName("SELECT * FROM MISSING_TABLE_FUNCTION(?)")).toBeUndefined();
  });

  it("ranks schema-qualified, plural, prefix, and view suggestions deterministically", () => {
    expect(rankCatalogSuggestions({ schema: "APP_SCHEMA", name: "MISSING_TABLE" }, candidates).map((item) => item.name)).toEqual([
      "MISSING_TABLE_VIEW",
      "MISSING_TABLE_FIXED",
    ]);
    expect(rankCatalogSuggestions({ name: "STATUS_ITEMS" }, candidates)[0]?.name).toBe("STATUS_ITEM");
    expect(rankCatalogSuggestions({ name: "ZZZ" }, candidates)).toEqual([]);
  });
});
