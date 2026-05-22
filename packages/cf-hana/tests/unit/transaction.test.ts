import { describe, expect, it } from "vitest";

import { Connection } from "../../src/connection.js";
import { Transaction } from "../../src/transaction.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

async function openTxConnection() {
  const driver = new FakeHanaDriver(() => ({ affectedRows: 1 }));
  const connection = await Connection.open(driver, sampleConnectionConfig());
  return { driver, connection };
}

describe("Transaction", () => {
  it("executes statements and commits", async () => {
    const { driver, connection } = await openTxConnection();
    const tx = new Transaction(connection);
    await tx.execute("INSERT INTO T VALUES (1)");
    await tx.commit();
    expect(driver.connections[0]?.commitCount).toBe(1);
    expect(tx.isFinished).toBe(true);
  });

  it("rolls back", async () => {
    const { driver, connection } = await openTxConnection();
    const tx = new Transaction(connection);
    await tx.rollback();
    expect(driver.connections[0]?.rollbackCount).toBe(1);
    expect(tx.isFinished).toBe(true);
  });

  it("runs queries within the transaction", async () => {
    const { connection } = await openTxConnection();
    const tx = new Transaction(connection);
    await expect(tx.query("SELECT * FROM T")).resolves.toMatchObject({ statement: "select" });
  });

  it("rejects any use after commit", async () => {
    const { connection } = await openTxConnection();
    const tx = new Transaction(connection);
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(/already been committed/);
    await expect(tx.query("SELECT 1 FROM DUMMY")).rejects.toThrow(/already been committed/);
  });
});
