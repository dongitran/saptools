import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");

export interface LiveCreds {
  readonly email: string;
  readonly password: string;
}

export function readLiveCreds(): LiveCreds | undefined {
  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];
  if (email === undefined || email === "" || password === undefined || password === "") {
    return undefined;
  }
  return { email, password };
}

export async function createIsolatedHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cf-debugger-e2e-home-"));
}

export async function cleanupHome(homeDir: string): Promise<void> {
  await rm(homeDir, { recursive: true, force: true });
}

export function buildEnv(homeDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  env["HOME"] = homeDir;
  return env;
}

export interface CfSessionContext {
  readonly cfHome: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function withIsolatedCfHome<T>(
  work: (ctx: CfSessionContext) => Promise<T>,
): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "cf-debugger-e2e-cfhome-"));
  const env = { ...process.env, CF_HOME: cfHome };
  try {
    return await work({ cfHome, env });
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

export async function cfExec(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("cf", [...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { stdout, stderr };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(
      `cf ${args.join(" ")} failed: ${e.stderr?.trim() ?? e.message}`,
      { cause: err },
    );
  }
}

function parseNameColumn(stdout: string): readonly string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "name");
  if (headerIdx === -1) {
    return [];
  }
  return lines
    .slice(headerIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function parseOrgs(stdout: string): readonly string[] {
  return parseNameColumn(stdout);
}

export function parseSpaces(stdout: string): readonly string[] {
  return parseNameColumn(stdout);
}

export interface AppRow {
  readonly name: string;
  readonly state: string;
  readonly runningInstances: number;
}

export function parseApps(stdout: string): readonly AppRow[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.includes("requested state"));
  if (headerIdx === -1) {
    return [];
  }

  const rows: AppRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s{2,}/);
    const name = parts[0]?.trim();
    const state = parts[1]?.trim() ?? "";
    if (name === undefined || name.length === 0) {
      continue;
    }
    let running = 0;
    const instances = parts[2]?.trim();
    if (instances !== undefined) {
      const regex = /(\d+)\/\d+/g;
      let match: RegExpExecArray | null = regex.exec(instances);
      while (match !== null) {
        running += Number.parseInt(match[1] ?? "0", 10);
        match = regex.exec(instances);
      }
    }
    rows.push({ name, state, runningInstances: running });
  }
  return rows;
}

export async function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(false);
    });
  });
}
