import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { expect, test } from "@playwright/test";

import {
  CLI_PATH,
  FAKE_CF_BIN,
  type FakeLogEntry,
  type Scenario,
  createEnv,
  prepareCase,
  readJson,
  readJsonLines,
  readSyncHistory,
  runJsonCommand,
  waitForExit,
  waitForLogEntries,
  waitForRuntimeState,
  writeJson,
} from "./helpers.js";

const ROOT_NAME = "cf-sync-e2e";

function createScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgsDelayMs: 200,
        orgs: [
          {
            name: "org-ap10",
            spaces: [
              {
                name: "dev",
                apps: [
                  {
                    name: "app-ap10",
                    requestedState: "started",
                    processes: "web:1/1",
                    routes: ["app-ap10.cfapps.example.com"],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        key: "ap11",
        apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
        orgsDelayMs: 1800,
        orgs: [
          {
            name: "org-ap11",
            spaces: [{ name: "dev", apps: ["app-ap11"] }],
          },
        ],
      },
      {
        key: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgsDelayMs: 0,
        orgs: [
          {
            name: "org-eu10",
            spaces: [{ name: "dev", apps: ["app-eu10"] }],
          },
        ],
      },
    ],
  };
}

function createRegionMergeScenario(): Scenario {
  return {
    regions: [
      {
        key: "br10",
        apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
        orgs: [
          {
            name: "org-br",
            spaces: [{ name: "dev", apps: ["fresh-br-app"] }],
          },
        ],
      },
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "org-ap10",
            spaces: [{ name: "dev", apps: ["app-ap10"] }],
          },
        ],
      },
    ],
  };
}

function createLongScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgsDelayMs: 120,
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
        orgsDelayMs: 300,
        orgs: [{ name: "org-eu10", spaces: [{ name: "dev", apps: ["app-eu10"] }] }],
      },
      {
        key: "us10",
        apiEndpoint: "https://api.cf.us10.hana.ondemand.com",
        orgsDelayMs: 300,
        orgs: [{ name: "org-us10", spaces: [{ name: "dev", apps: ["app-us10"] }] }],
      },
      {
        key: "jp10",
        apiEndpoint: "https://api.cf.jp10.hana.ondemand.com",
        orgsDelayMs: 300,
        orgs: [{ name: "org-jp10", spaces: [{ name: "dev", apps: ["app-jp10"] }] }],
      },
      {
        key: "us20",
        apiEndpoint: "https://api.cf.us20.hana.ondemand.com",
        orgsDelayMs: 0,
        orgs: [{ name: "org-us20", spaces: [{ name: "dev", apps: ["app-us20"] }] }],
      },
    ],
  };
}

function createOrgRefreshScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "org-alpha",
            spaces: [
              { name: "dev", apps: ["fresh-dev-app"] },
              { name: "qa", apps: ["fresh-qa-app"] },
            ],
          },
          {
            name: "org-beta",
            spaces: [{ name: "dev", apps: ["keep-beta-live-app"] }],
          },
        ],
      },
    ],
  };
}

function createSpaceRaceScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgsDelayMs: 1800,
        orgs: [{ name: "org-ap10", spaces: [{ name: "dev", apps: ["app-ap10"] }] }],
      },
      {
        key: "ap11",
        apiEndpoint: "https://api.cf.ap11.hana.ondemand.com",
        orgsDelayMs: 0,
        orgs: [
          {
            name: "org-ap11",
            spaces: [
              { name: "dev", apps: ["app-ap11-dev"] },
              { name: "qa", apps: ["app-ap11-qa"] },
            ],
          },
        ],
      },
    ],
  };
}

function createInaccessibleScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        accessible: false,
        orgs: [],
      },
    ],
  };
}

function countEndpointCalls(entries: readonly FakeLogEntry[], apiEndpoint: string): number {
  return entries.filter(
    (entry) => entry.apiEndpoint === apiEndpoint || (entry.command === "api" && entry.args?.includes(apiEndpoint)),
  ).length;
}

test.describe("Runtime reads", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake CF fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("fresh install read commands return null before any package-managed snapshot exists", async () => {
    const paths = await prepareCase(ROOT_NAME, "fresh-install-reads", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await expect(runJsonCommand(env, ["read"])).resolves.toBeNull();
    await expect(runJsonCommand(env, ["region", "eu10", "--no-refresh"])).resolves.toBeNull();

    expect(existsSync(paths.runtimeStatePath)).toBe(false);
    expect(existsSync(paths.structurePath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("region command returns an inaccessible fresh region when authentication fails", async () => {
    const paths = await prepareCase(ROOT_NAME, "inaccessible-region", createInaccessibleScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const regionView = await runJsonCommand(env, ["region", "ap10"]);
    expect(regionView).toMatchObject({
      source: "fresh",
      region: {
        key: "ap10",
        accessible: false,
      },
    });

    const fakeLog = await readJsonLines(paths.logPath);
    expect(fakeLog.map((entry) => entry.command)).toEqual(["api", "auth"]);
  });

  test("fresh region fetch persists reusable package-managed data when no sync is running", async () => {
    const paths = await prepareCase(ROOT_NAME, "fresh-region-persistence", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const freshRegion = await runJsonCommand(env, ["region", "eu10"]);
    expect(freshRegion).toMatchObject({
      source: "fresh",
      region: {
        key: "eu10",
        accessible: true,
      },
    });

    const structureView = await runJsonCommand(env, ["read"]);
    expect(structureView).toMatchObject({
      source: "stable",
      structure: {
        regions: [{ key: "eu10", accessible: true }],
      },
    });

    const cachedRegion = await runJsonCommand(env, ["region", "eu10", "--no-refresh"]);
    expect(cachedRegion).toMatchObject({
      source: "stable",
      region: {
        key: "eu10",
        accessible: true,
      },
    });

    const regionsView = await runJsonCommand(env, ["regions"]);
    expect(regionsView).toMatchObject({
      source: "stable",
      regions: [{ key: "eu10" }],
    });

    expect(existsSync(paths.structurePath)).toBe(true);

    const fakeLog = await readJsonLines(paths.logPath);
    const eu10OrgsCalls = fakeLog.filter(
      (entry) =>
        entry.command === "orgs" &&
        entry.apiEndpoint === "https://api.cf.eu10.hana.ondemand.com",
    );
    expect(eu10OrgsCalls).toHaveLength(1);
  });

  test("sync command writes history milestones that can be used to trace progress", async () => {
    const paths = await prepareCase(ROOT_NAME, "sync-history", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const history = await readSyncHistory(paths.historyPath);
    const events = history.map((entry) => entry.event);

    expect(events).toEqual(
      expect.arrayContaining([
        "sync_requested",
        "sync_lock_acquired",
        "runtime_initialized",
        "region_started",
        "region_auth_started",
        "org_started",
        "space_started",
        "space_apps_loaded",
        "runtime_region_merged",
        "sync_completed",
        "sync_lock_released",
      ]),
    );

    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "space_apps_loaded",
          regionKey: "ap10",
          orgName: "org-ap10",
          spaceName: "dev",
          appCount: 1,
        }),
      ]),
    );
  });

  test("sync --only merges one selected region into an existing stable structure", async () => {
    const paths = await prepareCase(ROOT_NAME, "region-only-stable-merge", createRegionMergeScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await writeJson(paths.structurePath, {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "stable-ap",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "keep-ap", spaces: [{ name: "dev", apps: [{ name: "keep-ap-app" }] }] }],
        },
        {
          key: "br10",
          label: "old-br",
          apiEndpoint: "https://api.cf.br10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "old-br", spaces: [{ name: "dev", apps: [{ name: "old-br-app" }] }] }],
        },
        {
          key: "eu10",
          label: "stable-eu",
          apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "keep-eu", spaces: [] }],
        },
      ],
    });

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "br10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const stableStructure = await readJson<{
      readonly regions: readonly {
        readonly key: string;
        readonly orgs: readonly {
          readonly name: string;
          readonly spaces: readonly { readonly name: string; readonly apps: readonly { readonly name: string }[] }[];
        }[];
      }[];
    }>(paths.structurePath);
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "br10", "eu10"]);
    expect(stableStructure.regions.find((region) => region.key === "ap10")?.orgs[0]?.name).toBe("keep-ap");
    expect(stableStructure.regions.find((region) => region.key === "eu10")?.orgs[0]?.name).toBe("keep-eu");
    expect(stableStructure.regions.find((region) => region.key === "br10")?.orgs).toEqual([
      {
        name: "org-br",
        spaces: [
          {
            name: "dev",
            apps: [
              {
                name: "fresh-br-app",
                requestedState: "started",
                runningInstances: 1,
                totalInstances: 1,
                routes: [],
              },
            ],
          },
        ],
      },
    ]);

    const structureView = await runJsonCommand(env, ["read"]);
    expect(
      (structureView?.["structure"] as { readonly regions: readonly { readonly key: string }[] }).regions.map(
        (region) => region.key,
      ),
    ).toEqual(["ap10", "br10", "eu10"]);
  });

  test("fresh region fetch updates the package-managed view after a completed sync", async () => {
    const paths = await prepareCase(ROOT_NAME, "post-sync-region-persistence", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const freshRegion = await runJsonCommand(env, ["region", "eu10"]);
    expect(freshRegion).toMatchObject({
      source: "fresh",
      region: {
        key: "eu10",
        accessible: true,
      },
      metadata: {
        status: "completed",
      },
    });

    const structureView = await runJsonCommand(env, ["read"]);
    expect(structureView).toMatchObject({
      source: "runtime",
      metadata: {
        status: "completed",
      },
    });
    expect(
      (structureView?.["structure"] as { readonly regions: readonly { readonly key: string }[] }).regions.map(
        (region) => region.key,
      ),
    ).toEqual(["ap10", "ap11", "eu10"]);

    const cachedRegion = await runJsonCommand(env, ["region", "eu10", "--no-refresh"]);
    expect(cachedRegion).toMatchObject({
      source: "runtime",
      region: {
        key: "eu10",
        accessible: true,
      },
      metadata: {
        status: "completed",
      },
    });

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "ap11", "eu10"]);
  });

  test("space command refreshes one selected space and preserves sibling spaces", async () => {
    const paths = await prepareCase(ROOT_NAME, "space-refresh-preserves-siblings", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await writeJson(paths.structurePath, {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [
            {
              name: "org-ap10",
              spaces: [
                { name: "dev", apps: [{ name: "old-dev-app" }] },
                { name: "qa", apps: [{ name: "keep-qa-app" }] },
              ],
            },
          ],
        },
      ],
    });

    const spaceView = await runJsonCommand(env, ["space", "ap10", "org-ap10", "dev"]);
    expect(spaceView).toMatchObject({
      region: { key: "ap10" },
      org: { name: "org-ap10" },
      space: { name: "dev", apps: [{ name: "app-ap10" }] },
    });

    const stableStructure = await readJson<{
      readonly regions: readonly {
        readonly orgs: readonly {
          readonly spaces: readonly { readonly name: string; readonly apps: readonly { readonly name: string }[] }[];
        }[];
      }[];
    }>(paths.structurePath);
    const spaces = stableStructure.regions[0]?.orgs[0]?.spaces ?? [];
    expect(spaces.map((space) => [space.name, space.apps.map((app) => app.name)])).toEqual([
      ["dev", ["app-ap10"]],
      ["qa", ["keep-qa-app"]],
    ]);
    expect(spaces[0]?.apps[0]).toMatchObject({
      name: "app-ap10",
      requestedState: "started",
      runningInstances: 1,
      totalInstances: 1,
      routes: ["app-ap10.cfapps.example.com"],
    });

    const fakeLog = await readJsonLines(paths.logPath);
    expect(fakeLog.map((entry) => entry.command)).toEqual(["api", "auth", "target", "apps"]);
  });

  test("org command refreshes one selected org and preserves sibling topology", async () => {
    const paths = await prepareCase(ROOT_NAME, "org-refresh-preserves-siblings", createOrgRefreshScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await writeJson(paths.structurePath, {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [
            {
              name: "org-alpha",
              spaces: [{ name: "dev", apps: [{ name: "old-dev-app" }] }],
            },
            {
              name: "org-beta",
              spaces: [{ name: "dev", apps: [{ name: "keep-beta-app" }] }],
            },
          ],
        },
        {
          key: "eu10",
          label: "eu10",
          apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "org-eu", spaces: [] }],
        },
      ],
    });

    const orgView = await runJsonCommand(env, ["org", "ap10", "org-alpha"]);
    expect(orgView).toMatchObject({
      region: { key: "ap10" },
      org: {
        name: "org-alpha",
        spaces: [
          { name: "dev", apps: [{ name: "fresh-dev-app" }] },
          { name: "qa", apps: [{ name: "fresh-qa-app" }] },
        ],
      },
    });

    const stableStructure = await readJson<{
      readonly regions: readonly {
        readonly key: string;
        readonly orgs: readonly {
          readonly name: string;
          readonly spaces: readonly { readonly name: string; readonly apps: readonly { readonly name: string }[] }[];
        }[];
      }[];
    }>(paths.structurePath);
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "eu10"]);
    expect(stableStructure.regions.find((region) => region.key === "eu10")?.orgs[0]?.name).toBe("org-eu");
    expect(stableStructure.regions.find((region) => region.key === "ap10")?.orgs).toEqual([
      {
        name: "org-alpha",
        spaces: [
          {
            name: "dev",
            apps: [
              {
                name: "fresh-dev-app",
                requestedState: "started",
                runningInstances: 1,
                totalInstances: 1,
                routes: [],
              },
            ],
          },
          {
            name: "qa",
            apps: [
              {
                name: "fresh-qa-app",
                requestedState: "started",
                runningInstances: 1,
                totalInstances: 1,
                routes: [],
              },
            ],
          },
        ],
      },
      {
        name: "org-beta",
        spaces: [{ name: "dev", apps: [{ name: "keep-beta-app" }] }],
      },
    ]);

    const fakeLog = await readJsonLines(paths.logPath);
    expect(fakeLog.map((entry) => entry.command)).toEqual(["api", "auth", "target", "spaces", "target", "apps", "target", "apps"]);
  });

  test("org command leaves the stable structure unchanged when the selected org is unavailable", async () => {
    const paths = await prepareCase(ROOT_NAME, "org-refresh-target-failure", createOrgRefreshScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);
    const stableStructure = {
      syncedAt: "2026-04-18T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [{ name: "org-alpha", spaces: [{ name: "dev", apps: [{ name: "keep-app" }] }] }],
        },
      ],
    };
    await writeJson(paths.structurePath, stableStructure);

    const orgProcess = spawn("node", [CLI_PATH, "org", "ap10", "missing-org"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const orgResult = await waitForExit(orgProcess);
    expect(orgResult.code).toBe(1);
    expect(orgResult.stdout).toBe("");
    expect(orgResult.stderr).toContain("Failed to refresh org ap10/missing-org");

    await expect(readJson(paths.structurePath)).resolves.toEqual(stableStructure);
  });

  test("service can inspect partial structure while sync is still running", async () => {
    const paths = await prepareCase(ROOT_NAME, "partial-structure", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runtimeState = await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("ap10") && !completed.includes("ap11");
    });

    expect(runtimeState["status"]).toBe("running");

    const structureView = await runJsonCommand(env, ["read"]);
    expect(structureView).toMatchObject({
      source: "runtime",
      metadata: {
        status: "running",
        completedRegionKeys: ["ap10"],
        pendingRegionKeys: ["ap11", "eu10"],
      },
    });
    expect(
      (structureView?.["structure"] as { readonly regions: readonly { readonly key: string }[] }).regions.map(
        (region) => region.key,
      ),
    ).toEqual(["ap10"]);

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "ap11", "eu10"]);
  });

  test("service reads a completed runtime region without re-fetching it", async () => {
    const paths = await prepareCase(ROOT_NAME, "runtime-cache-hit", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("ap10") && !completed.includes("ap11");
    });

    const beforeLog = await readJsonLines(paths.logPath);
    const regionView = await runJsonCommand(env, ["region", "ap10"]);
    expect(regionView).toMatchObject({
      source: "runtime",
      region: {
        key: "ap10",
        accessible: true,
      },
    });

    const afterLog = await readJsonLines(paths.logPath);
    expect(countEndpointCalls(afterLog, "https://api.cf.ap10.hana.ondemand.com")).toBe(
      countEndpointCalls(beforeLog, "https://api.cf.ap10.hana.ondemand.com"),
    );
    expect(
      afterLog.filter(
        (entry) => entry.command === "orgs" && entry.apiEndpoint === "https://api.cf.ap10.hana.ondemand.com",
      ),
    ).toHaveLength(1);

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");
  });

  test("region --no-refresh remains cache-only while sync is still running", async () => {
    const paths = await prepareCase(ROOT_NAME, "cache-only-region-read", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("ap10") && !completed.includes("eu10");
    });

    const beforeLog = await readJsonLines(paths.logPath);
    await expect(runJsonCommand(env, ["region", "eu10", "--no-refresh"])).resolves.toBeNull();
    const afterLog = await readJsonLines(paths.logPath);
    expect(countEndpointCalls(afterLog, "https://api.cf.eu10.hana.ondemand.com")).toBe(
      countEndpointCalls(beforeLog, "https://api.cf.eu10.hana.ondemand.com"),
    );

    const runtimeState = await readJson<Record<string, unknown>>(paths.runtimeStatePath);
    expect(runtimeState["completedRegionKeys"]).toEqual(["ap10"]);

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");
  });

  test("service can hydrate a late region before the full sync reaches it", async () => {
    const paths = await prepareCase(ROOT_NAME, "late-region-hydration", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("ap10") && !completed.includes("eu10");
    });

    const regionView = await runJsonCommand(env, ["region", "eu10"]);
    expect(regionView).toMatchObject({
      source: "fresh",
      region: {
        key: "eu10",
        accessible: true,
      },
    });

    const mergedRuntimeState = await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("eu10");
    });
    expect(mergedRuntimeState["completedRegionKeys"]).toEqual(["ap10", "eu10"]);

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "ap11", "eu10"]);

    const fakeLog = await readJsonLines(paths.logPath);
    const eu10OrgsCalls = fakeLog.filter(
      (entry) =>
        entry.command === "orgs" &&
        entry.apiEndpoint === "https://api.cf.eu10.hana.ondemand.com",
    );
    expect(eu10OrgsCalls).toHaveLength(1);
  });

  test("space command does not make a running full sync skip that region", async () => {
    const paths = await prepareCase(ROOT_NAME, "space-refresh-during-full-sync", createSpaceRaceScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => value["status"] === "running");

    const spaceView = await runJsonCommand(env, ["space", "ap11", "org-ap11", "dev"]);
    expect(spaceView).toMatchObject({
      region: { key: "ap11" },
      space: { name: "dev", apps: [{ name: "app-ap11-dev" }] },
      metadata: {
        status: "running",
        completedRegionKeys: [],
      },
    });

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const stableStructure = await readJson<{
      readonly regions: readonly {
        readonly key: string;
        readonly orgs: readonly {
          readonly spaces: readonly { readonly name: string; readonly apps: readonly { readonly name: string }[] }[];
        }[];
      }[];
    }>(paths.structurePath);
    const ap11 = stableStructure.regions.find((region) => region.key === "ap11");
    const spaces = ap11?.orgs[0]?.spaces ?? [];
    expect(spaces.map((space) => [space.name, space.apps.map((app) => app.name)])).toEqual([
      ["dev", ["app-ap11-dev"]],
      ["qa", ["app-ap11-qa"]],
    ]);

    const fakeLog = await readJsonLines(paths.logPath);
    const ap11OrgCalls = fakeLog.filter(
      (entry) => entry.command === "orgs" && entry.apiEndpoint === "https://api.cf.ap11.hana.ondemand.com",
    );
    expect(ap11OrgCalls).toHaveLength(1);
  });

  test("service can hydrate the last region in a longer sync list right after sync starts", async () => {
    const paths = await prepareCase(ROOT_NAME, "late-last-region-hydration", createLongScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);
    const requestedRegions = ["ap10", "ap11", "eu10", "us10", "jp10", "us20"] as const;

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", requestedRegions.join(",")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("ap10") && !completed.includes("us20");
    });

    const regionView = await runJsonCommand(env, ["region", "us20"]);
    expect(regionView).toMatchObject({
      source: "fresh",
      region: {
        key: "us20",
        accessible: true,
      },
    });

    const mergedRuntimeState = await waitForRuntimeState(paths.runtimeStatePath, (value) => {
      const completed = value["completedRegionKeys"];
      return Array.isArray(completed) && completed.includes("us20") && !completed.includes("eu10");
    });
    expect(mergedRuntimeState["completedRegionKeys"]).toEqual(["ap10", "us20"]);

    const midSyncLog = await waitForLogEntries(
      paths.logPath,
      (entries) =>
        entries.some(
          (entry) => entry.command === "orgs" && entry.apiEndpoint === "https://api.cf.us20.hana.ondemand.com",
        ),
    );
    expect(
      midSyncLog.filter(
        (entry) => entry.command === "orgs" && entry.apiEndpoint === "https://api.cf.eu10.hana.ondemand.com",
      ),
    ).toHaveLength(0);

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect([...stableStructure.regions.map((region) => region.key)].sort()).toEqual([...requestedRegions].sort());

    const fakeLog = await readJsonLines(paths.logPath);
    const orgEndpoints = fakeLog
      .filter((entry) => entry.command === "orgs")
      .map((entry) => entry.apiEndpoint);
    expect(orgEndpoints.indexOf("https://api.cf.us20.hana.ondemand.com")).toBeGreaterThan(-1);
    expect(orgEndpoints.indexOf("https://api.cf.eu10.hana.ondemand.com")).toBeGreaterThan(-1);
    expect(orgEndpoints.indexOf("https://api.cf.us20.hana.ondemand.com")).toBeLessThan(
      orgEndpoints.indexOf("https://api.cf.eu10.hana.ondemand.com"),
    );
  });

  test("package deduplicates concurrent full sync commands", async () => {
    const paths = await prepareCase(ROOT_NAME, "concurrent-sync", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const firstSync = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(paths.runtimeStatePath, (value) => value["status"] === "running");

    const secondSync = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [firstResult, secondResult] = await Promise.all([waitForExit(firstSync), waitForExit(secondSync)]);

    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(0);

    const fakeLog = await readJsonLines(paths.logPath);
    const orgCalls = fakeLog.filter((entry) => entry.command === "orgs");
    expect(orgCalls).toHaveLength(2);

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "ap11"]);
  });

  test("sync command fails when the active runtime state has already settled as failed", async () => {
    const paths = await prepareCase(ROOT_NAME, "failed-runtime-waiter", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await writeJson(paths.runtimeStatePath, {
      syncId: "failed-sync",
      status: "failed",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:05.000Z",
      finishedAt: "2026-04-18T00:00:05.000Z",
      error: "sync blew up",
      requestedRegionKeys: ["ap10"],
      completedRegionKeys: [],
      structure: {
        syncedAt: "2026-04-18T00:00:05.000Z",
        regions: [],
      },
    });
    await mkdir(dirname(paths.syncLockPath), { recursive: true });
    await writeFile(paths.syncLockPath, "locked\n", "utf8");

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(1);
    expect(syncResult.stdout).toBe("");
    expect(syncResult.stderr).toContain("active CF sync failed");
  });
});
