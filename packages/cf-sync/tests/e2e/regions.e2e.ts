import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  CF_RUNTIME_STATE_FILENAME,
  CF_STRUCTURE_FILENAME,
  SAPTOOLS_DIR_NAME,
} from "../../src/paths.js";
import { getAllRegions } from "../../src/regions.js";
import type { CfStructure, RuntimeSyncState } from "../../src/types.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");
const E2E_ROOT = join(tmpdir(), "cf-sync-regions-e2e");
const CATALOG_REGIONS = getAllRegions();

interface ScenarioRegion {
  readonly key: string;
  readonly apiEndpoint: string;
  readonly accessible?: boolean;
  readonly orgsDelayMs?: number;
  readonly orgs: readonly {
    readonly name: string;
    readonly spaces: readonly {
      readonly name: string;
      readonly apps: readonly string[];
    }[];
  }[];
}

interface Scenario {
  readonly regions: readonly ScenarioRegion[];
}

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

function buildCasePaths(caseName: string): {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly runtimeStatePath: string;
  readonly structurePath: string;
} {
  const caseRoot = join(E2E_ROOT, caseName);
  const homeDir = join(caseRoot, "home");
  const saptoolsDir = join(homeDir, SAPTOOLS_DIR_NAME);
  return {
    caseRoot,
    homeDir,
    scenarioPath: join(caseRoot, "scenario.json"),
    logPath: join(caseRoot, "fake-cf-log.jsonl"),
    runtimeStatePath: join(saptoolsDir, CF_RUNTIME_STATE_FILENAME),
    structurePath: join(saptoolsDir, CF_STRUCTURE_FILENAME),
  };
}

async function prepareCase(caseName: string, scenario: unknown): Promise<ReturnType<typeof buildCasePaths>> {
  const paths = buildCasePaths(caseName);
  await rm(paths.caseRoot, { recursive: true, force: true });
  await mkdir(paths.homeDir, { recursive: true });
  await writeFile(paths.scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  return paths;
}

function createEnv(homeDir: string, scenarioPath: string, logPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];

  return {
    ...env,
    HOME: homeDir,
    SAP_EMAIL: "e2e@example.com",
    SAP_PASSWORD: "test-password",
    CF_SYNC_CF_BIN: FAKE_CF_BIN,
    CF_SYNC_FAKE_SCENARIO: scenarioPath,
    CF_SYNC_FAKE_LOG_PATH: logPath,
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

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runJsonCommand(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<RegionsViewPayload> {
  const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });

  return JSON.parse(stdout) as RegionsViewPayload;
}

async function waitForRuntimeState(
  runtimeStatePath: string,
  predicate: (state: RuntimeSyncState) => boolean,
): Promise<RuntimeSyncState> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    if (existsSync(runtimeStatePath)) {
      const state = await readJson<RuntimeSyncState>(runtimeStatePath);
      if (predicate(state)) {
        return state;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for runtime state at ${runtimeStatePath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
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
    const paths = await prepareCase("regions-fresh-install", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const view = await runJsonCommand(env, ["regions"]);

    expect(view).toEqual({
      source: "catalog",
      regions: CATALOG_REGIONS,
    });
    expect(existsSync(paths.runtimeStatePath)).toBe(false);
    expect(existsSync(paths.structurePath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("returns the full SAP catalog while sync is still running", async () => {
    const paths = await prepareCase("regions-running-catalog", createRunningScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForRuntimeState(
      paths.runtimeStatePath,
      (state) => state.completedRegionKeys.includes("ap10") && !state.completedRegionKeys.includes("ap11"),
    );

    const view = await runJsonCommand(env, ["regions"]);
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
    const paths = await prepareCase("regions-after-sync", createMixedRegionsScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const syncProcess = spawn("node", [CLI_PATH, "sync", "--only", "ap10,ap11,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const syncResult = await waitForExit(syncProcess);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stderr).toBe("");

    const view = await runJsonCommand(env, ["regions"]);
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
    const paths = await prepareCase("regions-running-over-stable", createRunningScenario());
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

    await waitForRuntimeState(
      paths.runtimeStatePath,
      (state) => state.completedRegionKeys.includes("ap10") && !state.completedRegionKeys.includes("ap11"),
    );

    const view = await runJsonCommand(env, ["regions"]);
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
    const paths = await prepareCase("regions-failed-runtime", createMixedRegionsScenario());
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

    const view = await runJsonCommand(env, ["regions"]);
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
