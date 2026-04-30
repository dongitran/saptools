import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface ScenarioApp {
  readonly name: string;
  readonly sshEnabled?: boolean;
  readonly instances?: readonly { readonly index: number; readonly state: string }[];
  readonly files: Record<string, string>;
}

export interface Scenario {
  readonly regions: readonly {
    readonly key: string;
    readonly apiEndpoint: string;
    readonly orgs: readonly {
      readonly name: string;
      readonly spaces: readonly {
        readonly name: string;
        readonly apps: readonly ScenarioApp[];
      }[];
    }[];
  }[];
}

export interface CasePaths {
  readonly caseRoot: string;
  readonly homeDir: string;
  readonly explorerHome: string;
  readonly scenarioPath: string;
  readonly logPath: string;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function prepareCase(caseName: string, scenario: Scenario): Promise<CasePaths> {
  const caseRoot = join(tmpdir(), "cf-explorer-e2e", caseName);
  const paths = {
    caseRoot,
    homeDir: join(caseRoot, "home"),
    explorerHome: join(caseRoot, "explorer-home"),
    scenarioPath: join(caseRoot, "scenario.json"),
    logPath: join(caseRoot, "fake-cf-log.jsonl"),
  };
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.explorerHome, { recursive: true });
  await writeFile(paths.scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  return paths;
}

export function createEnv(paths: CasePaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.homeDir,
    SAP_EMAIL: "e2e@example.com",
    SAP_PASSWORD: "test-password",
    CF_EXPLORER_HOME: paths.explorerHome,
    CF_EXPLORER_CF_BIN: FAKE_CF_BIN,
    CF_EXPLORER_FAKE_SCENARIO: paths.scenarioPath,
    CF_EXPLORER_FAKE_LOG_PATH: paths.logPath,
  };
}

export async function runCli(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    return {
      code: typed.code ?? 1,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

export async function readLog(path: string): Promise<readonly { readonly command: string }[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
