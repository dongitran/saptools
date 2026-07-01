import { appendFile } from "node:fs/promises";

import { envName, readEnv } from "../config.js";
import { QueryError } from "../errors.js";
import { classifyStatement } from "../statements.js";
import type { SqlParam } from "../types.js";

import type {
  DriverConnectParams,
  DriverConnection,
  DriverExecResult,
  HanaDriver,
} from "./types.js";

let catalogFailureInjected = false;

/**
 * Deterministic in-memory driver used by hermetic end-to-end tests and offline
 * smoke checks. Selected via `CF_HANA_DRIVER=fake`. It never opens a socket.
 */
interface FakeCatalogObjectRow extends Record<string, SqlParam> {
  readonly SCHEMA_NAME: string;
  readonly OBJECT_NAME: string;
  readonly OBJECT_TYPE: "TABLE" | "VIEW";
}

function catalogObjects(): readonly FakeCatalogObjectRow[] {
  return [
    { SCHEMA_NAME: "APP_SCHEMA", OBJECT_NAME: "EXISTING_TABLE", OBJECT_TYPE: "TABLE" },
    { SCHEMA_NAME: "APP_SCHEMA", OBJECT_NAME: "MISSING_TABLE_FIXED", OBJECT_TYPE: "TABLE" },
    { SCHEMA_NAME: "APP_SCHEMA", OBJECT_NAME: "MISSING_TABLE_VIEW", OBJECT_TYPE: "VIEW" },
    { SCHEMA_NAME: "APP_SCHEMA", OBJECT_NAME: "STATUS_ITEMS", OBJECT_TYPE: "TABLE" },
  ];
}

function fakeExec(sql: string): DriverExecResult {
  const kind = classifyStatement(sql);
  const forcedFailure = readEnv(envName("FAKE_FAIL_STATEMENT"))?.toLowerCase();
  if (forcedFailure === kind) {
    throw new Error(`fake driver forced ${kind.toUpperCase()} failure`);
  }

  const upperSql = sql.toUpperCase();
  if (upperSql.includes("SYS.TABLES") && upperSql.includes("SYS.VIEWS")) {
    if (readEnv(envName("FAKE_FAIL_CATALOG_ONCE")) === "1" && !catalogFailureInjected) {
      catalogFailureInjected = true;
      throw new QueryError("fake transient catalog metadata failure");
    }
    return {
      rows: catalogObjects(),
      columns: [
        { name: "SCHEMA_NAME", typeName: "NVARCHAR" },
        { name: "OBJECT_NAME", typeName: "NVARCHAR" },
        { name: "OBJECT_TYPE", typeName: "NVARCHAR" },
      ],
      affectedRows: 0,
    };
  }

  if (upperSql.includes("MISSING_TABLE") || upperSql.includes("MISSING_TABLES")) {
    throw new QueryError("invalid table name: MISSING_TABLE", { sqlState: "42S02" });
  }

  if (sql.toUpperCase().includes("LOB_FIXTURE")) {
    return {
      rows: [
        {
          LOG_CONTENT: Buffer.from("Example log entry", "utf8"),
          CLOB_CONTENT: Buffer.from("Clob log entry", "utf8"),
          PAYLOAD: Buffer.from([0, 1, 2, 255]),
        },
      ],
      columns: [
        { name: "LOG_CONTENT", typeName: "NCLOB" },
        { name: "CLOB_CONTENT", typeName: "CLOB" },
        { name: "PAYLOAD", typeName: "BLOB" },
      ],
      affectedRows: 0,
    };
  }

  if (sql.toUpperCase().includes("DUMMY")) {
    return {
      rows: [{ "1": 1 }],
      columns: [{ name: "1", typeName: "INTEGER" }],
      affectedRows: 0,
    };
  }

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
