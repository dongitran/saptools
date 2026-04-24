import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { hostname as getHostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppDbSnapshot, CfDbSnapshot, RuntimeDbSyncState } from "../../src/types.js";

let tempHome: string;

async function findDeadPid(): Promise<number> {
  const zombie = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => {
    zombie.once("close", () => {
      resolve();
    });
  });

  const pid = zombie.pid;
  if (pid === undefined) {
    throw new Error("Failed to capture zombie PID");
  }

  try {
    process.kill(pid, 0);
    throw new Error(`PID ${pid.toString()} is unexpectedly still alive`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return pid;
    }
    throw error;
  }
}

function createEntry(overrides: Partial<AppDbSnapshot> = {}): AppDbSnapshot {
  return {
    selector: "ap10/org-alpha/dev/orders-srv",
    regionKey: "ap10",
    orgName: "org-alpha",
    spaceName: "dev",
    appName: "orders-srv",
    syncedAt: "2026-04-24T00:00:02.000Z",
    bindings: [],
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-db-store-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof NodeOs>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

describe("db-store", () => {
  it("returns an empty DB sync history when the file does not exist", async () => {
    const { readDbSyncHistory } = await import("../../src/db-store.js");
    await expect(readDbSyncHistory()).resolves.toEqual([]);
  });

  it("appends DB sync history entries with process metadata", async () => {
    const { appendDbSyncHistory, readDbSyncHistory } = await import("../../src/db-store.js");

    await appendDbSyncHistory({
      syncId: "db-sync-history",
      event: "db_sync_requested",
      requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
    });

    await expect(readDbSyncHistory()).resolves.toEqual([
      expect.objectContaining({
        syncId: "db-sync-history",
        event: "db_sync_requested",
        requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
        pid: expect.any(Number),
        hostname: expect.any(String),
        at: expect.any(String),
      }),
    ]);
  });

  it("returns undefined when no DB snapshot exists", async () => {
    const { readDbSnapshotView } = await import("../../src/db-store.js");
    await expect(readDbSnapshotView()).resolves.toBeUndefined();
  });

  it("writes and reads a stable DB snapshot", async () => {
    const snapshot: CfDbSnapshot = {
      version: 1,
      syncedAt: "2026-04-24T00:00:02.000Z",
      entries: [createEntry()],
    };

    const { readDbSnapshot, writeDbSnapshot } = await import("../../src/db-store.js");
    await writeDbSnapshot(snapshot);
    await expect(readDbSnapshot()).resolves.toEqual(snapshot);
  });

  it("prefers runtime DB state while a DB sync is running", async () => {
    const { cfDbRuntimeStatePath } = await import("../../src/paths.js");
    const { readDbSnapshotView, writeDbSnapshot } = await import("../../src/db-store.js");

    await writeDbSnapshot({
      version: 1,
      syncedAt: "2026-04-24T00:00:01.000Z",
      entries: [createEntry({ selector: "eu10/org-beta/prod/billing-srv", appName: "billing-srv" })],
    });

    const runtimeState: RuntimeDbSyncState = {
      syncId: "db-sync-1",
      status: "running",
      startedAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:02.000Z",
      requestedTargets: [
        "ap10/org-alpha/dev/orders-srv",
        "eu10/org-beta/prod/billing-srv",
      ],
      completedTargets: ["ap10/org-alpha/dev/orders-srv"],
      snapshot: {
        version: 1,
        syncedAt: "2026-04-24T00:00:02.000Z",
        entries: [createEntry()],
      },
    };

    await mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true });
    await writeFile(cfDbRuntimeStatePath(), `${JSON.stringify(runtimeState, null, 2)}\n`, "utf8");

    await expect(readDbSnapshotView()).resolves.toEqual({
      source: "runtime",
      snapshot: runtimeState.snapshot,
      metadata: {
        syncId: "db-sync-1",
        status: "running",
        startedAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:02.000Z",
        requestedTargets: [
          "ap10/org-alpha/dev/orders-srv",
          "eu10/org-beta/prod/billing-srv",
        ],
        completedTargets: ["ap10/org-alpha/dev/orders-srv"],
        pendingTargets: ["eu10/org-beta/prod/billing-srv"],
      },
    });
  });

  it("returns one app view from runtime state when available", async () => {
    const { cfDbRuntimeStatePath } = await import("../../src/paths.js");
    const { readDbAppView } = await import("../../src/db-store.js");

    const runtimeState: RuntimeDbSyncState = {
      syncId: "db-sync-2",
      status: "completed",
      startedAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:03.000Z",
      finishedAt: "2026-04-24T00:00:03.000Z",
      requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
      completedTargets: ["ap10/org-alpha/dev/orders-srv"],
      snapshot: {
        version: 1,
        syncedAt: "2026-04-24T00:00:03.000Z",
        entries: [createEntry()],
      },
    };

    await mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true });
    await writeFile(cfDbRuntimeStatePath(), `${JSON.stringify(runtimeState, null, 2)}\n`, "utf8");

    await expect(readDbAppView("ap10/org-alpha/dev/orders-srv")).resolves.toEqual({
      source: "runtime",
      entry: createEntry(),
      metadata: {
        syncId: "db-sync-2",
        status: "completed",
        startedAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:03.000Z",
        finishedAt: "2026-04-24T00:00:03.000Z",
        requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
        completedTargets: ["ap10/org-alpha/dev/orders-srv"],
        pendingTargets: [],
      },
    });
  });

  it("rejects ambiguous plain app names from the cached DB snapshot", async () => {
    const { readDbAppView, writeDbSnapshot } = await import("../../src/db-store.js");

    await writeDbSnapshot({
      version: 1,
      syncedAt: "2026-04-24T00:00:03.000Z",
      entries: [
        createEntry(),
        createEntry({
          selector: "eu10/org-beta/prod/orders-srv",
          regionKey: "eu10",
          orgName: "org-beta",
          spaceName: "prod",
        }),
      ],
    });

    await expect(readDbAppView("orders-srv")).rejects.toThrow(/ambiguous/);
  });

  it("recovers a stale DB sync lock left by a dead process", async () => {
    const deadPid = await findDeadPid();
    const { cfDbRuntimeStatePath, cfDbSyncLockPath } = await import("../../src/paths.js");
    const {
      readDbRuntimeState,
      readDbSyncHistory,
      releaseDbSyncLock,
      tryAcquireDbSyncLock,
    } = await import("../../src/db-store.js");

    await mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfDbRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "stale-db-sync",
          status: "running",
          startedAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z",
          requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
          completedTargets: [],
          snapshot: {
            version: 1,
            syncedAt: "2026-04-24T00:00:00.000Z",
            entries: [],
          },
        } satisfies RuntimeDbSyncState,
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      cfDbSyncLockPath(),
      `${JSON.stringify({
        syncId: "stale-db-sync",
        pid: deadPid,
        hostname: getHostname(),
        startedAt: "2026-04-24T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const handle = await tryAcquireDbSyncLock("fresh-db-sync");
    expect(handle).toBeDefined();
    await expect(readDbRuntimeState()).resolves.toMatchObject({
      syncId: "stale-db-sync",
      status: "failed",
    });
    await expect(readDbSyncHistory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "db_sync_lock_recovered",
          lockSyncId: "stale-db-sync",
          reason: "dead-pid",
        }),
      ]),
    );

    if (handle) {
      await releaseDbSyncLock(handle);
    }
  });

  it("does not take over a DB sync lock that still belongs to the current live process", async () => {
    const { cfDbSyncLockPath } = await import("../../src/paths.js");
    const { tryAcquireDbSyncLock } = await import("../../src/db-store.js");

    await mkdir(dirname(cfDbSyncLockPath()), { recursive: true });
    await writeFile(
      cfDbSyncLockPath(),
      `${JSON.stringify({
        syncId: "live-db-sync",
        pid: process.pid,
        hostname: getHostname(),
        startedAt: "2026-04-24T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(tryAcquireDbSyncLock("contender-db-sync")).resolves.toBeUndefined();
  });

  it("recovers a legacy DB sync lock when the running runtime state is stale", async () => {
    const { cfDbRuntimeStatePath, cfDbSyncLockPath } = await import("../../src/paths.js");
    const {
      readDbRuntimeState,
      readDbSyncHistory,
      releaseDbSyncLock,
      tryAcquireDbSyncLock,
    } = await import("../../src/db-store.js");

    await mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfDbRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "legacy-db-sync",
          status: "running",
          startedAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z",
          requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
          completedTargets: [],
          snapshot: {
            version: 1,
            syncedAt: "2026-04-24T00:00:00.000Z",
            entries: [],
          },
        } satisfies RuntimeDbSyncState,
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      cfDbSyncLockPath(),
      `${JSON.stringify({
        syncId: "legacy-db-sync",
        startedAt: "2026-04-24T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const handle = await tryAcquireDbSyncLock("fresh-legacy-db-sync");
    expect(handle).toBeDefined();
    await expect(readDbRuntimeState()).resolves.toMatchObject({
      syncId: "legacy-db-sync",
      status: "failed",
    });
    await expect(readDbSyncHistory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "db_sync_lock_recovered",
          lockSyncId: "legacy-db-sync",
          reason: "legacy-format-stale-runtime",
        }),
      ]),
    );

    if (handle) {
      await releaseDbSyncLock(handle);
    }
  });

  it("waits for DB runtime state to settle", async () => {
    const { cfDbRuntimeStatePath } = await import("../../src/paths.js");
    const { waitForDbRuntimeStateToSettle } = await import("../../src/db-store.js");

    setTimeout(() => {
      void mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true }).then(async () => {
        await writeFile(
          cfDbRuntimeStatePath(),
          `${JSON.stringify(
            {
              syncId: "db-sync-completed",
              status: "completed",
              startedAt: "2026-04-24T00:00:00.000Z",
              updatedAt: "2026-04-24T00:00:03.000Z",
              finishedAt: "2026-04-24T00:00:03.000Z",
              requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
              completedTargets: ["ap10/org-alpha/dev/orders-srv"],
              snapshot: {
                version: 1,
                syncedAt: "2026-04-24T00:00:03.000Z",
                entries: [createEntry()],
              },
            } satisfies RuntimeDbSyncState,
            null,
            2,
          )}\n`,
          "utf8",
        );
      });
    }, 50);

    await expect(waitForDbRuntimeStateToSettle()).resolves.toMatchObject({
      status: "completed",
      completedTargets: ["ap10/org-alpha/dev/orders-srv"],
    });
  });
});
