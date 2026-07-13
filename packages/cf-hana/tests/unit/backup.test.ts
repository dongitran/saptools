import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

  it("derives a SELECT for REPLACE with the same grammar as UPSERT", () => {
    expect(
      buildWriteBackupPlan(
        "REPLACE APP.ORDERS (ID, STATUS) VALUES (?, ?) WHERE ID = ?",
        [7, "DONE", 7],
      ),
    ).toEqual({
      operation: "replace",
      statementSql: "REPLACE APP.ORDERS (ID, STATUS) VALUES (?, ?) WHERE ID = ?",
      selectSql: "SELECT * FROM APP.ORDERS WHERE ID = ?",
      selectParams: [7],
    });
  });

  it("backs up the whole REPLACE target for WITH PRIMARY KEY", () => {
    expect(buildWriteBackupPlan("REPLACE ORDERS VALUES (?, ?) WITH PRIMARY KEY", [7, "DONE"]))
      .toEqual({
        operation: "replace",
        statementSql: "REPLACE ORDERS VALUES (?, ?) WITH PRIMARY KEY",
        selectSql: "SELECT * FROM ORDERS",
        selectParams: [],
      });
  });

  it("backs up the whole UPSERT or REPLACE target for subquery forms", () => {
    expect(buildWriteBackupPlan("UPSERT ORDERS SELECT ID, STATUS FROM SOURCE_ROWS", [])).toEqual({
      operation: "upsert",
      statementSql: "UPSERT ORDERS SELECT ID, STATUS FROM SOURCE_ROWS",
      selectSql: "SELECT * FROM ORDERS",
      selectParams: [],
    });
    expect(buildWriteBackupPlan("REPLACE ORDERS SELECT ID, STATUS FROM SOURCE_ROWS", []))
      .toEqual({
        operation: "replace",
        statementSql: "REPLACE ORDERS SELECT ID, STATUS FROM SOURCE_ROWS",
        selectSql: "SELECT * FROM ORDERS",
        selectParams: [],
      });
  });

  it("uses the unpartitioned base target as a conservative REPLACE pre-image", () => {
    expect(
      buildWriteBackupPlan(
        "REPLACE APP.ORDERS PARTITION (1) (ID, STATUS) VALUES (?, ?)",
        [7, "DONE"],
      ),
    ).toMatchObject({
      operation: "replace",
      selectSql: "SELECT * FROM APP.ORDERS",
      selectParams: [],
    });
  });

  it("derives an exact matched-row pre-image for MERGE INTO", () => {
    const sql =
      "MERGE INTO APP.ORDERS AS target " +
      "USING (SELECT ID, STATUS FROM SOURCE_ROWS WHERE GROUP_ID = ?) AS source " +
      "ON target.ID = source.ID AND target.TENANT = ? " +
      "WHEN MATCHED AND target.STATE = ? THEN UPDATE SET target.STATUS = ? " +
      "WHEN NOT MATCHED THEN INSERT (ID, STATUS) VALUES (?, ?)";

    expect(buildWriteBackupPlan(sql, [4, "TENANT", "OPEN", "DONE", 7, "NEW"]))
      .toEqual({
        operation: "merge",
        statementSql: sql,
        selectSql:
          "SELECT target.* FROM APP.ORDERS AS target " +
          "WHERE EXISTS (SELECT 1 FROM " +
          "(SELECT ID, STATUS FROM SOURCE_ROWS WHERE GROUP_ID = ?) AS source " +
          "WHERE (target.ID = source.ID AND target.TENANT = ?) " +
          "AND (target.STATE = ?))",
        selectParams: [4, "TENANT", "OPEN"],
      });
  });

  it("backs up matched MERGE DELETE rows", () => {
    const sql =
      "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
      "WHEN MATCHED THEN DELETE";
    expect(buildWriteBackupPlan(sql)).toMatchObject({
      operation: "merge",
      selectSql:
        "SELECT target.* FROM ORDERS target " +
        "WHERE EXISTS (SELECT 1 FROM SOURCE_ROWS source WHERE (target.ID = source.ID))",
      selectParams: [],
    });
  });

  it("falls back to a whole-target MERGE pre-image when matched clauses are ambiguous", () => {
    const sql =
      "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
      "WHEN MATCHED THEN UPDATE SET target.STATUS = source.STATUS " +
      "WHEN MATCHED THEN DELETE";
    expect(buildWriteBackupPlan(sql)).toMatchObject({
      operation: "merge",
      selectSql: "SELECT * FROM ORDERS",
      selectParams: [],
    });
  });

  it("does not back up insert-only MERGE or MERGE DELTA statements", () => {
    expect(
      buildWriteBackupPlan(
        "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
          "WHEN NOT MATCHED THEN INSERT (ID) VALUES (source.ID)",
      ),
    ).toBeUndefined();
    expect(buildWriteBackupPlan("MERGE DELTA OF ORDERS")).toBeUndefined();
  });

  it("refuses a modifying MERGE whose base target is ambiguous", () => {
    expect(() =>
      buildWriteBackupPlan(
        "MERGE INTO (SELECT * FROM ORDERS) target USING SOURCE_ROWS source " +
          "ON target.ID = source.ID WHEN MATCHED THEN DELETE",
      ),
    ).toThrow(/cannot derive a trustworthy backup target/i);
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

  it("creates private backup directories and files", async () => {
    const record = await writeSqlBackup(sampleBackupInput(), {
      now: fixedNow(),
      saptoolsRoot: join(rootDir, ".saptools"),
    });

    expect((await stat(record.directory)).mode & 0o777).toBe(0o700);
    await expect(Promise.all([
      stat(record.statementPath),
      stat(record.backupPath),
      stat(record.metadataPath),
    ])).resolves.toEqual([
      expect.objectContaining({ mode: expect.any(Number) }),
      expect.objectContaining({ mode: expect.any(Number) }),
      expect.objectContaining({ mode: expect.any(Number) }),
    ]);
    for (const path of [record.statementPath, record.backupPath, record.metadataPath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses an oversized backup before creating local files", async () => {
    const saptoolsRoot = join(rootDir, ".saptools");
    await expect(
      writeSqlBackup(sampleBackupInput(), {
        now: fixedNow(),
        saptoolsRoot,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/backup exceeds the storage limit/i);
    await expect(stat(cfHanaBackupRoot(saptoolsRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
