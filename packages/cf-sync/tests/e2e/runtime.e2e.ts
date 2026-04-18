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
  CF_SYNC_LOCK_FILENAME,
  SAPTOOLS_DIR_NAME,
} from "../../src/paths.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");
const E2E_ROOT = join(tmpdir(), "cf-sync-e2e");

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

interface FakeLogEntry {
  readonly at: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly apiEndpoint?: string | null;
  readonly org?: string | null;
  readonly space?: string | null;
}

function buildCasePaths(caseName: string): {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly runtimeStatePath: string;
  readonly structurePath: string;
  readonly syncLockPath: string;
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
    syncLockPath: join(saptoolsDir, CF_SYNC_LOCK_FILENAME),
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
            spaces: [{ name: "dev", apps: ["app-ap10"] }],
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

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonLines(path: string): Promise<readonly FakeLogEntry[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

async function waitForRuntimeState(
  runtimeStatePath: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    if (existsSync(runtimeStatePath)) {
      const value = await readJson<Record<string, unknown>>(runtimeStatePath);
      if (predicate(value)) {
        return value;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for runtime state at ${runtimeStatePath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForLogEntries(
  logPath: string,
  predicate: (value: readonly FakeLogEntry[]) => boolean,
): Promise<readonly FakeLogEntry[]> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    if (existsSync(logPath)) {
      const value = await readJsonLines(logPath);
      if (predicate(value)) {
        return value;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for fake CF log at ${logPath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function countEndpointCalls(entries: readonly FakeLogEntry[], apiEndpoint: string): number {
  return entries.filter(
    (entry) => entry.apiEndpoint === apiEndpoint || (entry.command === "api" && entry.args?.includes(apiEndpoint)),
  ).length;
}

async function runJsonCommand(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<Record<string, unknown> | null> {
  const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });

  return JSON.parse(stdout) as Record<string, unknown> | null;
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

test.describe("Runtime reads", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake CF fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("fresh install read commands return null before any package-managed snapshot exists", async () => {
    const paths = await prepareCase("fresh-install-reads", createScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await expect(runJsonCommand(env, ["read"])).resolves.toBeNull();
    await expect(runJsonCommand(env, ["region", "eu10", "--no-refresh"])).resolves.toBeNull();

    expect(existsSync(paths.runtimeStatePath)).toBe(false);
    expect(existsSync(paths.structurePath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("region command returns an inaccessible fresh region when authentication fails", async () => {
    const paths = await prepareCase("inaccessible-region", createInaccessibleScenario());
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

  test("service can inspect partial structure while sync is still running", async () => {
    const paths = await prepareCase("partial-structure", createScenario());
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
    const paths = await prepareCase("runtime-cache-hit", createScenario());
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
    const paths = await prepareCase("cache-only-region-read", createScenario());
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
    const paths = await prepareCase("late-region-hydration", createScenario());
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

  test("service can hydrate the last region in a longer sync list right after sync starts", async () => {
    const paths = await prepareCase("late-last-region-hydration", createLongScenario());
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
    const paths = await prepareCase("concurrent-sync", createScenario());
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
    const paths = await prepareCase("failed-runtime-waiter", createScenario());
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
