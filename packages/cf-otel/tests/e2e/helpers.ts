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

/**
 * The credential cache is off for every test by default: with it on, the
 * second test in a file would find the first test's credential on disk and
 * never touch the fake `cf` at all — masking exactly the discovery behavior
 * most of these tests exist to pin. It also keeps every run here off the
 * real `~/.saptools/cf-otel/credentials.json`, since this package has no
 * narrower root-override env var of its own to redirect it. Updates are off
 * for every test so none ever reaches the real npm registry; the dev path
 * would skip anyway.
 */
export const BASE_ENV: Record<string, string> = {
  SAP_EMAIL: "user@example.com",
  SAP_PASSWORD: "pw",
  CF_OTEL_CREDENTIAL_CACHE: "0",
  SAPTOOLS_AUTO_UPDATE: "off",
};

export function targetArgs(): readonly string[] {
  return ["--region", "eu10", "--org", "example-org", "--space", "space-demo"];
}

/**
 * Poll `check()` until it returns `true`, or throw with a clear message once
 * `timeoutMs` elapses. For coordinating with a background process (e.g. one
 * paused mid-mutation via `CF_OTEL_FAKE_CF_SLOW_MS`) whose on-disk state
 * changes asynchronously — replaces a fixed-duration guessed delay, which is
 * either too short (flaky under CI load) or wastefully long, with a bounded
 * wait on the actual condition the test cares about.
 */
export async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000, pollMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
