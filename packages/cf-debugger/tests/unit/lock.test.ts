import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
});
