import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface FakeTraceEntry {
  readonly sql: string;
  readonly paramCount: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

export function fakeTracePath(home: string): string {
  return join(home, "cf-hana-fake-trace.jsonl");
}

function isFakeTraceEntry(value: unknown): value is FakeTraceEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, "sql") === "string" &&
    Number.isInteger(Reflect.get(value, "paramCount"))
  );
}

export async function readFakeTraceEntries(
  home: string,
): Promise<readonly FakeTraceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(fakeTracePath(home), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isFakeTraceEntry(parsed)) {
        throw new Error("Invalid fake driver trace entry");
      }
      return parsed;
    });
}

/** Spawn the built CLI and capture its output. */
export function runCli(
  args: readonly string[],
  env: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/** Setup fake 'cf' binary in a dir to be prepended to PATH for e2e tests. */
export async function setupFakeCfBin(home: string): Promise<string> {
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  const fakePath = join(binDir, "cf");
  const wrapper = `#!/bin/sh
exec node "${join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs")}" "$@"
`;
  await writeFile(fakePath, wrapper);
  await chmod(fakePath, 0o755);
  return binDir;
}

export async function readHistoryEntries(
  home: string,
): Promise<readonly Record<string, unknown>[]> {
  const historyDir = join(home, ".saptools", "cf-hana", "histories");
  const files = await readdir(historyDir);
  const entries: Record<string, unknown>[] = [];
  for (const file of files) {
    const raw = await readFile(join(historyDir, file), "utf8");
    entries.push(
      ...raw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  }
  return entries;
}

export async function readBackupFiles(
  home: string,
): Promise<readonly { statement: string; csv: string }[]> {
  const backupRoot = join(home, ".saptools", "cf-hana", "backups");
  let directories: readonly string[];
  try {
    directories = await readdir(backupRoot);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }
  const backups: { statement: string; csv: string }[] = [];
  for (const month of [...directories].sort()) {
    const monthDir = join(backupRoot, month);
    const entries = await readdir(monthDir);
    const dataFiles = entries
      .filter((entry) => entry.endsWith(".sql") && !entry.endsWith(".statement.sql"))
      .sort();
    for (const dataFile of dataFiles) {
      const statementFile = dataFile.replace(/\.sql$/, ".statement.sql");
      backups.push({
        statement: await readFile(join(monthDir, statementFile), "utf8"),
        csv: await readFile(join(monthDir, dataFile), "utf8"),
      });
    }
  }
  return backups;
}
