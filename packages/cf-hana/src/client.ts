import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate } from "./builder.js";
import { listColumns, listSchemas, listTables } from "./catalog.js";
import {
  DEFAULT_AUTO_LIMIT,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "./config.js";
import type { ConnectionConfig } from "./connection.js";
import { resolveAppBindings, selectBinding, toConnectionTarget } from "./credentials.js";
import { createDriver } from "./driver/index.js";
import { ConnectionPool } from "./pool.js";
import { Transaction } from "./transaction.js";
import type {
  ColumnInfo,
  ConnectOptions,
  DbUserRole,
  HanaClientInfo,
  PoolOptions,
  QueryOptions,
  QueryResult,
  QueryRow,
  SelectSpec,
  SqlParam,
  TableInfo,
} from "./types.js";

/**
 * The high-level entry point: a pooled, reusable client for the HANA database
 * bound to a single Cloud Foundry app.
 */
export class HanaClient {
  constructor(
    private readonly pool: ConnectionPool,
    readonly info: HanaClientInfo,
  ) {}

  /** Open a client for a `region/org/space/app` selector (or a bare app name). */
  static async connect(selector: string, options: ConnectOptions = {}): Promise<HanaClient> {
    const resolved = await resolveAppBindings(selector, options);
    const role: DbUserRole = options.role ?? "runtime";
    const binding = selectBinding(resolved.bindings, options);
    const target = toConnectionTarget(binding, role);
    const driver = createDriver();

    const config: ConnectionConfig = {
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      schema: target.schema,
      certificate: target.certificate,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      readOnly: options.readOnly ?? false,
      allowDestructive: options.allowDestructive ?? false,
      autoLimit: options.autoLimit ?? DEFAULT_AUTO_LIMIT,
    };
    const poolOptions: PoolOptions =
      options.pool === false ? { max: 1 } : (options.pool ?? {});

    const info: HanaClientInfo = {
      selector: resolved.selector,
      appName: resolved.appName,
      host: target.host,
      schema: target.schema,
      role,
      driver: driver.name,
      credentialSource: resolved.source,
    };
    return new HanaClient(new ConnectionPool(driver, config, poolOptions), info);
  }

  /** Run a SELECT (or any read) statement and return typed rows. */
  async query<TRow = QueryRow>(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    return await this.pool.withConnection((connection) =>
      connection.query<TRow>(sql, params, options),
    );
  }

  /** Run a DML/DDL statement and return its affected-row count. */
  async execute(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    return await this.pool.withConnection((connection) =>
      connection.execute(sql, params, options),
    );
  }

  /** Run a typed `SELECT` built from a spec. */
  async selectFrom<TRow = QueryRow>(spec: SelectSpec): Promise<QueryResult<TRow>> {
    const built = buildSelect(spec);
    return await this.query<TRow>(built.sql, built.params);
  }

  /** Count rows in a table, optionally filtered. */
  async count(spec: Pick<SelectSpec, "schema" | "table" | "where">): Promise<number> {
    const built = buildCount(spec);
    const result = await this.query<{ COUNT: number }>(built.sql, built.params);
    return result.rows[0]?.COUNT ?? 0;
  }

  /** Insert a single row. */
  async insertInto(
    schema: string,
    table: string,
    values: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildInsert(schema, table, values);
    return await this.execute(built.sql, built.params);
  }

  /** Update rows matching a non-empty `where` filter. */
  async update(
    schema: string,
    table: string,
    values: Readonly<Record<string, SqlParam>>,
    where: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildUpdate(schema, table, values, where);
    return await this.execute(built.sql, built.params);
  }

  /** Delete rows matching a non-empty `where` filter. */
  async deleteFrom(
    schema: string,
    table: string,
    where: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildDelete(schema, table, where);
    return await this.execute(built.sql, built.params);
  }

  /** Run `work` inside a transaction, auto-committing on success. */
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return await this.pool.withConnection(async (connection) => {
      await connection.setAutoCommit(false);
      const tx = new Transaction(connection);
      try {
        const result = await work(tx);
        if (!tx.isFinished) {
          await tx.commit();
        }
        return result;
      } catch (error) {
        if (!tx.isFinished) {
          try {
            await tx.rollback();
          } catch {
            // Preserve the original error; ignore a rollback failure.
          }
        }
        throw error;
      } finally {
        await connection.setAutoCommit(true);
      }
    });
  }

  /** List every schema visible to the connected user. */
  async listSchemas(): Promise<readonly string[]> {
    return await this.pool.withConnection((connection) => listSchemas(connection));
  }

  /** List the tables in a schema. */
  async listTables(schema: string): Promise<readonly TableInfo[]> {
    return await this.pool.withConnection((connection) => listTables(connection, schema));
  }

  /** List the columns of a table. */
  async listColumns(schema: string, table: string): Promise<readonly ColumnInfo[]> {
    return await this.pool.withConnection((connection) =>
      listColumns(connection, schema, table),
    );
  }

  /** Return the HANA execution plan for a statement. */
  async explain(sql: string, params?: readonly SqlParam[]): Promise<QueryResult> {
    return await this.pool.withConnection(async (connection) => {
      const statementName = `cf_hana_${String(Date.now())}`;
      await connection.execute(
        `EXPLAIN PLAN SET STATEMENT_NAME = '${statementName}' FOR ${sql}`,
        params,
      );
      try {
        return await connection.query(
          "SELECT OPERATOR_NAME, TABLE_NAME, TABLE_TYPE, EXECUTION_ENGINE " +
            "FROM EXPLAIN_PLAN_TABLE WHERE STATEMENT_NAME = ? ORDER BY OPERATOR_ID",
          [statementName],
        );
      } finally {
        await connection.execute(
          "DELETE FROM EXPLAIN_PLAN_TABLE WHERE STATEMENT_NAME = ?",
          [statementName],
        );
      }
    });
  }

  /** Close every pooled connection. The client must not be used afterwards. */
  async close(): Promise<void> {
    await this.pool.drain();
  }
}
