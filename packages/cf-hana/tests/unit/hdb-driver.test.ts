import { afterEach, describe, expect, it, vi } from "vitest";

import type { DriverConnectParams, DriverConnection } from "../../src/driver/types.js";

interface MockColumnMetadata {
  readonly columnName: string;
  readonly dataType: number;
  readonly length: number;
  readonly fraction: number;
}

interface MockStatement {
  readonly functionCode: number;
  readonly resultSetMetadata: readonly MockColumnMetadata[];
  exec(
    values: readonly unknown[],
    callback: (error: Error | null, result: unknown) => void,
  ): void;
  drop(callback?: (error?: Error | null) => void): void;
}

interface MockClient {
  readyState: string;
  connect(callback: (error: Error | null) => void): MockClient;
  prepare(sql: string, callback: (error: Error | null, statement: MockStatement) => void): MockClient;
  exec(sql: string, callback: (error: Error | null, result: unknown) => void): MockClient;
  setAutoCommit(autoCommit: boolean): void;
  commit(callback: (error: Error | null) => void): void;
  rollback(callback: (error: Error | null) => void): void;
  disconnect(callback: (error: Error | null) => void): MockClient;
  close(): void;
}

interface HdbMockState {
  readonly clients: MockClient[];
  dropError: Error | undefined;
  schemaError: Error | undefined;
  closeCount: number;
  disconnectCount: number;
  autoCommit: boolean;
}

const connectParams: DriverConnectParams = {
  host: "hana.example.internal",
  port: 443,
  user: "DB_USER",
  password: "db-password",
  schema: "APP_SCHEMA",
  certificate: "test-certificate",
  connectTimeoutMs: 30_000,
};

function createMockClient(state: HdbMockState): MockClient {
  const statement: MockStatement = {
    functionCode: 0,
    resultSetMetadata: [{ columnName: "ID", dataType: 3, length: 10, fraction: 0 }],
    exec: (_values, callback): void => {
      callback(null, [{ ID: 1 }]);
    },
    drop: (): void => {
      if (state.dropError !== undefined) {
        throw state.dropError;
      }
    },
  };

  const client: MockClient = {
    readyState: "new",
    connect(callback): MockClient {
      client.readyState = "connected";
      callback(null);
      return client;
    },
    prepare(_sql, callback): MockClient {
      callback(null, statement);
      return client;
    },
    exec(sql, callback): MockClient {
      if (sql.startsWith("SET SCHEMA") && state.schemaError !== undefined) {
        callback(state.schemaError, []);
        return client;
      }
      callback(null, []);
      return client;
    },
    setAutoCommit(autoCommit): void {
      state.autoCommit = autoCommit;
    },
    commit: (callback): void => {
      callback(null);
    },
    rollback: (callback): void => {
      callback(null);
    },
    disconnect(callback): MockClient {
      state.disconnectCount += 1;
      client.readyState = "disconnected";
      callback(null);
      return client;
    },
    close(): void {
      state.closeCount += 1;
      client.readyState = "closed";
    },
  };
  return client;
}

async function openMockConnection(state: HdbMockState): Promise<DriverConnection> {
  vi.resetModules();
  vi.doMock("hdb", () => ({
    createClient: (): MockClient => {
      const client = createMockClient(state);
      state.clients.push(client);
      return client;
    },
  }));
  const { createHdbDriver } = await import("../../src/driver/hdb.js");
  return await createHdbDriver().connect(connectParams);
}

afterEach(() => {
  vi.doUnmock("hdb");
  vi.resetModules();
});

describe("hdb driver", () => {
  it("preserves a successful query result when statement cleanup fails", async () => {
    const state: HdbMockState = {
      clients: [],
      dropError: new Error("drop failed"),
      schemaError: undefined,
      closeCount: 0,
      disconnectCount: 0,
      autoCommit: true,
    };
    const connection = await openMockConnection(state);

    await expect(connection.exec("SELECT ID FROM T", [])).resolves.toMatchObject({
      rows: [{ ID: 1 }],
    });
  });

  it("closes an opened client when schema setup fails", async () => {
    const state: HdbMockState = {
      clients: [],
      dropError: undefined,
      schemaError: Object.assign(new Error("schema failed"), { code: 260 }),
      closeCount: 0,
      disconnectCount: 0,
      autoCommit: true,
    };

    const failure = openMockConnection(state);
    await expect(failure).rejects.toThrow("schema failed");
    await expect(failure).rejects.toMatchObject({ databaseCode: 260 });
    expect(state.disconnectCount).toBe(1);
    expect(state.closeCount).toBe(1);
  });
});
