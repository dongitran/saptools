import type {
  DriverConnectParams,
  DriverConnection,
  DriverExecResult,
  HanaDriver,
} from "../../../src/driver/types.js";
import type { QueryResultColumn, SqlParam } from "../../../src/types.js";

export interface FakeExecCall {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export interface FakeResponse {
  readonly rows?: readonly Record<string, SqlParam>[];
  readonly columns?: readonly QueryResultColumn[];
  readonly affectedRows?: number;
  readonly error?: Error;
  readonly delayMs?: number;
}

export type FakeResponder = (sql: string, params: readonly SqlParam[]) => FakeResponse;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A scriptable {@link DriverConnection} for unit tests. */
export class FakeHanaConnection implements DriverConnection {
  readonly execCalls: FakeExecCall[] = [];
  autoCommit = true;
  commitCount = 0;
  rollbackCount = 0;
  private closed = false;

  constructor(private readonly responder: FakeResponder) {}

  async exec(sql: string, params: readonly SqlParam[]): Promise<DriverExecResult> {
    this.execCalls.push({ sql, params });
    const response = this.responder(sql, params);
    if (response.delayMs !== undefined) {
      await wait(response.delayMs);
    }
    if (response.error !== undefined) {
      throw response.error;
    }
    return {
      rows: response.rows ?? [],
      columns: response.columns ?? [],
      affectedRows: response.affectedRows ?? 0,
    };
  }

  setAutoCommit(enabled: boolean): Promise<void> {
    this.autoCommit = enabled;
    return Promise.resolve();
  }

  commit(): Promise<void> {
    this.commitCount += 1;
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.rollbackCount += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Force the connection into a closed state without an async round trip. */
  markClosed(): void {
    this.closed = true;
  }
}

/** A scriptable {@link HanaDriver} for unit tests. */
export class FakeHanaDriver implements HanaDriver {
  readonly name = "fake";
  readonly connections: FakeHanaConnection[] = [];
  connectCount = 0;
  connectError: Error | undefined = undefined;

  constructor(private readonly responder: FakeResponder = () => ({})) {}

  connect(_params: DriverConnectParams): Promise<DriverConnection> {
    this.connectCount += 1;
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    const connection = new FakeHanaConnection(this.responder);
    this.connections.push(connection);
    return Promise.resolve(connection);
  }
}
