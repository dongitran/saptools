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

export function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env: { ...process.env, CF_LOG_SEARCH_CF_BIN: FAKE_CF_PATH, ...env },
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
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export const BASE_ENV: Record<string, string> = {
  SAP_EMAIL: "user@example.com",
  SAP_PASSWORD: "pw",
  CF_LOG_SEARCH_CREDENTIAL_CACHE: "0",
  SAPTOOLS_AUTO_UPDATE: "off",
};

export function targetArgs(): readonly string[] {
  return ["--region", "eu10", "--org", "example-org", "--space", "space-demo"];
}
