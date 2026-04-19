import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_BIN = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface CasePaths {
  readonly caseRoot: string;
  readonly workspaceRoot: string;
  readonly vcapPath: string;
  readonly scenarioPath: string;
  readonly settingsPath: string;
  readonly credentialsPath: string;
}

export function buildCasePaths(rootName: string, caseName: string): CasePaths {
  const caseRoot = join(tmpdir(), rootName, caseName);
  const workspaceRoot = join(caseRoot, "workspace");
  return {
    caseRoot,
    workspaceRoot,
    vcapPath: join(caseRoot, "vcap.json"),
    scenarioPath: join(caseRoot, "scenario.json"),
    settingsPath: join(workspaceRoot, ".vscode", "settings.json"),
    credentialsPath: join(workspaceRoot, "hana-credentials.json"),
  };
}

export async function prepareCase(rootName: string, caseName: string): Promise<CasePaths> {
  const paths = buildCasePaths(rootName, caseName);
  await rm(paths.caseRoot, { recursive: true, force: true });
  await mkdir(paths.workspaceRoot, { recursive: true });
  return paths;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export const VALID_VCAP = {
  hana: [
    {
      credentials: {
        host: "host.hana.example.com",
        port: "443",
        user: "USER_1",
        password: "pw",
        schema: "SCHEMA_1",
        hdi_user: "HDI_USER",
        hdi_password: "HDI_PASS",
        url: "jdbc:sap://host.hana.example.com:443",
        database_id: "DB123",
        certificate: "cert",
      },
    },
  ],
} as const;

export interface RunCliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<RunCliResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);

    child.once("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
