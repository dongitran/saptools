import type { Connection } from "./connection.js";
import { CfHanaError } from "./errors.js";
import type { QueryOptions, QueryResult, QueryRow, SqlParam } from "./types.js";

/** A HANA transaction bound to one connection with autocommit disabled. */
export class Transaction {
  private finished = false;

  constructor(private readonly connection: Connection) {}

  /** Whether the transaction has already been committed or rolled back. */
  get isFinished(): boolean {
    return this.finished;
  }

  async query<TRow = QueryRow>(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult<TRow>> {
    this.assertActive();
    return await this.connection.query<TRow>(sql, params, options);
  }

  async execute(
    sql: string,
    params?: readonly SqlParam[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    this.assertActive();
    return await this.connection.execute(sql, params, options);
  }

  async commit(): Promise<void> {
    this.assertActive();
    this.finished = true;
    await this.connection.commit();
  }

  async rollback(): Promise<void> {
    this.assertActive();
    this.finished = true;
    await this.connection.rollback();
  }

  private assertActive(): void {
    if (this.finished) {
      throw new CfHanaError(
        "QUERY",
        "This transaction has already been committed or rolled back",
      );
    }
  }
}
