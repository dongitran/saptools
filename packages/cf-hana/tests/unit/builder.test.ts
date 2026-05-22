import { describe, expect, it } from "vitest";

import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from "../../src/builder.js";

describe("buildSelect", () => {
  it("builds SELECT * with an equality WHERE filter", () => {
    expect(buildSelect({ schema: "APP", table: "ORDERS", where: { STATUS: "OPEN" } })).toEqual({
      sql: 'SELECT * FROM "APP"."ORDERS" WHERE "STATUS" = ?',
      params: ["OPEN"],
    });
  });

  it("projects columns and applies ORDER BY, LIMIT and OFFSET", () => {
    const built = buildSelect({
      schema: "APP",
      table: "ORDERS",
      columns: ["ID", "STATUS"],
      orderBy: ["ID"],
      limit: 10,
      offset: 5,
    });
    expect(built.sql).toBe(
      'SELECT "ID", "STATUS" FROM "APP"."ORDERS" ORDER BY "ID" LIMIT 10 OFFSET 5',
    );
    expect(built.params).toEqual([]);
  });
});

describe("buildCount", () => {
  it("builds a COUNT(*) statement", () => {
    expect(buildCount({ schema: "APP", table: "ORDERS" }).sql).toBe(
      'SELECT COUNT(*) AS "COUNT" FROM "APP"."ORDERS"',
    );
  });
});

describe("buildInsert", () => {
  it("builds a parameterized INSERT", () => {
    expect(buildInsert("APP", "ORDERS", { ID: 1, STATUS: "OPEN" })).toEqual({
      sql: 'INSERT INTO "APP"."ORDERS" ("ID", "STATUS") VALUES (?, ?)',
      params: [1, "OPEN"],
    });
  });

  it("rejects an INSERT with no values", () => {
    expect(() => buildInsert("APP", "ORDERS", {})).toThrow(/at least one/);
  });
});

describe("buildUpdate", () => {
  it("builds a parameterized UPDATE with values then filters", () => {
    expect(buildUpdate("APP", "ORDERS", { STATUS: "SHIPPED" }, { ID: 1 })).toEqual({
      sql: 'UPDATE "APP"."ORDERS" SET "STATUS" = ? WHERE "ID" = ?',
      params: ["SHIPPED", 1],
    });
  });

  it("rejects an UPDATE without a WHERE filter", () => {
    expect(() => buildUpdate("APP", "ORDERS", { STATUS: "X" }, {})).toThrow(/WHERE/);
  });

  it("rejects an UPDATE with no values", () => {
    expect(() => buildUpdate("APP", "ORDERS", {}, { ID: 1 })).toThrow(/at least one/);
  });
});

describe("buildDelete", () => {
  it("builds a parameterized DELETE", () => {
    expect(buildDelete("APP", "ORDERS", { ID: 1 })).toEqual({
      sql: 'DELETE FROM "APP"."ORDERS" WHERE "ID" = ?',
      params: [1],
    });
  });

  it("rejects a DELETE without a WHERE filter", () => {
    expect(() => buildDelete("APP", "ORDERS", {})).toThrow(/WHERE/);
  });
});
