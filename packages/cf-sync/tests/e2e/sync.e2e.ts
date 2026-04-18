import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import type { CfExecContext } from "../../src/cf.js";
import { cfApi, cfAuth, cfOrgs } from "../../src/cf.js";
import { CF_RUNTIME_STATE_FILENAME, CF_STRUCTURE_FILENAME, SAPTOOLS_DIR_NAME } from "../../src/paths.js";
import { getAllRegions } from "../../src/regions.js";
import { REGION_KEYS, type CfStructure, type RegionKey, type RuntimeSyncState } from "../../src/types.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const AUTO_REGION_LIMIT = 1;
const LIVE_RACE_REGION_LIMIT = 10;
const LIVE_RACE_START_DELAY_MS = 3_000;
const LIVE_E2E_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const LIVE_RACE_MAX_ORG_COUNT = 5;

type LiveProbeStatus = "unavailable" | "accessible-empty" | "accessible-with-orgs";

interface LiveRegionProbe {
  readonly key: RegionKey;
  readonly apiEndpoint: string;
  readonly status: LiveProbeStatus;
  readonly orgCount: number;
}

interface StructureView {
  readonly source: "runtime" | "stable";
  readonly structure: CfStructure;
  readonly metadata?: {
    readonly status: "running" | "completed" | "failed";
    readonly requestedRegionKeys: readonly RegionKey[];
    readonly completedRegionKeys: readonly RegionKey[];
    readonly pendingRegionKeys: readonly RegionKey[];
  };
}

interface RegionsView {
  readonly source: "catalog" | "stable";
  readonly regions: readonly {
    readonly key: RegionKey;
    readonly label: string;
    readonly apiEndpoint: string;
  }[];
  readonly metadata?: {
    readonly status: "running" | "completed" | "failed";
    readonly completedRegionKeys: readonly RegionKey[];
    readonly pendingRegionKeys: readonly RegionKey[];
  };
}

interface RegionView {
  readonly source: "runtime" | "stable" | "fresh";
  readonly region: {
    readonly key: RegionKey;
    readonly accessible: boolean;
  };
  readonly metadata?: {
    readonly status: "running" | "completed" | "failed";
    readonly completedRegionKeys: readonly RegionKey[];
    readonly pendingRegionKeys: readonly RegionKey[];
  };
}

interface LiveCasePaths {
  readonly homeDir: string;
  readonly runtimeStatePath: string;
  readonly structurePath: string;
  readonly env: NodeJS.ProcessEnv;
}

let liveProbeCachePromise: Promise<readonly LiveRegionProbe[]> | undefined;

function readLiveCreds(): { readonly email: string; readonly password: string } | undefined {
  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];
  if (!email || !password) {
    return undefined;
  }
  return { email, password };
}

function createLiveEnv(homeDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (homeDir) {
    env["HOME"] = homeDir;
  }
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  return env;
}

function liveSaptoolsDir(homeDir: string): string {
  return join(homeDir, SAPTOOLS_DIR_NAME);
}

async function createLiveCasePaths(): Promise<LiveCasePaths> {
  const homeDir = await mkdtemp(join(tmpdir(), "saptools-live-home-"));
  const saptoolsDir = liveSaptoolsDir(homeDir);

  return {
    homeDir,
    runtimeStatePath: join(saptoolsDir, CF_RUNTIME_STATE_FILENAME),
    structurePath: join(saptoolsDir, CF_STRUCTURE_FILENAME),
    env: createLiveEnv(homeDir),
  };
}

function loadOnlyRegionsFromEnv(): readonly (typeof REGION_KEYS)[number][] | undefined {
  const raw = process.env["CF_SYNC_E2E_ONLY"];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const requested = raw
    .split(",")
    .map((region) => region.trim())
    .filter((region): region is string => region.length > 0);

  const allowed = new Set<string>(REGION_KEYS);
  const invalid = requested.filter((region) => !allowed.has(region));
  expect(invalid, `CF_SYNC_E2E_ONLY has unknown regions: ${invalid.join(", ")}`).toEqual([]);

  return requested.filter((region): region is (typeof REGION_KEYS)[number] => allowed.has(region));
}

async function probeRegion(
  apiEndpoint: string,
  email: string,
  password: string,
): Promise<{
  readonly status: LiveProbeStatus;
  readonly orgCount: number;
}> {
  return await withCfSession(async (context) => {
    try {
      await cfApi(apiEndpoint, context);
      await cfAuth(email, password, context);
    } catch {
      return {
        status: "unavailable",
        orgCount: 0,
      };
    }

    try {
      const orgs = await cfOrgs(context);
      return {
        status: orgs.length > 0 ? "accessible-with-orgs" : "accessible-empty",
        orgCount: orgs.length,
      };
    } catch {
      return {
        status: "accessible-empty",
        orgCount: 0,
      };
    }
  });
}

async function withCfSession<T>(work: (context: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-live-e2e-"));
  const context: CfExecContext = {
    env: { CF_HOME: cfHome },
  };

  try {
    return await work(context);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

async function detectLiveRegionProbes(
  email: string,
  password: string,
): Promise<readonly LiveRegionProbe[]> {
  liveProbeCachePromise ??= (async () => {
      const probes: LiveRegionProbe[] = [];

      for (const region of getAllRegions()) {
        const probe = await probeRegion(region.apiEndpoint, email, password);
        probes.push({
          key: region.key,
          apiEndpoint: region.apiEndpoint,
          status: probe.status,
          orgCount: probe.orgCount,
        });
      }

      return probes;
    })();

  return await liveProbeCachePromise;
}

function pickRegionsByStatus(
  probes: readonly LiveRegionProbe[],
  status: LiveProbeStatus,
  limit: number,
): readonly RegionKey[] {
  return probes
    .filter((probe) => probe.status === status)
    .slice(0, limit)
    .map((probe) => probe.key);
}

async function detectValidRegions(
  email: string,
  password: string,
): Promise<readonly RegionKey[]> {
  const probes = await detectLiveRegionProbes(email, password);
  return pickRegionsByStatus(probes, "accessible-with-orgs", AUTO_REGION_LIMIT);
}

async function detectLiveRaceRegions(
  email: string,
  password: string,
): Promise<readonly RegionKey[]> {
  const probes = await detectLiveRegionProbes(email, password);
  const withOrgs = probes.filter((probe) => probe.status === "accessible-with-orgs");
  const lightweightWithOrgs = withOrgs.filter((probe) => probe.orgCount <= LIVE_RACE_MAX_ORG_COUNT);
  const prioritizedWithOrgs =
    lightweightWithOrgs.length >= LIVE_RACE_REGION_LIMIT
      ? lightweightWithOrgs
      : [
          ...lightweightWithOrgs,
          ...withOrgs.filter((probe) => probe.orgCount > LIVE_RACE_MAX_ORG_COUNT),
        ];
  if (prioritizedWithOrgs.length >= LIVE_RACE_REGION_LIMIT) {
    return prioritizedWithOrgs.slice(0, LIVE_RACE_REGION_LIMIT).map((probe) => probe.key);
  }

  const accessibleEmpty = probes
    .filter((probe) => probe.status === "accessible-empty")
    .map((probe) => probe.key);
  return [...prioritizedWithOrgs.map((probe) => probe.key), ...accessibleEmpty].slice(0, LIVE_RACE_REGION_LIMIT);
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function runJsonCommandWithEnv<T>(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<T | null> {
  const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: LIVE_E2E_WAIT_TIMEOUT_MS,
  });
  return JSON.parse(stdout) as T | null;
}

async function waitForRuntimeState(
  runtimeStatePath: string,
  predicate: (state: RuntimeSyncState) => boolean,
): Promise<RuntimeSyncState> {
  const deadline = Date.now() + LIVE_E2E_WAIT_TIMEOUT_MS;

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

    await new Promise((resolve) => setTimeout(resolve, 200));
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

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("close", () => {
        resolve(true);
      });
    }),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 5_000);
    }),
  ]);

  if (!exited) {
    child.kill("SIGKILL");
  }
}

test("cf-sync sync writes ~/.saptools/cf-structure.json", async () => {
  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — live sync test skipped");
  if (!creds) {
    return;
  }
  const { email, password } = creds;
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  const liveCase = await createLiveCasePaths();

  try {
    const onlyRegions = loadOnlyRegionsFromEnv() ?? (await detectValidRegions(email, password));
    expect(
      onlyRegions.length,
      "E2E preflight must detect at least one CF region that contains orgs",
    ).toBeGreaterThan(0);

    const args = ["sync", "--verbose", "--only", onlyRegions.join(",")];

    const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
      env: liveCase.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 9 * 60 * 1000,
    });

    expect(stdout).toContain("Structure written to");

    const raw = await readFile(liveCase.structurePath, "utf8");
    const parsed = JSON.parse(raw) as CfStructure;
    expect(parsed.regions.length).toBeGreaterThan(0);
    expect(parsed.regions.map((region) => region.key)).toEqual(onlyRegions);
    expect(parsed.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const accessible = parsed.regions.filter((r) => r.accessible);
    expect(accessible.length).toBeGreaterThan(0);
  } finally {
    await rm(liveCase.homeDir, { recursive: true, force: true });
  }
});

test("cf-sync can hydrate the last real region during a long live sync", async () => {
  test.setTimeout(15 * 60 * 1000);

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — live race test skipped");
  if (!creds) {
    return;
  }
  const { email, password } = creds;
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  const liveCase = await createLiveCasePaths();
  let syncProcess: ReturnType<typeof spawn> | undefined;

  try {
    const raceRegions = loadOnlyRegionsFromEnv() ?? (await detectLiveRaceRegions(email, password));
    expect(
      raceRegions.length,
      "Live race E2E requires at least 5 usable regions so the last-region fetch is meaningful",
    ).toBeGreaterThanOrEqual(5);

    const lastRegion = raceRegions.at(-1);
    expect(lastRegion, "Live race E2E must select a last region").toBeDefined();
    if (!lastRegion) {
      throw new Error("Live race E2E must select a last region");
    }
    const middleRegions = raceRegions.slice(1, -1);
    expect(middleRegions.length, "Live race E2E must leave at least one middle region pending").toBeGreaterThan(0);

    const catalogBefore = await runJsonCommandWithEnv<RegionsView>(liveCase.env, ["regions"]);
    expect(catalogBefore).toEqual({
      source: "catalog",
      regions: getAllRegions(),
    });

    syncProcess = spawn("node", [CLI_PATH, "sync", "--verbose", "--only", raceRegions.join(",")], {
      env: liveCase.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((resolve) => setTimeout(resolve, LIVE_RACE_START_DELAY_MS));

    const runningState = await waitForRuntimeState(liveCase.runtimeStatePath, (state) => state.status === "running");
    expect(runningState.requestedRegionKeys).toEqual(raceRegions);
    expect(runningState.completedRegionKeys).not.toContain(lastRegion);

    const viewBefore = await runJsonCommandWithEnv<StructureView>(liveCase.env, ["read"]);
    expect(viewBefore).not.toBeNull();
    expect(viewBefore?.source).toBe("runtime");
    expect(viewBefore?.metadata?.status).toBe("running");
    expect(viewBefore?.metadata?.completedRegionKeys).not.toContain(lastRegion);

    const regionsWhileRunning = await runJsonCommandWithEnv<RegionsView>(liveCase.env, ["regions"]);
    expect(regionsWhileRunning).not.toBeNull();
    expect(regionsWhileRunning?.source).toBe("catalog");
    expect(regionsWhileRunning?.metadata?.status).toBe("running");
    expect(regionsWhileRunning?.metadata?.completedRegionKeys).not.toContain(lastRegion);
    expect(regionsWhileRunning?.regions.map((region) => region.key)).toEqual(
      getAllRegions().map((region) => region.key),
    );

    const regionView = await runJsonCommandWithEnv<RegionView>(liveCase.env, ["region", lastRegion]);
    expect(regionView).not.toBeNull();
    expect(regionView?.region.key).toBe(lastRegion);
    expect(regionView?.region.accessible).toBe(true);

    const hydratedState = await waitForRuntimeState(
      liveCase.runtimeStatePath,
      (state) =>
        state.status === "running" &&
        state.completedRegionKeys.includes(lastRegion) &&
        middleRegions.some((region) => !state.completedRegionKeys.includes(region)),
    );
    expect(hydratedState.completedRegionKeys).toContain(lastRegion);
    expect(middleRegions.some((region) => !hydratedState.completedRegionKeys.includes(region))).toBe(true);

    const syncResult = await waitForExit(syncProcess);
    syncProcess = undefined;
    expect(syncResult.code).toBe(0);
    expect(syncResult.stdout).toContain("Structure written to");

    const finalState = await readJson<RuntimeSyncState>(liveCase.runtimeStatePath);
    expect(finalState.status).toBe("completed");
    expect(finalState.completedRegionKeys).toEqual(raceRegions);

    const structure = await readJson<CfStructure>(liveCase.structurePath);
    expect(structure.regions.map((region) => region.key)).toEqual(raceRegions);
    expect(structure.regions.find((region) => region.key === lastRegion)?.accessible).toBe(true);

    const stableRegions = structure.regions
      .filter((region) => region.orgs.length > 0)
      .map((region) => region.key);
    const regionsAfterSync = await runJsonCommandWithEnv<RegionsView>(liveCase.env, ["regions"]);
    expect(regionsAfterSync).not.toBeNull();
    expect(regionsAfterSync?.source).toBe("stable");
    expect(regionsAfterSync?.metadata?.status).toBe("completed");
    expect(regionsAfterSync?.regions.map((region) => region.key)).toEqual(stableRegions);
  } finally {
    if (syncProcess) {
      await stopChild(syncProcess);
    }
    await rm(liveCase.homeDir, { recursive: true, force: true });
  }
});
