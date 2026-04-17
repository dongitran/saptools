import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-sync-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof NodeOs>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function getCfHome(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return env?.["CF_HOME"];
}

describe("runSync", () => {
  it("walks region → org → space → app for each region", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue(["org-a"]),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfSpaces: vi.fn().mockResolvedValue(["dev"]),
      cfApps: vi.fn().mockResolvedValue(["app1", "app2"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    expect(result.accessibleRegions).toEqual(["ap10"]);
    expect(result.structure.regions).toHaveLength(1);
    const region = result.structure.regions[0]!;
    expect(region.orgs).toHaveLength(1);
    expect(region.orgs[0]!.spaces).toHaveLength(1);
    expect(region.orgs[0]!.spaces[0]!.apps.map((a) => a.name)).toEqual(["app1", "app2"]);
  });

  it("marks region as inaccessible when auth fails", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockRejectedValue(new Error("403")),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    expect(result.accessibleRegions).toEqual([]);
    expect(result.inaccessibleRegions).toEqual(["ap10"]);
    expect(result.structure.regions[0]!.accessible).toBe(false);
    expect(result.structure.regions[0]!.orgs).toHaveLength(0);
  });

  it("skips org when target fails, continues with next", async () => {
    const cfTargetOrg = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("no-access")))
      .mockResolvedValue(void 0);

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue(["bad-org", "good-org"]),
      cfTargetOrg,
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfSpaces: vi.fn().mockResolvedValue(["dev"]),
      cfApps: vi.fn().mockResolvedValue(["app1"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const region = result.structure.regions[0]!;
    expect(region.orgs.map((o) => o.name)).toEqual(["bad-org", "good-org"]);
    expect(region.orgs[0]!.spaces).toHaveLength(0);
    expect(region.orgs[1]!.spaces).toHaveLength(1);
  });

  it("skips space when target fails", async () => {
    const cfTargetSpace = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("no-space")))
      .mockResolvedValue(void 0);

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue(["org-a"]),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace,
      cfSpaces: vi.fn().mockResolvedValue(["bad-space", "good-space"]),
      cfApps: vi.fn().mockResolvedValue(["app"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const org = result.structure.regions[0]!.orgs[0]!;
    expect(org.spaces.map((s) => s.name)).toEqual(["bad-space", "good-space"]);
    expect(org.spaces[0]!.apps).toHaveLength(0);
    expect(org.spaces[1]!.apps).toHaveLength(1);
  });

  it("writes structure to configured path", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue([]),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    await (await import("../../src/sync.js")).runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const { readStructure } = await import("../../src/structure.js");
    const saved = await readStructure();
    expect(saved?.regions).toHaveLength(1);
  });

  it("records completed runtime state after a successful sync", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue([]),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { runSync } = await import("../../src/sync.js");
    await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const { readRuntimeState } = await import("../../src/structure.js");
    await expect(readRuntimeState()).resolves.toMatchObject({
      status: "completed",
      requestedRegionKeys: ["ap10"],
      completedRegionKeys: ["ap10"],
    });
  });

  it("uses an isolated CF_HOME for a sync session", async () => {
    const contexts: { readonly env?: NodeJS.ProcessEnv }[] = [];
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockImplementation((_endpoint: string, context?: { readonly env?: NodeJS.ProcessEnv }) => {
        contexts.push(context ?? {});
      }),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfOrgs: vi.fn().mockResolvedValue([]),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { runSync } = await import("../../src/sync.js");
    await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    expect(contexts).toHaveLength(1);
    expect(getCfHome(contexts[0]?.env)).toContain("saptools-cf-session-");
  });

  it("hydrates a missing region immediately and merges it into the running state", async () => {
    const cfApi = vi.fn().mockResolvedValue(void 0);
    const cfAuth = vi.fn().mockResolvedValue(void 0);
    const cfOrgs = vi.fn().mockResolvedValue(["org-eu10"]);
    const cfTargetOrg = vi.fn().mockResolvedValue(void 0);
    const cfTargetSpace = vi.fn().mockResolvedValue(void 0);
    const cfSpaces = vi.fn().mockResolvedValue(["dev"]);
    const cfApps = vi.fn().mockResolvedValue(["app-eu10"]);

    vi.doMock("../../src/cf.js", () => ({
      cfApi,
      cfAuth,
      cfOrgs,
      cfTargetOrg,
      cfTargetSpace,
      cfSpaces,
      cfApps,
    }));

    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "sync-running",
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
                label: "ap10",
                apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
                accessible: true,
                orgs: [],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { getRegionView } = await import("../../src/sync.js");
    const regionView = await getRegionView({
      regionKey: "eu10",
      email: "e",
      password: "p",
    });

    expect(regionView).toMatchObject({
      source: "fresh",
      region: {
        key: "eu10",
        accessible: true,
      },
    });
    expect(cfApi).toHaveBeenCalledTimes(1);
    expect(getCfHome(cfApi.mock.calls[0]?.[1]?.env)).toContain("saptools-cf-session-");

    const { readRuntimeState, readRegionView } = await import("../../src/structure.js");
    await expect(readRuntimeState()).resolves.toMatchObject({
      completedRegionKeys: ["ap10", "eu10"],
    });
    await expect(readRegionView("eu10")).resolves.toMatchObject({
      source: "runtime",
      region: {
        key: "eu10",
      },
    });
  });

  it("returns a cached stable region when refresh credentials are missing", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { writeStructure } = await import("../../src/structure.js");
    await writeStructure({
      syncedAt: "2026-04-18T00:00:00.000Z",
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

    const { getRegionView } = await import("../../src/sync.js");
    await expect(getRegionView({ regionKey: "eu10" })).resolves.toMatchObject({
      source: "stable",
      region: {
        key: "eu10",
      },
    });
  });

  it("returns an inaccessible fresh region when authentication fails and no cache exists", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockRejectedValue(new Error("boom")),
      cfAuth: vi.fn(),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { getRegionView } = await import("../../src/sync.js");
    await expect(
      getRegionView({
        regionKey: "eu10",
        email: "e",
        password: "p",
      }),
    ).resolves.toMatchObject({
      source: "fresh",
      region: {
        key: "eu10",
        accessible: false,
      },
    });
  });

  it("deduplicates concurrent full sync calls", async () => {
    const firstRegionGate = createDeferred();
    const cfApi = vi.fn().mockResolvedValue(void 0);
    const cfAuth = vi.fn().mockResolvedValue(void 0);
    const cfOrgs = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstRegionGate.promise;
        return [];
      });

    vi.doMock("../../src/cf.js", () => ({
      cfApi,
      cfAuth,
      cfOrgs,
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { runSync } = await import("../../src/sync.js");
    const firstSync = runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const { readRuntimeState } = await import("../../src/structure.js");
    for (;;) {
      const state = await readRuntimeState();
      if (state?.status === "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const secondSync = runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    firstRegionGate.resolve();

    const [firstResult, secondResult] = await Promise.all([firstSync, secondSync]);

    expect(cfOrgs).toHaveBeenCalledTimes(1);
    expect(secondResult.structure).toEqual(firstResult.structure);
  });

  it("reuses a completed runtime snapshot when another process already holds the sync lock", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { cfRuntimeStatePath, cfSyncLockPath } = await import("../../src/paths.js");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "external-sync",
          status: "completed",
          startedAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:02.000Z",
          finishedAt: "2026-04-18T00:00:02.000Z",
          requestedRegionKeys: ["ap10"],
          completedRegionKeys: ["ap10"],
          structure: {
            syncedAt: "2026-04-18T00:00:02.000Z",
            regions: [
              {
                key: "ap10",
                label: "ap10",
                apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
                accessible: true,
                orgs: [],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(cfSyncLockPath(), "locked\n", "utf8");

    const { runSync } = await import("../../src/sync.js");
    await expect(
      runSync({
        email: "e",
        password: "p",
        onlyRegions: ["ap10"],
      }),
    ).resolves.toMatchObject({
      structure: {
        regions: [{ key: "ap10" }],
      },
      accessibleRegions: ["ap10"],
    });
  });

  it("falls back to a cached region when on-demand hydration throws unexpectedly", async () => {
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual("node:fs/promises");
      return {
        ...actual,
        mkdtemp: vi.fn().mockRejectedValue(new Error("no temp dir")),
      };
    });

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { writeStructure } = await import("../../src/structure.js");
    await writeStructure({
      syncedAt: "2026-04-18T00:00:00.000Z",
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

    const { getRegionView } = await import("../../src/sync.js");
    await expect(
      getRegionView({
        regionKey: "eu10",
        email: "e",
        password: "p",
      }),
    ).resolves.toMatchObject({
      source: "stable",
      region: {
        key: "eu10",
      },
    });
  });

  it("waits for a lock-held sync even when interactive output is enabled", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { cfRuntimeStatePath, cfSyncLockPath } = await import("../../src/paths.js");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "interactive-lock",
          status: "completed",
          startedAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:02.000Z",
          finishedAt: "2026-04-18T00:00:02.000Z",
          requestedRegionKeys: ["ap10"],
          completedRegionKeys: ["ap10"],
          structure: {
            syncedAt: "2026-04-18T00:00:02.000Z",
            regions: [
              {
                key: "ap10",
                label: "ap10",
                apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
                accessible: true,
                orgs: [],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(cfSyncLockPath(), "locked\n", "utf8");

    const { runSync } = await import("../../src/sync.js");
    await expect(
      runSync({
        email: "e",
        password: "p",
        interactive: true,
        onlyRegions: ["ap10"],
      }),
    ).resolves.toMatchObject({
      accessibleRegions: ["ap10"],
    });
  });
});
