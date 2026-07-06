import { describe, expect, it } from "vitest";

import type { ConnectionConfig } from "../../src/connection.js";
import { Connection } from "../../src/connection.js";
import { DestructiveStatementError, ReadOnlyViolationError } from "../../src/errors.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import type { FakeResponder } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

async function openConn(responder: FakeResponder, overrides?: Partial<ConnectionConfig>) {
  const driver = new FakeHanaDriver(responder);
  const connection = await Connection.open(driver, sampleConnectionConfig(overrides));
  return { driver, connection };
}

describe("Connection", () => {
  it("runs a SELECT and returns typed rows", async () => {
    const { connection } = await openConn(() => ({
      rows: [{ ID: 1, NAME: "Alice" }],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "NAME", typeName: "NVARCHAR" },
      ],
    }));
    const result = await connection.query("SELECT * FROM ORDERS");
    expect(result.statement).toBe("select");
    expect(result.rows).toEqual([{ ID: 1, NAME: "Alice" }]);
    expect(result.rowCount).toBe(1);
  });

  it("normalizes HANA BOOLEAN cells to JavaScript booleans", async () => {
    const { connection } = await openConn(() => ({
      rows: [{ ID: 1, ACTIVE: 1, DELETED: 0, PUBLISHED: "1", ARCHIVED: "0", COUNT: 0 }],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "ACTIVE", typeName: "BOOLEAN" },
        { name: "DELETED", typeName: "BOOLEAN" },
        { name: "PUBLISHED", typeName: "BOOLEAN" },
        { name: "ARCHIVED", typeName: "BOOLEAN" },
        { name: "COUNT", typeName: "INTEGER" },
      ],
    }));

    const result = await connection.query(
      "SELECT ID, ACTIVE, DELETED, PUBLISHED, ARCHIVED, COUNT FROM ORDERS",
    );

    expect(result.rows).toEqual([
      { ID: 1, ACTIVE: true, DELETED: false, PUBLISHED: true, ARCHIVED: false, COUNT: 0 },
    ]);
  });

  it("runs a DML statement and reports affected rows", async () => {
    const { connection } = await openConn(() => ({ affectedRows: 4 }));
    const result = await connection.execute("UPDATE ORDERS SET S = ? WHERE ID = ?", ["X", 1]);
    expect(result.statement).toBe("dml");
    expect(result.rowCount).toBe(4);
  });

  it("fetches one extra row and clips a truncated SELECT", async () => {
    const { driver, connection } = await openConn(
      () => ({
        rows: [{ ID: 1 }, { ID: 2 }, { ID: 3 }],
        columns: [{ name: "ID", typeName: "INTEGER" }],
      }),
      { autoLimit: 2 },
    );
    const result = await connection.query("SELECT * FROM ORDERS");
    expect(driver.connections[0]?.execCalls[0]?.sql).toContain("LIMIT 3");
    expect(result.rows).toEqual([{ ID: 1 }, { ID: 2 }]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation when exactly the requested rows exist", async () => {
    const { connection } = await openConn(
      () => ({
        rows: [{ ID: 1 }, { ID: 2 }],
        columns: [{ name: "ID", typeName: "INTEGER" }],
      }),
      { autoLimit: 2 },
    );

    const result = await connection.query("SELECT * FROM ORDERS");

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("rejects an invalid API auto-limit", async () => {
    const { connection } = await openConn(() => ({}));
    await expect(
      connection.query("SELECT * FROM ORDERS", [], { autoLimit: 0 }),
    ).rejects.toThrow(/positive safe integer/);
  });

  it("rejects a parameter-count mismatch", async () => {
    const { connection } = await openConn(() => ({}));
    await expect(connection.query("SELECT * FROM T WHERE A = ?", [])).rejects.toThrow(
      /expects 1/,
    );
  });

  it("blocks DML in read-only mode", async () => {
    const { connection } = await openConn(() => ({}), { readOnly: true });
    await expect(connection.execute("INSERT INTO T VALUES (1)")).rejects.toBeInstanceOf(
      ReadOnlyViolationError,
    );
  });

  it("blocks destructive statements unless allowed", async () => {
    const { connection } = await openConn(() => ({}));
    await expect(connection.execute("DROP TABLE T")).rejects.toBeInstanceOf(
      DestructiveStatementError,
    );
  });

  it("permits destructive statements when allowDestructive is set", async () => {
    const { connection } = await openConn(() => ({ affectedRows: 0 }), {
      allowDestructive: true,
    });
    await expect(connection.execute("DROP TABLE T")).resolves.toMatchObject({
      statement: "ddl",
    });
  });

  it("times out a slow statement", async () => {
    const { connection } = await openConn(() => ({ delayMs: 200 }), { queryTimeoutMs: 20 });
    await expect(connection.query("SELECT 1 FROM DUMMY")).rejects.toThrow(/timed out/);
  });

  it("delegates commit, rollback and autocommit to the driver", async () => {
    const { driver, connection } = await openConn(() => ({}));
    await connection.setAutoCommit(false);
    await connection.commit();
    await connection.rollback();
    expect(driver.connections[0]?.autoCommit).toBe(false);
    expect(driver.connections[0]?.commitCount).toBe(1);
    expect(driver.connections[0]?.rollbackCount).toBe(1);
  });

  it("closes the underlying driver connection", async () => {
    const { connection } = await openConn(() => ({}));
    expect(connection.isClosed).toBe(false);
    await connection.close();
    expect(connection.isClosed).toBe(true);
  });
});
