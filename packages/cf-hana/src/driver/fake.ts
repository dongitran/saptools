import { appendFile } from "node:fs/promises";

import { envName, readEnv } from "../config.js";
import { classifyStatement } from "../statements.js";
import type { SqlParam } from "../types.js";

import type {
  DriverConnectParams,
  DriverConnection,
  DriverExecResult,
  HanaDriver,
} from "./types.js";

/**
 * Deterministic in-memory driver used by hermetic end-to-end tests and offline
 * smoke checks. Selected via `CF_HANA_DRIVER=fake`. It never opens a socket.
 */
function fakeExec(sql: string): DriverExecResult {
  if (sql.toUpperCase().includes("DUMMY")) {
    return {
      rows: [{ "1": 1 }],
      columns: [{ name: "1", typeName: "INTEGER" }],
      affectedRows: 0,
    };
  }

  const kind = classifyStatement(sql);
  if (kind === "select") {
    return {
      rows: [
        { ID: 1, NAME: "sample-row" },
        { ID: 2, NAME: "second-row" },
      ],
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "NAME", typeName: "NVARCHAR" },
      ],
      affectedRows: 0,
    };
  }
  if (kind === "dml") {
    return { rows: [], columns: [], affectedRows: 1 };
  }
  return { rows: [], columns: [], affectedRows: 0 };
}

/** Opt-in fake-driver trace; parameter values stay out of test artifacts. */
async function traceFakeExec(sql: string, params: readonly SqlParam[]): Promise<void> {
  const tracePath = readEnv(envName("FAKE_TRACE_FILE"));
  if (tracePath === undefined) {
    return;
  }
  const entry = { sql, paramCount: params.length };
  await appendFile(tracePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

class FakeConnection implements DriverConnection {
  private closed = false;

  async exec(sql: string, params: readonly SqlParam[]): Promise<DriverExecResult> {
    await traceFakeExec(sql, params);
    return fakeExec(sql);
  }

  setAutoCommit(_enabled: boolean): Promise<void> {
    return Promise.resolve();
  }

  commit(): Promise<void> {
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/** Build the deterministic test-only fake HANA driver. */
export function createFakeDriver(): HanaDriver {
  return {
    name: "fake",
    connect: (_params: DriverConnectParams): Promise<DriverConnection> =>
      Promise.resolve(new FakeConnection()),
  };
}
