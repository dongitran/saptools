import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

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

  it("derives a SELECT for UPSERT with a WHERE clause", () => {
    expect(
      buildWriteBackupPlan("UPSERT ORDERS VALUES (?, ?) WHERE ID = ?", [7, "DONE", 7]),
    ).toEqual({
      operation: "upsert",
      statementSql: "UPSERT ORDERS VALUES (?, ?) WHERE ID = ?",
      selectSql: "SELECT * FROM ORDERS WHERE ID = ?",
      selectParams: [7],
    });
  });

  it("derives a SELECT for UPSERT with an explicit column list", () => {
    expect(
      buildWriteBackupPlan(
        "UPSERT APP.ORDERS (ID, STATUS) VALUES (?, ?) WHERE ID = ?",
        [7, "DONE", 7],
      ),
    ).toEqual({
      operation: "upsert",
      statementSql: "UPSERT APP.ORDERS (ID, STATUS) VALUES (?, ?) WHERE ID = ?",
      selectSql: "SELECT * FROM APP.ORDERS WHERE ID = ?",
      selectParams: [7],
    });
  });

  it("backs up the whole UPSERT target when no WHERE clause is provided", () => {
    expect(buildWriteBackupPlan("UPSERT ORDERS VALUES (?, ?)", [7, "DONE"])).toEqual({
      operation: "upsert",
      statementSql: "UPSERT ORDERS VALUES (?, ?)",
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
    const record = await writeSqlBackup(
      sampleBackupInput({ selector: "eu10/example-org/space-demo/app-demo" }),
      {
        now: fixedNow(),
        saptoolsRoot,
      },
    );

    expect(record.directory).toBe(join(cfHanaBackupRoot(saptoolsRoot), "202606"));
    expect(dirname(record.backupPath)).toBe(record.directory);
    expect(basename(record.backupPath)).toMatch(
      /^eu10-example-org-space-demo-app-demo-update-2026-06-23T120000000Z\.sql$/,
    );
    expect(extname(record.backupPath)).toBe(".sql");
    await expect(readFile(record.statementPath, "utf8")).resolves.toBe(
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?\n",
    );
    await expect(readFile(record.backupPath, "utf8")).resolves.toBe(
      "ID,STATUS\r\n1,OPEN",
    );
    await expect(readFile(record.metadataPath, "utf8")).resolves.toContain(
      "eu10/example-org/space-demo/app-demo",
    );
    expect(record.rowCount).toBe(1);
  });
});
