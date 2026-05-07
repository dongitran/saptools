import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "../../src/lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
  tempDirs.length = 0;
});

describe("withFileLock", () => {
  it("creates the lock directory automatically and runs the work", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cf-logs-lock-"));
    tempDirs.push(tempDir);
    const lockPath = join(tempDir, "nested", "state.lock");

    const result = await withFileLock(lockPath, async () => "done");

    expect(result).toBe("done");
  });

  it("waits for an existing lock file to disappear before running the work", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cf-logs-lock-"));
    tempDirs.push(tempDir);
    const lockDir = join(tempDir, "nested");
    const lockPath = join(lockDir, "state.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, "busy", "utf8");
    setTimeout(() => {
      void unlink(lockPath).catch(() => undefined);
    }, 100);

    const result = await withFileLock(lockPath, async () => "after-wait");

    expect(result).toBe("after-wait");
  });
});
