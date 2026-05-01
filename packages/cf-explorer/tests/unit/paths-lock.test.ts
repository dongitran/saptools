import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../../src/session/lock.js";
import {
  cfHomesDir,
  explorerHome,
  sessionCfHomeDir,
  sessionSocketPath,
  sessionsFilePath,
  sessionsLockPath,
  socketsDir,
  tmpRunDir,
  tmpRunsDir,
} from "../../src/session/paths.js";

describe("paths and file locks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `cf-explorer-paths-${process.pid.toString()}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps package-owned paths under the explorer home", () => {
    expect(explorerHome({ CF_EXPLORER_HOME: dir })).toBe(dir);
    expect(sessionsFilePath(dir)).toBe(join(dir, "sessions.json"));
    expect(sessionsLockPath(dir)).toBe(join(dir, "sessions.lock"));
    expect(socketsDir(dir)).toBe(join(dir, "sockets"));
    expect(sessionSocketPath("abc", dir)).toContain("abc");
    expect(cfHomesDir(dir)).toBe(join(dir, "cf-homes"));
    expect(sessionCfHomeDir("abc", dir)).toBe(join(dir, "cf-homes", "abc"));
    expect(tmpRunsDir(dir)).toBe(join(dir, "tmp"));
    expect(tmpRunDir("run", dir)).toBe(join(dir, "tmp", "run"));
  });

  it("runs work while holding and releasing a file lock", async () => {
    const lockPath = join(dir, "state.lock");
    const result = await withFileLock(lockPath, async () => "ok");
    expect(result).toBe("ok");
    await expect(withFileLock(lockPath, async () => "again")).resolves.toBe("again");
  });

  it("times out when a lock cannot be acquired", async () => {
    const lockPath = join(dir, "busy.lock");
    await withFileLock(lockPath, async () => {
      await expect(withFileLock(lockPath, async () => "never", { timeoutMs: 5, pollMs: 1 }))
        .rejects.toThrow(/Timed out/);
    });
  });
});
