import { describe, expect, it } from "vitest";

import { describeTable, listColumns, listSchemas, listTables } from "../../src/catalog.js";
import { Connection } from "../../src/connection.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import type { FakeResponder } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

const catalogResponder: FakeResponder = (sql) => {
  if (sql.includes("SYS.SCHEMAS")) {
    return {
      rows: [{ SCHEMA_NAME: "APP" }, { SCHEMA_NAME: "SYS" }],
      columns: [{ name: "SCHEMA_NAME", typeName: "NVARCHAR" }],
    };
  }
  if (sql.includes("SYS.TABLES")) {
    return {
      rows: [{ SCHEMA_NAME: "APP", TABLE_NAME: "ORDERS", TABLE_TYPE: "COLUMN TABLE" }],
      columns: [],
    };
  }
  if (sql.includes("SYS.TABLE_COLUMNS")) {
    return {
      rows: [
        {
          COLUMN_NAME: "ID",
          DATA_TYPE_NAME: "INTEGER",
          LENGTH: 10,
          SCALE: null,
          IS_NULLABLE: "FALSE",
          POSITION: 1,
        },
        {
          COLUMN_NAME: "NOTE",
          DATA_TYPE_NAME: "NVARCHAR",
          LENGTH: 255,
          SCALE: null,
          IS_NULLABLE: "TRUE",
          POSITION: 2,
        },
      ],
      columns: [],
    };
  }
  return {};
};

async function openCatalogConnection(): Promise<{
  readonly connection: Connection;
  readonly driver: FakeHanaDriver;
}> {
  const driver = new FakeHanaDriver(catalogResponder);
  const connection = await Connection.open(driver, sampleConnectionConfig());
  return { connection, driver };
}

describe("catalog", () => {
  it("lists schemas", async () => {
    const { connection } = await openCatalogConnection();
    await expect(listSchemas(connection)).resolves.toEqual(["APP", "SYS"]);
  });

  it("lists tables in a schema", async () => {
    const { connection } = await openCatalogConnection();
    await expect(listTables(connection, "APP")).resolves.toEqual([
      { schema: "APP", name: "ORDERS", type: "COLUMN TABLE", rowCount: undefined },
    ]);
  });

  it("lists columns of a table", async () => {
    const { connection } = await openCatalogConnection();
    await expect(listColumns(connection, "APP", "ORDERS")).resolves.toEqual([
      {
        name: "ID",
        dataType: "INTEGER",
        length: 10,
        scale: undefined,
        nullable: false,
        position: 1,
      },
      {
        name: "NOTE",
        dataType: "NVARCHAR",
        length: 255,
        scale: undefined,
        nullable: true,
        position: 2,
      },
    ]);
  });

  it("describes a table together with its columns", async () => {
    const { connection } = await openCatalogConnection();
    const description = await describeTable(connection, "APP", "ORDERS");
    expect(description.table?.name).toBe("ORDERS");
    expect(description.columns).toHaveLength(2);
  });

  it("does not auto-limit catalog metadata queries", async () => {
    const { connection, driver } = await openCatalogConnection();

    await listSchemas(connection);
    await listTables(connection, "APP");
    await listColumns(connection, "APP", "ORDERS");

    const sql = driver.connections[0]?.execCalls.map((call) => call.sql) ?? [];
    expect(sql.every((statement) => !statement.includes(" LIMIT "))).toBe(true);
  });
});
