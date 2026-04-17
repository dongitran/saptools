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

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");
const E2E_ROOT = join(tmpdir(), "cf-sync-e2e");

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

function createScenario(): {
  readonly regions: readonly {
    readonly key: string;
    readonly apiEndpoint: string;
    readonly orgsDelayMs: number;
    readonly orgs: readonly {
      readonly name: string;
      readonly spaces: readonly {
        readonly name: string;
        readonly apps: readonly string[];
      }[];
    }[];
  }[];
} {
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

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonLines(path: string): Promise<readonly Record<string, string>[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, string>);
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
        entry["command"] === "orgs" &&
        entry["apiEndpoint"] === "https://api.cf.eu10.hana.ondemand.com",
    );
    expect(eu10OrgsCalls).toHaveLength(1);
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
    const orgCalls = fakeLog.filter((entry) => entry["command"] === "orgs");
    expect(orgCalls).toHaveLength(2);

    const stableStructure = await readJson<{ readonly regions: readonly { readonly key: string }[] }>(
      paths.structurePath,
    );
    expect(stableStructure.regions.map((region) => region.key)).toEqual(["ap10", "ap11"]);
  });
});
