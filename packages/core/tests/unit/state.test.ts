import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireUpdateLock,
  clearFailure,
  EMPTY_UPDATE_STATE,
  readUpdateState,
  updateLockPath,
  updateStateFileName,
  updateStatePath,
  writeUpdateState,
} from "../../src/self-update/state.js";
import type { UpdateState } from "../../src/self-update/state.js";

const NOW = new Date("2026-09-02T10:00:00.000Z");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "core-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("paths", () => {
  it("derives one state file per package under <root>/updates and a sibling lock", () => {
    expect(updateStateFileName("@saptools/cf-metrics")).toBe("saptools__cf-metrics.json");
    expect(updateStateFileName("plain")).toBe("plain.json");
    const statePath = updateStatePath("/tmp/.saptools", "@saptools/cf-metrics");
    expect(statePath).toBe("/tmp/.saptools/updates/saptools__cf-metrics.json");
    expect(updateLockPath(statePath)).toBe("/tmp/.saptools/updates/saptools__cf-metrics.lock");
  });
});

describe("readUpdateState / writeUpdateState", () => {
  it("round-trips every field and writes a private file inside a private directory", async () => {
    const statePath = updateStatePath(root, "@saptools/cf-metrics");
    const state: UpdateState = {
      version: 1,
      checkedAt: "2026-09-02T09:00:00.000Z",
      latest: "0.7.0",
      lastFailureAt: "2026-09-02T08:00:00.000Z",
      lastFailureReason: "HTTP 503",
      notifiedVersion: "0.7.0",
      notifiedAt: "2026-09-02T09:00:01.000Z",
      lastInstall: { version: "0.7.0", at: "2026-09-02T09:00:02.000Z", ok: false, reason: "exit 1" },
    };
    writeUpdateState(statePath, state);
    expect(readUpdateState(statePath)).toEqual(state);
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "updates"))).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(statePath, "utf8")).toContain('"version": 1');
  });

  it("reads a missing, malformed, or foreign file as empty state", async () => {
    const statePath = updateStatePath(root, "@saptools/x");
    expect(readUpdateState(statePath)).toEqual(EMPTY_UPDATE_STATE);
    writeUpdateState(statePath, EMPTY_UPDATE_STATE);
    await writeFile(statePath, "{not json");
    expect(readUpdateState(statePath)).toEqual(EMPTY_UPDATE_STATE);
    await writeFile(statePath, JSON.stringify({ version: 2, latest: "9.9.9" }));
    expect(readUpdateState(statePath)).toEqual(EMPTY_UPDATE_STATE);
  });

  it("drops fields of the wrong type and a half-formed install record", async () => {
    const statePath = updateStatePath(root, "@saptools/x");
    writeUpdateState(statePath, EMPTY_UPDATE_STATE);
    await writeFile(statePath, JSON.stringify({ version: 1, latest: 7, checkedAt: "", notifiedAt: "t", lastInstall: { version: "1.0.0", ok: "yes" } }));
    expect(readUpdateState(statePath)).toEqual({ version: 1, notifiedAt: "t" });
    await writeFile(statePath, JSON.stringify({ version: 1, lastInstall: { version: "1.0.0", at: "t", ok: true } }));
    expect(readUpdateState(statePath)).toEqual({ version: 1, lastInstall: { version: "1.0.0", at: "t", ok: true } });
  });

  it("clearFailure removes only the failure fields", () => {
    expect(clearFailure({ version: 1, latest: "1.0.0", lastFailureAt: "t", lastFailureReason: "r" })).toEqual({ version: 1, latest: "1.0.0" });
  });
});

describe("acquireUpdateLock", () => {
  it("grants the lock once, refuses a second taker, and frees it on release", () => {
    const lockPath = join(root, "updates", "x.lock");
    const first = acquireUpdateLock(lockPath, NOW);
    expect(first).toBeDefined();
    expect(acquireUpdateLock(lockPath, NOW)).toBeUndefined();
    first?.release();
    const again = acquireUpdateLock(lockPath, NOW);
    expect(again).toBeDefined();
    again?.release();
  });

  it("takes over a lock older than the stale threshold", async () => {
    const lockPath = join(root, "updates", "x.lock");
    const stuck = acquireUpdateLock(lockPath, NOW);
    expect(stuck).toBeDefined();
    const old = new Date(NOW.getTime() - 60 * 60_000);
    await utimes(lockPath, old, old);
    const taken = acquireUpdateLock(lockPath, NOW, 10 * 60_000);
    expect(taken).toBeDefined();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid, at: NOW.toISOString() });
    taken?.release();
  });

  it("release tolerates a lock that is already gone", () => {
    const lockPath = join(root, "updates", "x.lock");
    const lock = acquireUpdateLock(lockPath, NOW);
    lock?.release();
    expect(() => {
      lock?.release();
    }).not.toThrow();
  });
});
