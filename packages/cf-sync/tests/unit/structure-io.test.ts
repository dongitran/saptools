import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CfStructure, RuntimeSyncState } from "../../src/types.js";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-test-"));
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

describe("structure file I/O", () => {
  it("returns undefined when file does not exist", async () => {
    const { readStructure } = await import("../../src/structure.js");
    expect(await readStructure()).toBeUndefined();
  });

  it("returns undefined when no package-managed snapshots exist", async () => {
    const { readStructureView, readRegionView } = await import("../../src/structure.js");
    await expect(readStructureView()).resolves.toBeUndefined();
    await expect(readRegionView("ap10")).resolves.toBeUndefined();
  });

  it("writes and reads back a structure", async () => {
    const { readStructure, writeStructure } = await import("../../src/structure.js");
    const fixture: CfStructure = {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "test",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "o", spaces: [{ name: "s", apps: [{ name: "a" }] }] }],
        },
      ],
    };
    await writeStructure(fixture);
    const readBack = await readStructure();
    expect(readBack).toEqual(fixture);
  });

  it("creates parent directory when missing", async () => {
    const { writeStructure } = await import("../../src/structure.js");
    const fixture: CfStructure = { syncedAt: "2026-04-18T00:00:00.000Z", regions: [] };
    await writeStructure(fixture);
    const { cfStructurePath } = await import("../../src/paths.js");
    expect(cfStructurePath().startsWith(tempHome)).toBe(true);
  });

  it("reads runtime state when present", async () => {
    const fixture: RuntimeSyncState = {
      syncId: "sync-1",
      status: "running",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:01.000Z",
      requestedRegionKeys: ["ap10", "eu10"],
      completedRegionKeys: ["ap10"],
      structure: {
        syncedAt: "2026-04-18T00:00:01.000Z",
        regions: [
          {
            key: "ap10",
            label: "test",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            accessible: true,
            orgs: [],
          },
        ],
      },
    };

    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(cfRuntimeStatePath(), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const { readRuntimeState } = await import("../../src/structure.js");
    await expect(readRuntimeState()).resolves.toEqual(fixture);
  });

  it("prefers runtime structure view over stable structure while sync is running", async () => {
    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    const { writeStructure, readStructureView } = await import("../../src/structure.js");

    const stableFixture: CfStructure = {
      syncedAt: "2026-04-17T00:00:00.000Z",
      regions: [
        {
          key: "eu10",
          label: "stable",
          apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
          accessible: true,
          orgs: [],
        },
      ],
    };
    await writeStructure(stableFixture);

    const runtimeFixture: RuntimeSyncState = {
      syncId: "sync-2",
      status: "running",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:02.000Z",
      requestedRegionKeys: ["ap10", "eu10"],
      completedRegionKeys: ["ap10"],
      structure: {
        syncedAt: "2026-04-18T00:00:02.000Z",
        regions: [
          {
            key: "ap10",
            label: "runtime",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            accessible: true,
            orgs: [],
          },
        ],
      },
    };
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(cfRuntimeStatePath(), `${JSON.stringify(runtimeFixture, null, 2)}\n`, "utf8");

    await expect(readStructureView()).resolves.toEqual({
      source: "runtime",
      structure: runtimeFixture.structure,
      metadata: {
        syncId: "sync-2",
        status: "running",
        startedAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:02.000Z",
        requestedRegionKeys: ["ap10", "eu10"],
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["eu10"],
      },
    });
  });

  it("reads a region from runtime state before falling back to the stable snapshot", async () => {
    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    const { writeStructure, readRegionView } = await import("../../src/structure.js");

    await writeStructure({
      syncedAt: "2026-04-17T00:00:00.000Z",
      regions: [
        {
          key: "eu10",
          label: "stable",
          apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
          accessible: true,
          orgs: [],
        },
      ],
    });

    const runtimeFixture: RuntimeSyncState = {
      syncId: "sync-3",
      status: "running",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:03.000Z",
      requestedRegionKeys: ["ap10", "eu10"],
      completedRegionKeys: ["ap10"],
      structure: {
        syncedAt: "2026-04-18T00:00:03.000Z",
        regions: [
          {
            key: "ap10",
            label: "runtime",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            accessible: true,
            orgs: [],
          },
        ],
      },
    };
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(cfRuntimeStatePath(), `${JSON.stringify(runtimeFixture, null, 2)}\n`, "utf8");

    await expect(readRegionView("ap10")).resolves.toEqual({
      source: "runtime",
      region: runtimeFixture.structure.regions[0],
      metadata: {
        syncId: "sync-3",
        status: "running",
        startedAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:03.000Z",
        requestedRegionKeys: ["ap10", "eu10"],
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["eu10"],
      },
    });

    await expect(readRegionView("eu10")).resolves.toEqual({
      source: "stable",
      region: {
        key: "eu10",
        label: "stable",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        accessible: true,
        orgs: [],
      },
      metadata: {
        syncId: "sync-3",
        status: "running",
        startedAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:03.000Z",
        requestedRegionKeys: ["ap10", "eu10"],
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["eu10"],
      },
    });
  });

  it("includes finished metadata for failed runtime state views", async () => {
    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    const { readStructureView } = await import("../../src/structure.js");

    const runtimeFixture: RuntimeSyncState = {
      syncId: "sync-failed",
      status: "failed",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:05.000Z",
      finishedAt: "2026-04-18T00:00:05.000Z",
      error: "sync blew up",
      requestedRegionKeys: ["ap10", "eu10"],
      completedRegionKeys: ["ap10"],
      structure: {
        syncedAt: "2026-04-18T00:00:05.000Z",
        regions: [
          {
            key: "ap10",
            label: "runtime",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            accessible: true,
            orgs: [],
          },
        ],
      },
    };

    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(cfRuntimeStatePath(), `${JSON.stringify(runtimeFixture, null, 2)}\n`, "utf8");

    await expect(readStructureView()).resolves.toEqual({
      source: "runtime",
      structure: runtimeFixture.structure,
      metadata: {
        syncId: "sync-failed",
        status: "failed",
        startedAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:05.000Z",
        finishedAt: "2026-04-18T00:00:05.000Z",
        error: "sync blew up",
        requestedRegionKeys: ["ap10", "eu10"],
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["eu10"],
      },
    });
  });
});
