import { appendFile } from "node:fs/promises";

import { envName, readEnv } from "../config.js";
import { QueryError } from "../errors.js";
import { classifyStatement } from "../statements.js";
import type { SqlParam, StatementKind } from "../types.js";

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
    { SCHEMA_NAME: "APP_SCHEMA", OBJECT_NAME: "CORE_AUTH_SCOPE", OBJECT_TYPE: "TABLE" },
  ];
}

function tableColumns(): readonly Record<string, SqlParam>[] {
  return [
    { COLUMN_NAME: "ID", DATA_TYPE_NAME: "INTEGER", LENGTH: null, SCALE: null, IS_NULLABLE: "FALSE", POSITION: 1 },
    { COLUMN_NAME: "IS_ACTIVE", DATA_TYPE_NAME: "BOOLEAN", LENGTH: null, SCALE: null, IS_NULLABLE: "TRUE", POSITION: 2 },
    { COLUMN_NAME: "SCOPE_NAME", DATA_TYPE_NAME: "NVARCHAR", LENGTH: 255, SCALE: null, IS_NULLABLE: "TRUE", POSITION: 3 },
  ];
}

function throwForcedFailure(kind: StatementKind): void {
  const forcedFailure = readEnv(envName("FAKE_FAIL_STATEMENT"))?.toLowerCase();
  if (forcedFailure === kind) {
    throw new Error(`fake driver forced ${kind.toUpperCase()} failure`);
  }
}

function throwEarlyFixtureError(upperSql: string): void {
  if (upperSql.includes("PRIVILEGE_ERROR_CODE")) {
    throw new QueryError("insufficient privilege: not authorized", { databaseCode: 258 });
  }
  if (upperSql.includes("PRIVILEGE_ERROR_MESSAGE")) {
    throw new QueryError("insufficient privilege: grant is missing");
  }
  if (upperSql.includes("NON_PRIVILEGE_ERROR")) {
    throw new QueryError("fake unrelated query failure", { databaseCode: 999 });
  }
  if (
    readEnv(envName("FAKE_PRIVILEGE_CATALOG")) === "1" &&
    (upperSql.includes("SYS.TABLES") || upperSql.includes("SYS.TABLE_COLUMNS"))
  ) {
    throw new QueryError("insufficient privilege: catalog access denied", { databaseCode: 258 });
  }
}

function catalogObjectsResult(): DriverExecResult {
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

function tablesResult(): DriverExecResult {
  return {
    rows: [
      { SCHEMA_NAME: "APP_SCHEMA", TABLE_NAME: "EXISTING_TABLE", TABLE_TYPE: "COLUMN TABLE" },
      { SCHEMA_NAME: "APP_SCHEMA", TABLE_NAME: "STATUS_ITEMS", TABLE_TYPE: "ROW TABLE" },
    ],
    columns: [
      { name: "SCHEMA_NAME", typeName: "NVARCHAR" },
      { name: "TABLE_NAME", typeName: "NVARCHAR" },
      { name: "TABLE_TYPE", typeName: "NVARCHAR" },
    ],
    affectedRows: 0,
  };
}

function tableColumnsResult(): DriverExecResult {
  return {
    rows: tableColumns(),
    columns: [
      { name: "COLUMN_NAME", typeName: "NVARCHAR" },
      { name: "DATA_TYPE_NAME", typeName: "NVARCHAR" },
      { name: "LENGTH", typeName: "INTEGER" },
      { name: "SCALE", typeName: "INTEGER" },
      { name: "IS_NULLABLE", typeName: "NVARCHAR" },
      { name: "POSITION", typeName: "INTEGER" },
    ],
    affectedRows: 0,
  };
}

function matchCatalogFixture(upperSql: string): DriverExecResult | undefined {
  if (upperSql.includes("SYS.TABLES") && upperSql.includes("SYS.VIEWS")) {
    if (readEnv(envName("FAKE_FAIL_CATALOG_ONCE")) === "1" && !catalogFailureInjected) {
      catalogFailureInjected = true;
      throw new QueryError("fake transient catalog metadata failure");
    }
    return catalogObjectsResult();
  }
  if (upperSql.includes("SYS.TABLES")) {
    return tablesResult();
  }
  if (upperSql.includes("SYS.TABLE_COLUMNS")) {
    return tableColumnsResult();
  }
  return void 0;
}

function throwLateFixtureError(upperSql: string): void {
  if (upperSql.includes("MISSING_TABLE") || upperSql.includes("MISSING_TABLES")) {
    throw new QueryError("invalid table name: MISSING_TABLE", { sqlState: "42S02" });
  }
  if (upperSql.includes("ISACTIVE")) {
    throw new QueryError("invalid column name: ISACTIVE: line 1 col 8 (at pos 7)", { databaseCode: 260 });
  }
  if (upperSql.includes("LOB_ORDER_ERROR")) {
    throw new QueryError("inconsistent datatype: LOB type is not allowed in ORDER BY clause", { databaseCode: 266 });
  }
  if (upperSql.includes("LOB_GROUP_ERROR")) {
    throw new QueryError("inconsistent datatype: LOB type is not allowed in GROUP BY clause", { databaseCode: 274 });
  }
}

function lobFixtureResult(): DriverExecResult {
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

function matchDataFixture(upperSql: string): DriverExecResult | undefined {
  if (upperSql.includes("LOB_FIXTURE")) {
    return lobFixtureResult();
  }
  if (upperSql.includes("SINGLE_COLUMN_FIXTURE")) {
    return {
      rows: [{ VALUE: "alpha" }, { VALUE: "beta" }],
      columns: [{ name: "VALUE", typeName: "NVARCHAR" }],
      affectedRows: 0,
    };
  }
  if (upperSql.includes("DUMMY")) {
    return {
      rows: [{ "1": 1 }],
      columns: [{ name: "1", typeName: "INTEGER" }],
      affectedRows: 0,
    };
  }
  return void 0;
}

function defaultResult(kind: StatementKind): DriverExecResult {
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

function fakeExec(sql: string): DriverExecResult {
  const kind = classifyStatement(sql);
  throwForcedFailure(kind);
  const upperSql = sql.toUpperCase();
  throwEarlyFixtureError(upperSql);
  const catalogFixture = matchCatalogFixture(upperSql);
  if (catalogFixture !== undefined) {
    return catalogFixture;
  }
  throwLateFixtureError(upperSql);
  return matchDataFixture(upperSql) ?? defaultResult(kind);
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
