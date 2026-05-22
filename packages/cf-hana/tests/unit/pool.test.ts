import { describe, expect, it } from "vitest";

import type { ConnectionConfig } from "../../src/connection.js";
import { ConnectionPool } from "../../src/pool.js";
import type { PoolOptions } from "../../src/types.js";

import { FakeHanaDriver } from "./fixtures/fake-driver.js";
import { sampleConnectionConfig } from "./fixtures/samples.js";

function makePool(overrides?: Partial<ConnectionConfig>, poolOptions?: PoolOptions) {
  const driver = new FakeHanaDriver(() => ({}));
  const pool = new ConnectionPool(driver, sampleConnectionConfig(overrides), poolOptions);
  return { driver, pool };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe("ConnectionPool", () => {
  it("opens a connection on acquire and reuses it after release", async () => {
    const { driver, pool } = makePool();
    const first = await pool.acquire();
    pool.release(first);
    const second = await pool.acquire();
    expect(second).toBe(first);
    expect(driver.connectCount).toBe(1);
    expect(pool.size).toBe(1);
  });

  it("caps connections at max and queues further acquires", async () => {
    const { pool } = makePool(undefined, { max: 1 });
    const first = await pool.acquire();
    const pending = pool.acquire();
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    pool.release(first);
    const second = await pending;
    expect(second).toBe(first);
  });

  it("releases the connection even when withConnection work throws", async () => {
    const { pool } = makePool();
    await expect(
      pool.withConnection(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(pool.available).toBe(1);
  });

  it("drains queued waiters and rejects them", async () => {
    const { pool } = makePool(undefined, { max: 1 });
    await pool.acquire();
    const waiting = pool.acquire();
    await pool.drain();
    await expect(waiting).rejects.toThrow(/drained/);
  });

  it("rejects acquire after the pool is draining", async () => {
    const { pool } = makePool();
    await pool.drain();
    await expect(pool.acquire()).rejects.toThrow(/draining/);
  });

  it("discards a connection that was closed while it was busy", async () => {
    const { driver, pool } = makePool();
    const connection = await pool.acquire();
    driver.connections[0]?.markClosed();
    pool.release(connection);
    expect(pool.size).toBe(0);
  });

  it("serves a queued waiter after a closed connection is released", async () => {
    const { driver, pool } = makePool(undefined, { max: 1 });
    const first = await pool.acquire();
    const pending = pool.acquire();
    driver.connections[0]?.markClosed();
    pool.release(first);
    const second = await pending;
    expect(second).not.toBe(first);
    expect(driver.connectCount).toBe(2);
  });

  it("decrements the connection count when opening a connection fails", async () => {
    const { driver, pool } = makePool();
    driver.connectError = new Error("connect failed");
    await expect(pool.acquire()).rejects.toThrow("connect failed");
    expect(pool.size).toBe(0);
  });

  it("retires idle connections past the idle timeout", async () => {
    const { driver, pool } = makePool(undefined, { idleTimeoutMs: 10 });
    const first = await pool.acquire();
    pool.release(first);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await pool.acquire();
    expect(second).not.toBe(first);
    expect(driver.connectCount).toBe(2);
  });
});
