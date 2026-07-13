import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cf from "../../src/cf.js";
import type { CurrentCfTarget } from "../../src/cf.js";
import { HanaClient } from "../../src/client.js";
import type { ConnectionConfig } from "../../src/connection.js";
import { ConnectionPool } from "../../src/pool.js";
import { classifyStatement } from "../../src/statements.js";
import type { HanaClientInfo } from "../../src/types.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import type { FakeResponder } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

const sampleTarget = {
  apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
  orgName: "example-org",
  spaceName: "space-demo",
  regionKey: "eu10",
};

const SAMPLE_INFO: HanaClientInfo = {
  selector: "eu10/example-org/space-demo/app-demo",
  appName: "app-demo",
  host: "hana.example.internal",
  schema: "APP_SCHEMA",
  role: "runtime",
  driver: "fake",
  credentialSource: "live",
};

let tempHome: string;

const clientResponder: FakeResponder = (sql) => {
  if (sql.includes("COUNT(*)")) {
    return { rows: [{ COUNT: 7 }], columns: [{ name: "COUNT", typeName: "BIGINT" }] };
  }
  if (sql.includes("SYS.TABLES")) {
    return {
      rows: [{ SCHEMA_NAME: "APP_SCHEMA", TABLE_NAME: "ORDERS", TABLE_TYPE: "COLUMN TABLE" }],
      columns: [],
    };
  }
  if (classifyStatement(sql) === "select") {
    return { rows: [{ ID: 1 }], columns: [{ name: "ID", typeName: "INTEGER" }] };
  }
  return { affectedRows: 2 };
};

function makeClient(
  responder: FakeResponder = clientResponder,
  overrides?: Partial<ConnectionConfig>,
) {
  const driver = new FakeHanaDriver(responder);
  const pool = new ConnectionPool(driver, sampleConnectionConfig(overrides));
  return { driver, client: new HanaClient(pool, SAMPLE_INFO) };
}

async function readHistoryEntries(): Promise<readonly Record<string, unknown>[]> {
  const historyDir = join(tempHome, ".saptools", "cf-hana", "histories");
  try {
    const files = await readdir(historyDir);
    const entries: Record<string, unknown>[] = [];
    for (const file of files) {
      const raw = await readFile(join(historyDir, file), "utf8");
      entries.push(
        ...raw
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readBackupCsvFiles(): Promise<readonly string[]> {
  const backupRoot = join(tempHome, ".saptools", "cf-hana", "backups");
  try {
    const months = await readdir(backupRoot);
    const files: string[] = [];
    for (const month of months) {
      const monthDir = join(backupRoot, month);
      const entries = await readdir(monthDir);
      for (const entry of entries) {
        if (entry.endsWith(".sql") && !entry.endsWith(".statement.sql")) {
          files.push(await readFile(join(monthDir, entry), "utf8"));
        }
      }
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "cf-hana-client-"));
  vi.spyOn(cf, "readCurrentCfTarget").mockResolvedValue(sampleTarget as CurrentCfTarget);
  vi.spyOn(cf, "cfEnvDirect").mockResolvedValue(`VCAP_SERVICES:
{"hana":[{"name":"hana-primary","credentials":{"host":"hana.example.internal","port":"443","user":"DB_USER","password":"db-password","schema":"APP_SCHEMA","hdi_user":"HDI_USER","hdi_password":"HDI_PASSWORD","url":"","database_id":"DB-1","certificate":"test-certificate"}}]}
VCAP_APPLICATION:{}`);
  vi.stubEnv("HOME", tempHome);
  vi.stubEnv("USERPROFILE", tempHome);
  vi.stubEnv("SAP_EMAIL", "user@example.com");
  vi.stubEnv("SAP_PASSWORD", "secret");
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("HanaClient", () => {
  it("runs a query", async () => {
    const { client } = makeClient();
    await expect(client.query("SELECT * FROM ORDERS")).resolves.toMatchObject({
      rows: [{ ID: 1 }],
    });
  });

  it("records direct query history without parameter values", async () => {
    const { client } = makeClient();
    await client.query("SELECT * FROM ORDERS WHERE TOKEN = ?", [
      "hidden-parameter-value",
    ]);

    const entries = await readHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      selector: "eu10/example-org/space-demo/app-demo",
      appName: "app-demo",
      schema: "APP_SCHEMA",
      operation: "query",
      statement: "select",
      sql: "SELECT * FROM ORDERS WHERE TOKEN = ?",
      paramCount: 1,
      rowCount: 1,
    });
    expect(JSON.stringify(entries)).not.toContain("hidden-parameter-value");
  });

  it("runs an execute statement", async () => {
    const { client } = makeClient();
    await expect(client.execute("INSERT INTO ORDERS VALUES (1)")).resolves.toMatchObject({
      rowCount: 2,
    });
  });

  it("records direct execute history", async () => {
    const { client } = makeClient();
    await client.execute("UPDATE ORDERS SET STATUS = ? WHERE ID = ?", ["DONE", 1]);

    await expect(readHistoryEntries()).resolves.toEqual([
      expect.objectContaining({
        operation: "execute",
        statement: "dml",
        sql: "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
        paramCount: 2,
        rowCount: 2,
      }),
    ]);
  });

  it("backs up rows for a write statement before callers execute it", async () => {
    const { driver, client } = makeClient((sql, params) => {
      if (sql === "SELECT * FROM ORDERS WHERE ID = ?") {
        return {
          rows: [{ ID: params[0] as number, STATUS: "OPEN" }],
          columns: [
            { name: "ID", typeName: "INTEGER" },
            { name: "STATUS", typeName: "NVARCHAR" },
          ],
        };
      }
      return { affectedRows: 1 };
    });

    const backup = await client.backupWriteStatement(
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      ["DONE", 7],
    );
    await client.query("UPDATE ORDERS SET STATUS = ? WHERE ID = ?", ["DONE", 7]);

    expect(backup?.rowCount).toBe(1);
    expect(driver.connections[0]?.execCalls.map((call) => call.sql)).toEqual([
      "SELECT * FROM ORDERS WHERE ID = ?",
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
    ]);
    await expect(readBackupCsvFiles()).resolves.toEqual(["ID,STATUS\r\n7,OPEN"]);
  });

  it("backs up rows for an UPSERT statement before callers execute it", async () => {
    const { driver, client } = makeClient((sql, params) => {
      if (sql === "SELECT * FROM ORDERS WHERE ID = ?") {
        return {
          rows: [{ ID: params[0] as number, STATUS: "OPEN" }],
          columns: [
            { name: "ID", typeName: "INTEGER" },
            { name: "STATUS", typeName: "NVARCHAR" },
          ],
        };
      }
      return { affectedRows: 1 };
    });

    const sql = "UPSERT ORDERS VALUES (?, ?) WHERE ID = ?";
    const backup = await client.backupWriteStatement(sql, [7, "DONE", 7]);
    await client.query(sql, [7, "DONE", 7]);

    expect(backup?.rowCount).toBe(1);
    expect(driver.connections[0]?.execCalls.map((call) => call.sql)).toEqual([
      "SELECT * FROM ORDERS WHERE ID = ?",
      sql,
    ]);
    await expect(readBackupCsvFiles()).resolves.toEqual(["ID,STATUS\r\n7,OPEN"]);
  });

  it("backs up rows for REPLACE before callers execute it", async () => {
    const { driver, client } = makeClient();
    const sql = "REPLACE ORDERS VALUES (?, ?) WHERE ID = ?";

    const backup = await client.backupWriteStatement(sql, [7, "DONE", 7]);
    await client.query(sql, [7, "DONE", 7]);

    expect(backup?.rowCount).toBe(1);
    expect(driver.connections[0]?.execCalls.map((call) => call.sql)).toEqual([
      "SELECT * FROM ORDERS WHERE ID = ?",
      sql,
    ]);
  });

  it("backs up matched MERGE rows before callers execute it", async () => {
    const { driver, client } = makeClient();
    const sql =
      "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
      "WHEN MATCHED THEN UPDATE SET target.STATUS = source.STATUS";

    const backup = await client.backupWriteStatement(sql);
    await client.query(sql);

    expect(backup?.rowCount).toBe(1);
    expect(driver.connections[0]?.execCalls.map((call) => call.sql)).toEqual([
      "SELECT target.* FROM ORDERS target " +
        "WHERE EXISTS (SELECT 1 FROM SOURCE_ROWS source WHERE (target.ID = source.ID))",
      sql,
    ]);
  });

  it("refuses an unbackable MERGE before opening a database connection", async () => {
    const { driver, client } = makeClient();
    await expect(
      client.backupWriteStatement(
        "MERGE INTO (SELECT * FROM ORDERS) target USING SOURCE_ROWS source " +
          "ON target.ID = source.ID WHEN MATCHED THEN DELETE",
      ),
    ).rejects.toThrow(/trustworthy backup target/i);
    expect(driver.connections).toHaveLength(0);
  });

  it("does not create a backup for non-write statements", async () => {
    const { client } = makeClient();
    await expect(client.backupWriteStatement("SELECT * FROM ORDERS")).resolves.toBeUndefined();
    await expect(readBackupCsvFiles()).resolves.toEqual([]);
  });

  it("does not run the write when the backup SELECT fails", async () => {
    const failure = new Error("backup read failed");
    const { driver, client } = makeClient((sql) => {
      if (sql === "SELECT * FROM ORDERS WHERE ID = ?") {
        return { error: failure };
      }
      return { affectedRows: 1 };
    });

    await expect(
      client.backupWriteStatement("DELETE FROM ORDERS WHERE ID = ?", [7]),
    ).rejects.toThrow("backup read failed");

    expect(driver.connections[0]?.execCalls.map((call) => call.sql)).toEqual([
      "SELECT * FROM ORDERS WHERE ID = ?",
    ]);
    await expect(readBackupCsvFiles()).resolves.toEqual([]);
  });

  it("builds a SELECT via selectFrom", async () => {
    const { driver, client } = makeClient();
    await client.selectFrom({ schema: "APP_SCHEMA", table: "ORDERS", where: { ID: 1 } });
    expect(driver.connections[0]?.execCalls[0]?.sql).toContain('"APP_SCHEMA"."ORDERS"');
  });

  it("counts rows", async () => {
    const { client } = makeClient();
    await expect(client.count({ schema: "APP_SCHEMA", table: "ORDERS" })).resolves.toBe(7);
  });

  it("inserts, updates and deletes rows", async () => {
    const { driver, client } = makeClient();
    await client.insertInto("APP_SCHEMA", "ORDERS", { ID: 1, STATUS: "OPEN" });
    await client.update("APP_SCHEMA", "ORDERS", { STATUS: "SHIPPED" }, { ID: 1 });
    await client.deleteFrom("APP_SCHEMA", "ORDERS", { ID: 1 });
    const statements = driver.connections[0]?.execCalls.map((call) => call.sql) ?? [];
    expect(statements[0]).toContain("INSERT INTO");
    expect(statements[1]).toContain("UPDATE");
    expect(statements[2]).toContain("DELETE FROM");
  });

  it("lists tables", async () => {
    const { client } = makeClient();
    await expect(client.listTables("APP_SCHEMA")).resolves.toEqual([
      { schema: "APP_SCHEMA", name: "ORDERS", type: "COLUMN TABLE", rowCount: undefined },
    ]);
  });

  it("does not record catalog helper SQL as user history", async () => {
    const { client } = makeClient();
    await client.listTables("APP_SCHEMA");
    await expect(readHistoryEntries()).resolves.toEqual([]);
  });

  it("uses distinct statement names for concurrent explain calls", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123);
    const { driver, client } = makeClient();
    await Promise.all([
      client.explain("SELECT * FROM ORDERS"),
      client.explain("SELECT * FROM ORDERS"),
    ]);

    const explainStatements = driver.connections
      .flatMap((connection) => connection.execCalls)
      .map((call) => call.sql)
      .filter((sql) => sql.startsWith("EXPLAIN PLAN"));
    const names = explainStatements.map((sql) => {
      const match = /STATEMENT_NAME = '([^']+)'/.exec(sql);
      return match?.[1] ?? "";
    });

    expect(new Set(names).size).toBe(2);
    now.mockRestore();
  });

  it("explains a SELECT on a read-only client and still cleans up", async () => {
    const { driver, client } = makeClient(clientResponder, { readOnly: true });
    await expect(client.explain("SELECT * FROM ORDERS")).resolves.toMatchObject({
      statement: "select",
    });

    const statements = driver.connections[0]?.execCalls.map((call) => call.sql) ?? [];
    expect(statements.some((sql) => sql.startsWith("EXPLAIN PLAN"))).toBe(true);
    expect(
      statements.some((sql) => sql.startsWith("DELETE FROM EXPLAIN_PLAN_TABLE")),
    ).toBe(true);
  });

  it("does not explain DML on a read-only client", async () => {
    const { driver, client } = makeClient(clientResponder, { readOnly: true });
    await expect(client.explain("DELETE FROM ORDERS WHERE ID = ?", [1])).rejects.toThrow(
      /read-only/,
    );
    expect(driver.connections[0]?.execCalls).toHaveLength(0);
  });

  it("commits a transaction on success", async () => {
    const { driver, client } = makeClient();
    const result = await client.transaction(async (tx) => {
      await tx.execute("INSERT INTO ORDERS VALUES (1)");
      return "done";
    });
    expect(result).toBe("done");
    expect(driver.connections[0]?.commitCount).toBe(1);
  });

  it("rolls back a transaction when the work throws", async () => {
    const { driver, client } = makeClient();
    await expect(
      client.transaction(() => Promise.reject(new Error("work failed"))),
    ).rejects.toThrow("work failed");
    expect(driver.connections[0]?.rollbackCount).toBe(1);
  });

  it("connect() resolves credentials and builds a client", async () => {
    vi.stubEnv("CF_HANA_DRIVER", "fake");
    const client = await HanaClient.connect("app-demo");
    expect(client.info.driver).toBe("fake");
    expect(client.info.schema).toBe("APP_SCHEMA");
    expect(client.info.role).toBe("runtime");
    expect(client.info.credentialSource).toBe("live");
    await client.close();
  });
});
