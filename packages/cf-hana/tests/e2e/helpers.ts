import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
        selector: "eu10/acme/dev/orders-api",
        regionKey: "eu10",
        orgName: "acme",
        spaceName: "dev",
        appName: "orders-api",
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
