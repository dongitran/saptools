import { execFile, type spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CF_DB_RUNTIME_STATE_FILENAME,
  CF_DB_SNAPSHOT_FILENAME,
  CF_DB_SYNC_HISTORY_FILENAME,
  CF_DB_SYNC_LOCK_FILENAME,
  CF_SYNC_HISTORY_FILENAME,
  CF_RUNTIME_STATE_FILENAME,
  CF_STRUCTURE_FILENAME,
  CF_SYNC_LOCK_FILENAME,
  SAPTOOLS_DIR_NAME,
} from "../../src/paths.js";
import type { DbSyncHistoryEntry, SyncHistoryEntry } from "../../src/types.js";

const execFileAsync = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface ScenarioRegion {
  readonly key: string;
  readonly apiEndpoint: string;
  readonly accessible?: boolean;
  readonly authError?: string;
  readonly orgsDelayMs?: number;
  readonly orgsError?: string;
  readonly orgs: readonly {
    readonly name: string;
    readonly spacesDelayMs?: number;
    readonly spacesError?: string;
    readonly spaces: readonly {
      readonly name: string;
      readonly appsDelayMs?: number;
      readonly appsError?: string;
      readonly apps: readonly (string | ScenarioApp)[];
    }[];
  }[];
}

export interface ScenarioApp {
  readonly name: string;
  readonly envDelayMs?: number;
  readonly envError?: string;
  readonly envOutput?: string;
}

export interface Scenario {
  readonly regions: readonly ScenarioRegion[];
}

export interface FakeLogEntry {
  readonly at: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly apiEndpoint?: string | null;
  readonly org?: string | null;
  readonly space?: string | null;
}

export interface CasePaths {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly historyPath: string;
  readonly runtimeStatePath: string;
  readonly structurePath: string;
  readonly syncLockPath: string;
  readonly dbHistoryPath: string;
  readonly dbRuntimeStatePath: string;
  readonly dbSnapshotPath: string;
  readonly dbSyncLockPath: string;
}

export function buildCasePaths(rootName: string, caseName: string): CasePaths {
  const caseRoot = join(tmpdir(), rootName, caseName);
  const homeDir = join(caseRoot, "home");
  const saptoolsDir = join(homeDir, SAPTOOLS_DIR_NAME);
  return {
    caseRoot,
    homeDir,
    scenarioPath: join(caseRoot, "scenario.json"),
    logPath: join(caseRoot, "fake-cf-log.jsonl"),
    historyPath: join(saptoolsDir, CF_SYNC_HISTORY_FILENAME),
    runtimeStatePath: join(saptoolsDir, CF_RUNTIME_STATE_FILENAME),
    structurePath: join(saptoolsDir, CF_STRUCTURE_FILENAME),
    syncLockPath: join(saptoolsDir, CF_SYNC_LOCK_FILENAME),
    dbHistoryPath: join(saptoolsDir, CF_DB_SYNC_HISTORY_FILENAME),
    dbRuntimeStatePath: join(saptoolsDir, CF_DB_RUNTIME_STATE_FILENAME),
    dbSnapshotPath: join(saptoolsDir, CF_DB_SNAPSHOT_FILENAME),
    dbSyncLockPath: join(saptoolsDir, CF_DB_SYNC_LOCK_FILENAME),
  };
}

export async function prepareCase(
  rootName: string,
  caseName: string,
  scenario: unknown,
): Promise<CasePaths> {
  const paths = buildCasePaths(rootName, caseName);
  await rm(paths.caseRoot, { recursive: true, force: true });
  await mkdir(paths.homeDir, { recursive: true });
  await writeFile(paths.scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  return paths;
}

export function createEnv(
  homeDir: string,
  scenarioPath: string,
  logPath: string,
): NodeJS.ProcessEnv {
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

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonLines(path: string): Promise<readonly FakeLogEntry[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

export async function readSyncHistory(path: string): Promise<readonly SyncHistoryEntry[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SyncHistoryEntry);
}

export async function readDbSyncHistory(path: string): Promise<readonly DbSyncHistoryEntry[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DbSyncHistoryEntry);
}

export async function waitForRuntimeState<T = Record<string, unknown>>(
  runtimeStatePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (existsSync(runtimeStatePath)) {
      const value = await readJson<T>(runtimeStatePath);
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

export async function waitForDbRuntimeState<T = Record<string, unknown>>(
  runtimeStatePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  return await waitForRuntimeState<T>(runtimeStatePath, predicate, timeoutMs);
}

export async function waitForLogEntries(
  logPath: string,
  predicate: (value: readonly FakeLogEntry[]) => boolean,
  timeoutMs = 10_000,
): Promise<readonly FakeLogEntry[]> {
  const deadline = Date.now() + timeoutMs;

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

export async function runJsonCommand<T = Record<string, unknown> | null>(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<T> {
  const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });

  return JSON.parse(stdout) as T;
}

export interface ExitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function waitForExit(child: ReturnType<typeof spawn>): Promise<ExitResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const code = await new Promise<number | null>((resolveCode, rejectCode) => {
    child.once("error", rejectCode);
    child.once("close", resolveCode);
  });

  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
