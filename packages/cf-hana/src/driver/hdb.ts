import { createClient } from "hdb";
import type { HdbClient, HdbColumnMetadata, HdbStatement } from "hdb";

import { CfHanaError, QueryError } from "../errors.js";
import { quoteIdentifier } from "../statements.js";
import type { QueryResultColumn, SqlParam } from "../types.js";

import type {
  DriverConnectParams,
  DriverConnection,
  DriverExecResult,
  HanaDriver,
} from "./types.js";

const TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "NULL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INTEGER",
  4: "BIGINT",
  5: "DECIMAL",
  6: "REAL",
  7: "DOUBLE",
  8: "CHAR",
  9: "VARCHAR",
  10: "NCHAR",
  11: "NVARCHAR",
  12: "BINARY",
  13: "VARBINARY",
  14: "DATE",
  15: "TIME",
  16: "TIMESTAMP",
  25: "CLOB",
  26: "NCLOB",
  27: "BLOB",
  28: "BOOLEAN",
  29: "STRING",
  30: "NSTRING",
  47: "DECIMAL",
  51: "TEXT",
  52: "SHORTTEXT",
  62: "DECIMAL",
};

function typeName(code: number): string {
  return TYPE_NAMES[code] ?? `TYPE_${String(code)}`;
}

function extractSqlState(error: Error): string | undefined {
  const value = (error as { readonly sqlState?: unknown }).sqlState;
  return typeof value === "string" ? value : undefined;
}

function toQueryError(error: Error): QueryError {
  const sqlState = extractSqlState(error);
  return sqlState === undefined
    ? new QueryError(error.message, { cause: error })
    : new QueryError(error.message, { cause: error, sqlState });
}

function toColumns(
  metadata: readonly HdbColumnMetadata[] | undefined,
): readonly QueryResultColumn[] {
  if (metadata === undefined) {
    return [];
  }
  return metadata.map((column) => ({
    name: column.columnDisplayName ?? column.columnName ?? "",
    typeName: typeName(column.dataType),
  }));
}

function toExecResult(statement: HdbStatement, raw: unknown): DriverExecResult {
  if (typeof raw === "number") {
    return { rows: [], columns: [], affectedRows: raw };
  }
  if (Array.isArray(raw)) {
    return {
      rows: raw as readonly Record<string, SqlParam>[],
      columns: toColumns(statement.resultSetMetadata),
      affectedRows: 0,
    };
  }
  return { rows: [], columns: [], affectedRows: 0 };
}

class HdbConnection implements DriverConnection {
  private closed = false;

  constructor(private readonly client: HdbClient) {}

  async exec(sql: string, params: readonly SqlParam[]): Promise<DriverExecResult> {
    const statement = await this.prepareStatement(sql);
    try {
      const raw = await this.executeStatement(statement, params);
      return toExecResult(statement, raw);
    } finally {
      dropStatementQuietly(statement);
    }
  }

  setAutoCommit(enabled: boolean): Promise<void> {
    this.client.setAutoCommit(enabled);
    return Promise.resolve();
  }

  async commit(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.commit((error) => {
        if (error) {
          reject(toQueryError(error));
        } else {
          resolve();
        }
      });
    });
  }

  async rollback(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.rollback((error) => {
        if (error) {
          reject(toQueryError(error));
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.client.disconnect(() => {
        resolve();
      });
    });
    this.client.close();
  }

  isClosed(): boolean {
    return (
      this.closed ||
      this.client.readyState === "closed" ||
      this.client.readyState === "disconnected"
    );
  }

  private async prepareStatement(sql: string): Promise<HdbStatement> {
    return await new Promise<HdbStatement>((resolve, reject) => {
      this.client.prepare(sql, (error, statement) => {
        if (error) {
          reject(toQueryError(error));
        } else {
          resolve(statement);
        }
      });
    });
  }

  private async executeStatement(
    statement: HdbStatement,
    params: readonly SqlParam[],
  ): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      statement.exec([...params], (error, result) => {
        if (error) {
          reject(toQueryError(error));
        } else {
          resolve(result);
        }
      });
    });
  }
}

function dropStatementQuietly(statement: HdbStatement): void {
  try {
    statement.drop();
  } catch {
    // Best-effort cleanup; preserve the query result or original query error.
  }
}

function openClient(client: HdbClient, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      client.close();
      reject(
        new CfHanaError(
          "TIMEOUT",
          `HANA connection timed out after ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref();
    client.connect((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(
          new CfHanaError("CONNECTION", `Failed to connect to HANA: ${error.message}`, {
            cause: error,
          }),
        );
      } else {
        resolve();
      }
    });
  });
}

async function closeClientQuietly(client: HdbClient): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      client.disconnect(() => {
        resolve();
      });
    });
  } catch {
    // Best-effort cleanup after a partially opened connection.
  }
  try {
    client.close();
  } catch {
    // Best-effort cleanup after a partially opened connection.
  }
}

function setCurrentSchema(client: HdbClient, schema: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.exec(`SET SCHEMA ${quoteIdentifier(schema)}`, (error) => {
      if (error) {
        reject(toQueryError(error));
      } else {
        resolve();
      }
    });
  });
}

async function connectHdb(params: DriverConnectParams): Promise<DriverConnection> {
  const client = createClient({
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password,
    ca: params.certificate,
    useTLS: true,
  });
  await openClient(client, params.connectTimeoutMs);
  try {
    await setCurrentSchema(client, params.schema);
  } catch (error) {
    await closeClientQuietly(client);
    throw error;
  }
  return new HdbConnection(client);
}

/** Build the production HANA driver backed by the pure-JavaScript `hdb` library. */
export function createHdbDriver(): HanaDriver {
  return {
    name: "hdb",
    connect: connectHdb,
  };
}
