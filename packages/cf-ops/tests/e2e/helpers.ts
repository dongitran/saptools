import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface FakeCfLogEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: {
    readonly hasSapEmail: boolean;
    readonly hasSapPassword: boolean;
  };
}

export interface CasePaths {
  readonly caseRoot: string;
  readonly logPath: string;
}

export async function prepareCase(caseName: string): Promise<CasePaths> {
  const caseRoot = join(tmpdir(), "saptools-cf-ops-e2e", caseName);
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(caseRoot, { recursive: true });
  return {
    caseRoot,
    logPath: join(caseRoot, "fake-cf-log.jsonl"),
  };
}

export function createEnv(paths: CasePaths): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  return {
    ...env,
    CF_OPS_CF_BIN: FAKE_CF_BIN,
    CF_OPS_FAKE_LOG_PATH: paths.logPath,
    SAP_EMAIL: "e2e@example.com",
    SAP_PASSWORD: "secret-password",
  };
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env,
      cwd: PACKAGE_DIR,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string; readonly message: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

export async function readFakeLog(path: string): Promise<readonly FakeCfLogEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeCfLogEntry);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
