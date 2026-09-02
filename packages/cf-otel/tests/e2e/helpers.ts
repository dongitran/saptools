import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
export const FAKE_CF_PATH = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-cf.mjs");

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn the real built CLI. `CF_OTEL_CF_BIN` pointed at the fake `cf` script
 * is enough on its own (see `resolveCfBin` in src/cf.ts) — no PATH/wrapper
 * shim needed, unlike siblings whose `cf` wrapper lacks that override hook.
 */
export function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env: { ...process.env, CF_OTEL_CF_BIN: FAKE_CF_PATH, ...env },
    });
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

/** Updates are off for every test so none ever reaches the real npm registry; the dev path would skip anyway. */
export const BASE_ENV: Record<string, string> = {
  SAP_EMAIL: "user@example.com",
  SAP_PASSWORD: "pw",
  SAPTOOLS_AUTO_UPDATE: "off",
};

export function targetArgs(): readonly string[] {
  return ["--region", "eu10", "--org", "example-org", "--space", "space-demo"];
}
