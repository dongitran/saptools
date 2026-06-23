import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildWriteBackupPlan,
  cfHanaBackupRoot,
  writeSqlBackup,
} from "../../src/backup.js";
import type { SqlBackupWriteInput } from "../../src/backup.js";

let rootDir: string;

function fixedNow(): Date {
  return new Date(Date.UTC(2026, 5, 23, 12, 0, 0));
}

function sampleBackupInput(
  overrides: Partial<SqlBackupWriteInput> = {},
): SqlBackupWriteInput {
  return {
    operation: "update",
    statementSql: "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
    result: {
      rows: [{ ID: 1, STATUS: "OPEN" }],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "STATUS", typeName: "NVARCHAR" },
      ],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 3,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "cf-hana-backup-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("write backup planning", () => {
  it("derives a SELECT for UPDATE and keeps only WHERE parameters", () => {
    expect(
      buildWriteBackupPlan("UPDATE ORDERS SET STATUS = ? WHERE ID = ?", ["DONE", 7]),
    ).toEqual({
      operation: "update",
      statementSql: "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      selectSql: "SELECT * FROM ORDERS WHERE ID = ?",
      selectParams: [7],
    });
  });

  it("derives a SELECT for DELETE", () => {
    expect(buildWriteBackupPlan("DELETE FROM ORDERS WHERE STATUS = ?", ["OPEN"])).toEqual({
      operation: "delete",
      statementSql: "DELETE FROM ORDERS WHERE STATUS = ?",
      selectSql: "SELECT * FROM ORDERS WHERE STATUS = ?",
      selectParams: ["OPEN"],
    });
  });

  it("ignores keyword-like text in strings, comments, and quoted identifiers", () => {
    const plan = buildWriteBackupPlan(
      'UPDATE "ORDER SET" SET NOTE = ?, NAME = \'where\' /* where */ WHERE "ID" = ?',
      ["note", 3],
    );
    expect(plan).toMatchObject({
      operation: "update",
      selectSql: 'SELECT * FROM "ORDER SET" WHERE "ID" = ?',
      selectParams: [3],
    });
  });

  it("uses the top-level WHERE when SET expressions contain nested WHERE clauses", () => {
    const plan = buildWriteBackupPlan(
      "UPDATE ORDERS SET TOTAL = (SELECT COUNT(*) FROM ITEMS WHERE ORDER_ID = ?) WHERE ID = ?",
      [42, 7],
    );
    expect(plan).toMatchObject({
      operation: "update",
      selectSql: "SELECT * FROM ORDERS WHERE ID = ?",
      selectParams: [7],
    });
  });

  it("backs up the whole target when an allowed write has no WHERE", () => {
    expect(buildWriteBackupPlan("DELETE FROM ORDERS", [])).toMatchObject({
      operation: "delete",
      selectSql: "SELECT * FROM ORDERS",
      selectParams: [],
    });
  });

  it("returns undefined for non-write statements", () => {
    expect(buildWriteBackupPlan("SELECT * FROM ORDERS", [])).toBeUndefined();
  });

  it("rejects unsupported DELETE syntax", () => {
    expect(() => buildWriteBackupPlan("DELETE ORDERS WHERE ID = ?", [1])).toThrow(
      /DELETE FROM/,
    );
  });
});

describe("writeSqlBackup", () => {
  it("writes one statement file and one CSV file under the backup root", async () => {
    const saptoolsRoot = join(rootDir, ".saptools");
    const record = await writeSqlBackup(sampleBackupInput(), {
      now: fixedNow(),
      saptoolsRoot,
    });

    expect(record.directory.startsWith(cfHanaBackupRoot(saptoolsRoot))).toBe(true);
    expect(basename(record.directory)).toMatch(/^2026-06-23T120000000Z-update-/);
    await expect(readFile(record.statementPath, "utf8")).resolves.toBe(
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?\n",
    );
    await expect(readFile(record.backupPath, "utf8")).resolves.toBe(
      "ID,STATUS\r\n1,OPEN",
    );
    expect(record.rowCount).toBe(1);
  });
});
