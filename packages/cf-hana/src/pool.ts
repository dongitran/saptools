import { DEFAULT_POOL_IDLE_MS, DEFAULT_POOL_MAX } from "./config.js";
import { Connection } from "./connection.js";
import type { ConnectionConfig } from "./connection.js";
import type { HanaDriver } from "./driver/types.js";
import { CfHanaError } from "./errors.js";
import type { PoolOptions } from "./types.js";

interface IdleEntry {
  readonly connection: Connection;
  readonly since: number;
}

interface Waiter {
  readonly resolve: (connection: Connection) => void;
  readonly reject: (error: unknown) => void;
}

async function closeQuietly(connection: Connection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Best-effort close.
  }
}

/**
 * A process-local, in-memory pool of HANA connections. It holds no shared disk
 * state, so multiple pools (in this or other processes) are fully independent.
 */
export class ConnectionPool {
  private readonly idle: IdleEntry[] = [];
  private readonly busy = new Set<Connection>();
  private readonly waiters: Waiter[] = [];
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private created = 0;
  private draining = false;

  constructor(
    private readonly driver: HanaDriver,
    private readonly config: ConnectionConfig,
    options?: PoolOptions,
  ) {
    this.maxSize = Math.max(1, options?.max ?? DEFAULT_POOL_MAX);
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_POOL_IDLE_MS;
  }

  /** Total connections currently owned by the pool (idle + busy). */
  get size(): number {
    return this.created;
  }

  /** Connections currently idle and immediately reusable. */
  get available(): number {
    return this.idle.length;
  }

  /** Borrow a connection, opening or queueing as needed. */
  async acquire(): Promise<Connection> {
    if (this.draining) {
      throw new CfHanaError("POOL_CLOSED", "Connection pool is draining");
    }

    const reused = this.takeIdleConnection();
    if (reused !== undefined) {
      this.busy.add(reused);
      return reused;
    }

    if (this.created < this.maxSize) {
      return await this.openBusyConnection();
    }

    return await new Promise<Connection>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Return a borrowed connection to the pool. */
  release(connection: Connection): void {
    if (!this.busy.delete(connection)) {
      return;
    }

    if (connection.isClosed) {
      this.created -= 1;
      this.servePendingWaiters();
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      this.busy.add(connection);
      waiter.resolve(connection);
      return;
    }

    if (this.draining) {
      this.created -= 1;
      void closeQuietly(connection);
      return;
    }

    this.idle.push({ connection, since: Date.now() });
  }

  /** Run `work` with a borrowed connection, releasing it afterwards. */
  async withConnection<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await work(connection);
    } finally {
      this.release(connection);
    }
  }

  /** Reject queued waiters and close idle connections. */
  async drain(): Promise<void> {
    this.draining = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.reject(new CfHanaError("POOL_CLOSED", "Connection pool was drained"));
      }
    }

    const idleConnections = this.idle.splice(0).map((entry) => entry.connection);
    this.created -= idleConnections.length;
    await Promise.all(idleConnections.map((connection) => closeQuietly(connection)));
  }

  private takeIdleConnection(): Connection | undefined {
    for (;;) {
      const entry = this.idle.pop();
      if (entry === undefined) {
        return undefined;
      }
      if (entry.connection.isClosed) {
        this.created -= 1;
        continue;
      }
      if (this.idleTimeoutMs > 0 && Date.now() - entry.since > this.idleTimeoutMs) {
        this.created -= 1;
        void closeQuietly(entry.connection);
        continue;
      }
      return entry.connection;
    }
  }

  private async openBusyConnection(): Promise<Connection> {
    this.created += 1;
    let connection: Connection;
    try {
      connection = await Connection.open(this.driver, this.config);
    } catch (error) {
      this.created -= 1;
      throw error;
    }
    this.busy.add(connection);
    return connection;
  }

  private servePendingWaiters(): void {
    while (this.waiters.length > 0 && this.created < this.maxSize) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        return;
      }
      this.created += 1;
      void Connection.open(this.driver, this.config).then(
        (connection) => {
          this.busy.add(connection);
          waiter.resolve(connection);
        },
        (error: unknown) => {
          this.created -= 1;
          waiter.reject(error);
        },
      );
    }
  }
}
