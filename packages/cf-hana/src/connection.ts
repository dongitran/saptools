import type { DriverConnection, HanaDriver } from "./driver/types.js";
import { CfHanaError, DestructiveStatementError, ReadOnlyViolationError } from "./errors.js";
import { applyAutoLimit, evaluateGuard } from "./safety.js";
import { assertParamArity, classifyStatement } from "./statements.js";
import type { QueryOptions, QueryResult, QueryRow, SqlParam } from "./types.js";

export interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly certificate: string;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly readOnly: boolean;
  readonly allowDestructive: boolean;
  readonly autoLimit: number | false;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(
        new CfHanaError("TIMEOUT", `Statement timed out after ${String(timeoutMs)}ms`),
      );
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** A single HANA connection: applies the safety guard, auto-limit, and timeouts. */
export class Connection {
  private constructor(
    private readonly driverConnection: DriverConnection,
    private readonly config: ConnectionConfig,
  ) {}

  static async open(driver: HanaDriver, config: ConnectionConfig): Promise<Connection> {
    const driverConnection = await driver.connect({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      schema: config.schema,
      certificate: config.certificate,
      connectTimeoutMs: config.connectTimeoutMs,
    });
    return new Connection(driverConnection, config);
  }

  async query<TRow = QueryRow>(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    const result = await this.run(sql, params ?? [], options ?? {});
    // The driver returns untyped rows; the caller asserts the row shape via TRow.
    return result as unknown as QueryResult<TRow>;
  }

  async execute(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    return await this.run(sql, params ?? [], options ?? {});
  }

  async setAutoCommit(enabled: boolean): Promise<void> {
    await this.driverConnection.setAutoCommit(enabled);
  }

  async commit(): Promise<void> {
    await this.driverConnection.commit();
  }

  async rollback(): Promise<void> {
    await this.driverConnection.rollback();
  }

  async close(): Promise<void> {
    await this.driverConnection.close();
  }

  get isClosed(): boolean {
    return this.driverConnection.isClosed();
  }

  private async run(
    sql: string,
    params: readonly SqlParam[],
    options: QueryOptions,
  ): Promise<QueryResult> {
    assertParamArity(sql, params);

    const decision = evaluateGuard(sql, {
      readOnly: this.config.readOnly,
      allowDestructive: options.allowDestructive ?? this.config.allowDestructive,
    });
    if (!decision.allowed) {
      if (decision.violation === "read-only") {
        throw new ReadOnlyViolationError(
          decision.reason ?? "read-only mode blocks this statement",
        );
      }
      throw new DestructiveStatementError(
        decision.reason ?? "destructive statement blocked",
      );
    }

    const kind = classifyStatement(sql);
    const autoLimit = options.autoLimit ?? this.config.autoLimit;
    const limited =
      kind === "select" ? applyAutoLimit(sql, autoLimit) : { sql, applied: false };
    const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs;

    const started = Date.now();
    const execResult = await withTimeout(
      this.driverConnection.exec(limited.sql, params),
      timeoutMs,
      () => {
        void this.closeQuietly();
      },
    );
    const elapsedMs = Date.now() - started;

    return {
      rows: execResult.rows,
      columns: execResult.columns,
      rowCount: kind === "select" ? execResult.rows.length : execResult.affectedRows,
      statement: kind,
      truncated: limited.applied && execResult.rows.length === autoLimit,
      elapsedMs,
    };
  }

  private async closeQuietly(): Promise<void> {
    try {
      await this.driverConnection.close();
    } catch {
      // Best-effort close after a timeout; the connection is already unusable.
    }
  }
}
