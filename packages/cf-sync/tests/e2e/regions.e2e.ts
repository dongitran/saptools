import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { getAllRegions } from "../../src/regions.js";
import type { CfStructure, RuntimeSyncState } from "../../src/types.js";

import {
  CLI_PATH,
  FAKE_CF_BIN,
  type Scenario,
  createEnv,
  prepareCase,
  readJsonLines,
  runJsonCommand,
  waitForExit,
  waitForRuntimeState,
  writeJson,
} from "./helpers.js";

const ROOT_NAME = "cf-sync-regions-e2e";
const CATALOG_REGIONS = getAllRegions();
const SCALE_OUT_REGION_FIXTURES = [
  {
    key: "eu10-002",
    apiEndpoint: "https://api.cf.eu10-002.hana.ondemand.com",
  },
  {
    key: "eu10-003",
    apiEndpoint: "https://api.cf.eu10-003.hana.ondemand.com",
  },
  {
    key: "eu10-004",
    apiEndpoint: "https://api.cf.eu10-004.hana.ondemand.com",
  },
  {
    key: "eu10-005",
    apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
  },
  {
    key: "eu20-001",
    apiEndpoint: "https://api.cf.eu20-001.hana.ondemand.com",
  },
  {
    key: "eu20-002",
    apiEndpoint: "https://api.cf.eu20-002.hana.ondemand.com",
  },
  {
    key: "us10-001",
    apiEndpoint: "https://api.cf.us10-001.hana.ondemand.com",
  },
  {
    key: "us10-002",
    apiEndpoint: "https://api.cf.us10-002.hana.ondemand.com",
  },
] as const;

interface RegionsViewPayload {
  readonly source: "catalog" | "stable";
  readonly regions: readonly {
    readonly key: string;
    readonly label: string;
    readonly apiEndpoint: string;
  }[];
  readonly metadata?: {
    readonly status: "running" | "completed" | "failed";
    readonly completedRegionKeys?: readonly string[];
    readonly pendingRegionKeys?: readonly string[];
  };
}

function createRunningScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgsDelayMs: 150,
        orgs: [{ name: "org-ap10", spaces: [{ name: "dev", apps: ["app-ap10"] }] }],
      },
      {
        key: "ap11",
        apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
        orgsDelayMs: 1800,
        orgs: [{ name: "org-ap11", spaces: [{ name: "dev", apps: ["app-ap11"] }] }],
      },
      {
        key: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgs: [{ name: "org-eu10", spaces: [{ name: "dev", apps: ["app-eu10"] }] }],
      },
    ],
  };
}

function createMixedRegionsScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [{ name: "org-ap10", spaces: [{ name: "dev", apps: ["app-ap10"] }] }],
      },
      {
        key: "ap11",
        apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
        orgs: [],
      },
      {
        key: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        accessible: false,
        orgs: [],
      },
    ],
  };
}

function createScaleOutScenario(): Scenario {
  return {
    regions: SCALE_OUT_REGION_FIXTURES.map((region) => ({
      key: region.key,
      apiEndpoint: region.apiEndpoint,
      orgs: [
        {
          name: `org-${region.key}`,
          spaces: [{ name: "dev", apps: [`app-${region.key}`] }],
        },
      ],
    })),
  };
}

function regionKeys(view: RegionsViewPayload): readonly string[] {
  return view.regions.map((region) => region.key);
}

test.describe("Regions command", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake CF fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("returns the full SAP catalog on fresh install", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-fresh-install", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);

    expect(view).toEqual({
      source: "catalog",
      regions: CATALOG_REGIONS,
    });
    expect(existsSync(paths.runtimeStatePath)).toBe(false);
    expect(existsSync(paths.structurePath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("User can see scale-out sub-regions in parent catalog order", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-fresh-install-scale-out", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    const keys = regionKeys(view);

    expect(keys.slice(keys.indexOf("eu10"), keys.indexOf("eu10") + 5)).toEqual([
      "eu10",
      "eu10-002",
      "eu10-003",
      "eu10-004",
      "eu10-005",
    ]);
    expect(keys.slice(keys.indexOf("eu20"), keys.indexOf("eu20") + 3)).toEqual([
      "eu20",
      "eu20-001",
      "eu20-002",
    ]);
    expect(keys.slice(keys.indexOf("us10"), keys.indexOf("us10") + 3)).toEqual([
      "us10",
      "us10-001",
      "us10-002",
    ]);
  });

  test("User can sync every scale-out sub-region from the catalog", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-scale-out-sync", createScaleOutScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);
    const keys = SCALE_OUT_REGION_FIXTURES.map((region) => region.key);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", keys.join(",")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    expect(view).toMatchObject({
      source: "stable",
      metadata: {
        status: "completed",
        completedRegionKeys: keys,
        pendingRegionKeys: [],
      },
    });
    expect(regionKeys(view)).toEqual(keys);

    const fakeLog = await readJsonLines(paths.logPath);
    const apiEndpoints = fakeLog
      .filter((entry) => entry.command === "api")
      .map((entry) => entry.args?.[0]);
    expect(apiEndpoints).toEqual(SCALE_OUT_REGION_FIXTURES.map((region) => region.apiEndpoint));
  });

  test("returns the full SAP catalog while sync is still running", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-running-catalog", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState<RuntimeSyncState>(
      paths.runtimeStatePath,
      (state) => state.completedRegionKeys.includes("ap10") && !state.completedRegionKeys.includes("ap11"),
    );

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    expect(view).toMatchObject({
      source: "catalog",
      metadata: {
        status: "running",
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["ap11", "eu10"],
      },
    });
    expect(regionKeys(view)).toEqual(CATALOG_REGIONS.map((region) => region.key));

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");
  });

  test("returns only stable regions that contain orgs after sync completes", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-after-sync", createMixedRegionsScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    expect(view).toMatchObject({
      source: "stable",
      metadata: {
        status: "completed",
        completedRegionKeys: ["ap10", "ap11", "eu10"],
        pendingRegionKeys: [],
      },
    });
    expect(regionKeys(view)).toEqual(["ap10"]);
  });

  test("returns the catalog during a running sync even when an older stable snapshot exists", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-running-over-stable", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const oldStableStructure: CfStructure = {
      syncedAt: "2026-04-17T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "old-stable",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "org-ap10", spaces: [] }],
        },
      ],
    };
    await writeJson(paths.structurePath, oldStableStructure);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState<RuntimeSyncState>(
      paths.runtimeStatePath,
      (state) => state.completedRegionKeys.includes("ap10") && !state.completedRegionKeys.includes("ap11"),
    );

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    expect(view).toMatchObject({
      source: "catalog",
      metadata: {
        status: "running",
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["ap11", "eu10"],
      },
    });
    expect(regionKeys(view)).toEqual(CATALOG_REGIONS.map((region) => region.key));

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");
  });

  test("falls back to the stable with-org list when runtime metadata is failed", async () => {
    const paths = await prepareCase(ROOT_NAME, "regions-failed-runtime", createMixedRegionsScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await writeJson(paths.structurePath, {
      syncedAt: "2026-04-17T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "stable",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "org-ap10", spaces: [] }],
        },
        {
          key: "ap11",
          label: "stable-empty",
          apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
          accessible: true,
          orgs: [],
        },
      ],
    } satisfies CfStructure);

    await writeJson(paths.runtimeStatePath, {
      syncId: "failed-sync",
      status: "failed",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:05.000Z",
      finishedAt: "2026-04-18T00:00:05.000Z",
      error: "sync blew up",
      requestedRegionKeys: ["ap10", "ap11"],
      completedRegionKeys: ["ap10"],
      structure: {
        syncedAt: "2026-04-18T00:00:05.000Z",
        regions: [],
      },
    } satisfies RuntimeSyncState);

    const view = await runJsonCommand<RegionsViewPayload>(env, ["regions"]);
    expect(view).toMatchObject({
      source: "stable",
      metadata: {
        status: "failed",
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["ap11"],
      },
    });
    expect(regionKeys(view)).toEqual(["ap10"]);
  });
});
