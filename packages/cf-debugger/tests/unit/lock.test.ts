import { chmod, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../../src/lock.js";

describe("withFileLock", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-lock-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serialises concurrent critical sections", async () => {
    const lockPath = join(tempDir, "a.lock");
    const events: string[] = [];

    const first = withFileLock(lockPath, async (): Promise<void> => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push("a:end");
    });

    const second = withFileLock(lockPath, async (): Promise<void> => {
      events.push("b:start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push("b:end");
    });

    await Promise.all([first, second]);

    expect(events).toHaveLength(4);
    const validOrderings = [
      ["a:start", "a:end", "b:start", "b:end"],
      ["b:start", "b:end", "a:start", "a:end"],
    ];
    expect(validOrderings).toContainEqual(events);
  });

  it("creates a private lock and hardens legacy parent permissions", async () => {
    const lockPath = join(tempDir, "private.lock");
    await chmod(tempDir, 0o755);

    await withFileLock(lockPath, async (): Promise<void> => {
      expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("releases the lock on error so later work proceeds", async () => {
    const lockPath = join(tempDir, "b.lock");

    await expect(
      withFileLock(lockPath, async (): Promise<void> => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const ran = await withFileLock(lockPath, async (): Promise<number> => {
      return 42;
    });
    expect(ran).toBe(42);
  });

  it("times out when the lock remains held", async () => {
    const lockPath = join(tempDir, "c.lock");
    let releaseLock: () => void = () => undefined;
    let holding: Promise<void> | undefined;
    const entered = new Promise<void>((resolve) => {
      const held = new Promise<void>((release) => {
        releaseLock = release;
      });
      holding = withFileLock(lockPath, async (): Promise<void> => {
        resolve();
        await held;
      });
    });

    await entered;
    await expect(
      withFileLock(
        lockPath,
        async (): Promise<number> => 1,
        { timeoutMs: 50, pollMs: 5 },
      ),
    ).rejects.toThrow(/Timed out acquiring file lock/);

    releaseLock();
    await holding;
    const recovered = await withFileLock(lockPath, async (): Promise<number> => 2);
    expect(recovered).toBe(2);
  });

  it("recovers a lock owned by a dead process on this host", async () => {
    const lockPath = join(tempDir, "dead-owner.lock");
    await writeFile(lockPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: 2_147_483_647,
      token: "dead-owner",
      version: "1",
    }), "utf8");

    await expect(withFileLock(lockPath, async (): Promise<string> => "recovered", {
      pollMs: 5,
      timeoutMs: 100,
    })).resolves.toBe("recovered");
  });

  it("recovers when a prior stale-lock recovery owner died", async () => {
    const lockPath = join(tempDir, "dead-recovery-owner.lock");
    const deadOwner = {
      hostname: hostname(),
      pid: 2_147_483_647,
      version: "1",
    } as const;
    await writeFile(lockPath, JSON.stringify({ ...deadOwner, token: "dead-owner" }), "utf8");
    await writeFile(
      `${lockPath}.recovery`,
      JSON.stringify({ ...deadOwner, token: "dead-recovery-owner" }),
      "utf8",
    );

    await expect(withFileLock(lockPath, async (): Promise<string> => "recovered", {
      pollMs: 5,
      timeoutMs: 100,
    })).resolves.toBe("recovered");
  });

  it("recovers an old legacy lock without owner metadata", async () => {
    const lockPath = join(tempDir, "legacy.lock");
    await writeFile(lockPath, "", "utf8");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    await expect(withFileLock(lockPath, async (): Promise<string> => "recovered", {
      pollMs: 5,
      staleMs: 10,
      timeoutMs: 100,
    })).resolves.toBe("recovered");
  });

  it("does not reclaim an old lock owned by another host", async () => {
    const lockPath = join(tempDir, "remote-owner.lock");
    await writeFile(lockPath, JSON.stringify({
      hostname: "another-host",
      pid: 999_999,
      token: "remote-owner",
      version: "1",
    }), "utf8");
    await chmod(lockPath, 0o644);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    await expect(withFileLock(lockPath, async (): Promise<void> => undefined, {
      pollMs: 5,
      staleMs: 10,
      timeoutMs: 30,
    })).rejects.toThrow(/Timed out acquiring file lock/);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });
});
