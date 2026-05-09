import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface ScenarioStreamChunk {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly delayMs?: number;
}

export interface ScenarioApp {
  readonly name: string;
  readonly runningInstances?: number;
  readonly recentLogs?: string;
  readonly stream?: readonly ScenarioStreamChunk[];
}

export interface ScenarioSpace {
  readonly name: string;
  readonly apps: readonly ScenarioApp[];
}

export interface ScenarioOrg {
  readonly name: string;
  readonly spaces: readonly ScenarioSpace[];
}

export interface ScenarioRegion {
  readonly key: string;
  readonly apiEndpoint: string;
  readonly orgs: readonly ScenarioOrg[];
}

export interface Scenario {
  readonly regions: readonly ScenarioRegion[];
}

export interface FakeLogEntry {
  readonly at: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly apiEndpoint?: string | null;
  readonly org?: string | null;
  readonly space?: string | null;
}

export interface CasePaths {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly scenarioPath: string;
  readonly logPath: string;
}

export function buildCasePaths(rootName: string, caseName: string): CasePaths {
  const caseRoot = join(tmpdir(), rootName, caseName);
  return {
    caseRoot,
    homeDir: join(caseRoot, "home"),
    workDir: join(caseRoot, "work"),
    scenarioPath: join(caseRoot, "scenario.json"),
    logPath: join(caseRoot, "fake-cf-log.jsonl"),
  };
}

export async function prepareCase(
  rootName: string,
  caseName: string,
  scenario: Scenario,
): Promise<CasePaths> {
  const paths = buildCasePaths(rootName, caseName);
  await rm(paths.caseRoot, { recursive: true, force: true });
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.workDir, { recursive: true });
  await writeFile(paths.scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  return paths;
}

export function createEnv(paths: CasePaths): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  return {
    ...env,
    HOME: paths.homeDir,
    CF_HOME: paths.homeDir,
    SAP_EMAIL: "sample@example.com",
    SAP_PASSWORD: "sample-password",
    CF_LOGS_CF_BIN: FAKE_CF_BIN,
    CF_LOGS_FAKE_SCENARIO: paths.scenarioPath,
    CF_LOGS_FAKE_LOG_PATH: paths.logPath,
  };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd?: string,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env,
      cwd: cwd ?? process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly message: string;
    };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message,
    };
  }
}

export async function runStreamCli(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<RunResult> {
  const child = spawn("node", [CLI_PATH, ...args], {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

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

export async function runCliAt(
  cliPath: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [cliPath, ...args], {
      env,
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly message: string;
    };
    return {
      code: typeof typed.code === "number" ? typed.code : 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? typed.message,
    };
  }
}

export async function makeSymlink(target: string, linkDir: string, name: string): Promise<string> {
  await mkdir(linkDir, { recursive: true });
  const linkPath = join(linkDir, name);
  await symlink(target, linkPath);
  return linkPath;
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export async function readFakeLog(path: string): Promise<readonly FakeLogEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeLogEntry);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}
