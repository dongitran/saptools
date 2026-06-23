import { readDbAppView } from "@saptools/cf-sync";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HanaClient } from "../../src/client.js";
import type { ConnectionConfig } from "../../src/connection.js";
import { ConnectionPool } from "../../src/pool.js";
import { classifyStatement } from "../../src/statements.js";
import type { HanaClientInfo } from "../../src/types.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import type { FakeResponder } from "./fixtures/fake-driver.js";
import { sampleBinding, sampleConnectionConfig, sampleDbAppView } from "./fixtures/samples.js";

vi.mock("@saptools/cf-sync", () => ({
  readDbAppView: vi.fn(),
  fetchAppDbBindings: vi.fn(),
}));

const SAMPLE_INFO: HanaClientInfo = {
  selector: "eu10/acme/dev/orders-api",
  appName: "orders-api",
  host: "hana.example.internal",
  schema: "APP_SCHEMA",
  role: "runtime",
  driver: "fake",
  credentialSource: "cache",
};

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

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("HanaClient", () => {
  it("runs a query", async () => {
    const { client } = makeClient();
    await expect(client.query("SELECT * FROM ORDERS")).resolves.toMatchObject({
      rows: [{ ID: 1 }],
    });
  });

  it("runs an execute statement", async () => {
    const { client } = makeClient();
    await expect(client.execute("INSERT INTO ORDERS VALUES (1)")).resolves.toMatchObject({
      rowCount: 2,
    });
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
    vi.mocked(readDbAppView).mockResolvedValue(sampleDbAppView([sampleBinding()]));
    vi.stubEnv("CF_HANA_DRIVER", "fake");
    const client = await HanaClient.connect("orders-api");
    expect(client.info.driver).toBe("fake");
    expect(client.info.schema).toBe("APP_SCHEMA");
    expect(client.info.role).toBe("runtime");
    expect(client.info.credentialSource).toBe("cache");
    await client.close();
  });
});
