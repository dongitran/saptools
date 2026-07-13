import { buildWriteBackupPlan, writeSqlBackup } from "./backup.js";
import type { SqlBackupRecord } from "./backup.js";
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate } from "./builder.js";
import { listCatalogObjects, listColumns, listSchemas, listTables } from "./catalog.js";
import {
  DEFAULT_AUTO_LIMIT,
  CLI_VERSION,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "./config.js";
import type { ConnectionConfig } from "./connection.js";
import { resolveAppBindings, selectBinding, toConnectionTarget } from "./credentials.js";
import { createDriver } from "./driver/index.js";
import { appendSqlHistory } from "./history.js";
import type { SqlHistoryOperation } from "./history.js";
import type { CatalogObjectInfo } from "./metadata-cache.js";
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

let explainStatementCounter = 0;

function nextExplainStatementName(): string {
  explainStatementCounter = (explainStatementCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `cf_hana_${String(process.pid)}_${String(Date.now())}_${String(explainStatementCounter)}`;
}

/**
 * The high-level entry point: a pooled, reusable client for the HANA database
 * bound to a single Cloud Foundry app.
 */
export class HanaClient {
  constructor(
    private readonly pool: ConnectionPool,
    readonly info: HanaClientInfo,
    readonly databaseUser = "",
  ) {}

  /** Open a client for a `region/org/space/app` selector (or a bare app name). */
  static async connect(selector: string, options: ConnectOptions = {}): Promise<HanaClient> {
    const resolved = await resolveAppBindings(selector, options);
    const role: DbUserRole = options.role ?? "runtime";
    const binding = selectBinding(resolved.bindings, options);
    const bindingIndex = resolved.bindings.indexOf(binding);
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
      selectorSource: resolved.selectorSource,
      regionConfirmed: resolved.regionConfirmed,
      selectorCanBePinned: resolved.selectorCanBePinned,
      ...(binding.name === undefined ? {} : { bindingName: binding.name }),
      bindingIndex,
      availableBindingNames: resolved.bindings.flatMap((candidate) =>
        candidate.name === undefined ? [] : [candidate.name],
      ),
    };
    return new HanaClient(new ConnectionPool(driver, config, poolOptions), info, target.user);
  }

  /** Run a SELECT (or any read) statement and return typed rows. */
  async query<TRow = QueryRow>(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    const resolvedParams = params ?? [];
    const result = await this.runQuery<TRow>(sql, resolvedParams, options);
    await this.recordSqlHistory("query", sql, resolvedParams, result);
    return result;
  }

  /** Run a DML/DDL statement and return its affected-row count. */
  async execute(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const resolvedParams = params ?? [];
    const result = await this.runExecute(sql, resolvedParams, options);
    await this.recordSqlHistory("execute", sql, resolvedParams, result);
    return result;
  }

  /** Back up pre-image rows required by a supported write before the caller runs it. */
  async backupWriteStatement(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<SqlBackupRecord | undefined> {
    const resolvedParams = params ?? [];
    const plan = buildWriteBackupPlan(sql, resolvedParams);
    if (plan === undefined) {
      return undefined;
    }

    return await this.pool.withConnection(async (connection) => {
      connection.assertAllowed(plan.statementSql, options);
      const backupQueryOptions: QueryOptions = {
        autoLimit: false,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };
      const result = await connection.query(plan.selectSql, plan.selectParams, backupQueryOptions);
      return await writeSqlBackup({
        operation: plan.operation,
        statementSql: plan.statementSql,
        result,
        selector: this.info.selector,
      });
    });
  }

  /** Run a typed `SELECT` built from a spec. */
  async selectFrom<TRow = QueryRow>(spec: SelectSpec): Promise<QueryResult<TRow>> {
    const built = buildSelect(spec);
    return await this.runQuery<TRow>(built.sql, built.params);
  }

  /** Count rows in a table, optionally filtered. */
  async count(spec: Pick<SelectSpec, "schema" | "table" | "where">): Promise<number> {
    const built = buildCount(spec);
    const result = await this.runQuery<{ COUNT: number }>(built.sql, built.params);
    return result.rows[0]?.COUNT ?? 0;
  }

  /** Insert a single row. */
  async insertInto(
    schema: string,
    table: string,
    values: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildInsert(schema, table, values);
    return await this.runExecute(built.sql, built.params);
  }

  /** Update rows matching a non-empty `where` filter. */
  async update(
    schema: string,
    table: string,
    values: Readonly<Record<string, SqlParam>>,
    where: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildUpdate(schema, table, values, where);
    return await this.runExecute(built.sql, built.params);
  }

  /** Delete rows matching a non-empty `where` filter. */
  async deleteFrom(
    schema: string,
    table: string,
    where: Readonly<Record<string, SqlParam>>,
  ): Promise<QueryResult> {
    const built = buildDelete(schema, table, where);
    return await this.runExecute(built.sql, built.params);
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

  /** List table and view names in a schema for typo suggestions. */
  async listCatalogObjects(schema: string): Promise<readonly CatalogObjectInfo[]> {
    return await this.pool.withConnection((connection) => listCatalogObjects(connection, schema));
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
      connection.assertAllowed(sql);
      const statementName = nextExplainStatementName();
      await connection.executeInternal(
        `EXPLAIN PLAN SET STATEMENT_NAME = '${statementName}' FOR ${sql}`,
        params,
      );
      const cleanup = async (): Promise<void> => {
        await connection.executeInternal(
          "DELETE FROM EXPLAIN_PLAN_TABLE WHERE STATEMENT_NAME = ?",
          [statementName],
        );
      };
      let queryCompleted = false;
      try {
        const result = await connection.query(
          "SELECT OPERATOR_NAME, TABLE_NAME, TABLE_TYPE, EXECUTION_ENGINE " +
            "FROM EXPLAIN_PLAN_TABLE WHERE STATEMENT_NAME = ? ORDER BY OPERATOR_ID",
          [statementName],
        );
        queryCompleted = true;
        await cleanup();
        return result;
      } catch (error) {
        if (!queryCompleted) {
          try {
            await cleanup();
          } catch {
            // Preserve the original explain-plan read error.
          }
        }
        throw error;
      }
    });
  }

  /** Close every pooled connection. The client must not be used afterwards. */
  async close(): Promise<void> {
    await this.pool.drain();
  }

  private async runQuery<TRow = QueryRow>(
    sql: string,
    params: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    return await this.pool.withConnection((connection) =>
      connection.query<TRow>(sql, params, options),
    );
  }

  private async runExecute(
    sql: string,
    params: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    return await this.pool.withConnection((connection) =>
      connection.execute(sql, params, options),
    );
  }

  private async recordSqlHistory<TRow>(
    operation: SqlHistoryOperation,
    sql: string,
    params: readonly SqlParam[],
    result: QueryResult<TRow>,
  ): Promise<void> {
    try {
      await appendSqlHistory({
        version: CLI_VERSION,
        operation,
        selector: this.info.selector,
        appName: this.info.appName,
        schema: this.info.schema,
        role: this.info.role,
        statement: result.statement,
        sql,
        paramCount: params.length,
        rowCount: result.rowCount,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
      });
    } catch {
      // History is diagnostic local state; never fail a successful SQL statement.
    }
  }
}
