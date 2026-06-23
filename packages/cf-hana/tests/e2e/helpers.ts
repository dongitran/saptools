import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
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

/** Write a `cf-sync`-shaped HANA binding snapshot into a temporary home. */
export async function seedCredentialsCache(home: string): Promise<void> {
  const directory = join(home, ".saptools");
  await mkdir(directory, { recursive: true });
  const snapshot = {
    version: 1,
    syncedAt: "2026-05-22T00:00:00.000Z",
    entries: [
      {
        selector: "eu10/example-org/space-demo/app-demo",
        regionKey: "eu10",
        orgName: "example-org",
        spaceName: "space-demo",
        appName: "app-demo",
        syncedAt: "2026-05-22T00:00:00.000Z",
        bindings: [
          {
            kind: "hana",
            name: "hana-primary",
            credentials: {
              host: "hana.example.internal",
              port: "443",
              user: "DB_USER",
              password: "db-password",
              schema: "APP_SCHEMA",
              hdiUser: "HDI_USER",
              hdiPassword: "HDI_PASSWORD",
              url: "jdbc:sap://hana.example.internal:443",
              databaseId: "DB-1",
              certificate: "test-certificate",
            },
          },
        ],
      },
    ],
  };
  await writeFile(
    join(directory, "cf-db-bindings.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
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
