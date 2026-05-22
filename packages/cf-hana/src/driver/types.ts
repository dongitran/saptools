import type { QueryResultColumn, SqlParam } from "../types.js";

export interface DriverExecResult {
  readonly rows: readonly Record<string, SqlParam>[];
  readonly columns: readonly QueryResultColumn[];
  /** Rows affected by a DML statement; 0 for SELECT and DDL. */
  readonly affectedRows: number;
}

export interface DriverConnectParams {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly certificate: string;
  readonly connectTimeoutMs: number;
}

/** A live, single HANA connection. Implementations wrap a concrete driver. */
export interface DriverConnection {
  exec(sql: string, params: readonly SqlParam[]): Promise<DriverExecResult>;
  setAutoCommit(enabled: boolean): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

/** A pluggable HANA driver — the seam that isolates the database library. */
export interface HanaDriver {
  readonly name: string;
  connect(params: DriverConnectParams): Promise<DriverConnection>;
}
