// End-to-end coverage of the self-updater on a realistic npm global layout:
// the built CLI is copied into `<prefix>/lib/node_modules/@saptools/cf-metrics`
// and launched through `<prefix>/bin/cf-metrics`, a fake registry announces a
// newer version, and the real `npm` installs a stub release from that registry.
// The stub prints its argv and exits 7, which proves the re-exec ran the new
// code with the original arguments and that its exit code came back to the
// caller.

import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { startFakeRegistry } from "./fixtures/fake-registry.js";
import type { FakeRegistry } from "./fixtures/fake-registry.js";
import { CLI_PATH, FAKE_CF_PATH } from "./helpers.js";
import type { CliResult } from "./helpers.js";

const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PACKAGE_NAME = "@saptools/cf-metrics";
const NEXT_VERSION = "0.99.0";

let installedVersion = "";
let stubTarball: Buffer;
let workDir: string;
let root: string;
let registry: FakeRegistry | undefined;

interface InstalledCopy {
  readonly prefix: string;
  readonly packageDir: string;
  readonly bin: string;
}

/** A tiny release of the same package: prints how it was invoked and exits 7. */
async function buildStubTarball(version: string): Promise<Buffer> {
  const stub = join(workDir, "stub");
  await mkdir(join(stub, "dist"), { recursive: true });
  await writeFile(
    join(stub, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version, type: "module", bin: { "cf-metrics": "dist/cli.js" }, files: ["dist"], license: "MIT" }, null, 2),
  );
  const source = [
    "#!/usr/bin/env node",
    `const payload = { version: ${JSON.stringify(version)}, argv: process.argv.slice(2), reexec: process.env.SAPTOOLS_SELF_UPDATE_REEXEC ?? "" };`,
    'process.stdout.write(`STUB ${JSON.stringify(payload)}\\n`);',
    "process.exit(7);",
    "",
  ].join("\n");
  await writeFile(join(stub, "dist", "cli.js"), source);
  const out = join(workDir, "pack");
  await mkdir(out, { recursive: true });
  execFileSync("npm", ["pack", "--pack-destination", out, "--loglevel=silent"], {
    cwd: stub,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_cache: join(workDir, "npm-cache") },
  });
  const [file] = await readdir(out);
  if (file === undefined) {
    throw new Error("npm pack produced no tarball");
  }
  return await readFile(join(out, file));
}

/** Lay the built CLI out exactly as `npm install -g` would under a fresh prefix. */
async function installedCopy(): Promise<InstalledCopy> {
  const prefix = join(root, "prefix");
  const packageDir = join(prefix, "lib", "node_modules", "@saptools", "cf-metrics");
  await cp(join(PACKAGE_DIR, "dist"), join(packageDir, "dist"), { recursive: true });
  await cp(await realpath(join(PACKAGE_DIR, "node_modules", "commander")), join(packageDir, "node_modules", "commander"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    readonly version: string;
    readonly bin: Record<string, string>;
    readonly dependencies: Record<string, string>;
  };
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: manifest.version, type: "module", bin: manifest.bin, dependencies: manifest.dependencies }, null, 2),
  );
  await mkdir(join(prefix, "bin"), { recursive: true });
  const bin = join(prefix, "bin", "cf-metrics");
  await symlink(join("..", "lib", "node_modules", "@saptools", "cf-metrics", "dist", "cli.js"), bin);
  return { prefix, packageDir, bin };
}

/** Variables the test runner itself may carry that would silently switch the updater off. */
const RUNNER_NOISE = new Set(["CI", "NODE_ENV", "NO_UPDATE_NOTIFIER", "SAPTOOLS_SELF_UPDATE_REEXEC", "SAPTOOLS_AUTO_UPDATE", "CF_METRICS_AUTO_UPDATE"]);

function withoutKeys(env: NodeJS.ProcessEnv, keys: ReadonlySet<string>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key)));
}

/**
 * The environment of an installed CLI whose updates are on and pointed at the
 * fake registry; `extra` wins over everything, `remove` drops keys from the
 * final result (to observe the default policy).
 */
function updateEnv(extra: Record<string, string> = {}, remove: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...withoutKeys(process.env, RUNNER_NOISE),
    HOME: join(root, "home"),
    SAPTOOLS_AUTO_UPDATE: "on",
    SAPTOOLS_NPM_REGISTRY: registry?.url ?? "http://127.0.0.1:9",
    SAPTOOLS_ROOT: join(root, "saptools"),
    CF_METRICS_SAPTOOLS_ROOT: join(root, "saptools"),
    CF_METRICS_CREDENTIAL_CACHE: "0",
    CF_METRICS_CF_BIN: FAKE_CF_PATH,
    npm_config_cache: join(root, "npm-cache"),
    ...extra,
  };
  return withoutKeys(env, new Set(remove));
}

function runAt(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function versionAt(packageDir: string): Promise<string> {
  return (JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { version: string }).version;
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "saptools", "updates", "saptools__cf-metrics.json"), "utf8")) as Record<string, unknown>;
}

function stubOutput(stdout: string): { version: string; argv: string[]; reexec: string } | undefined {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("STUB "));
  return line === undefined ? undefined : (JSON.parse(line.slice("STUB ".length)) as { version: string; argv: string[]; reexec: string });
}

test.beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "cf-metrics-update-work-")));
  installedVersion = (JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version;
  stubTarball = await buildStubTarball(NEXT_VERSION);
});

test.afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cf-metrics-update-")));
  await mkdir(join(root, "home"));
});

test.afterEach(async () => {
  await registry?.close();
  registry = undefined;
  await rm(root, { recursive: true, force: true });
});

test("a newer release is installed with npm from the registry and the command re-runs on it with the same arguments", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const copy = await installedCopy();

  const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());

  expect(result.stderr).toContain(`cf-metrics: updating ${installedVersion} -> ${NEXT_VERSION} ...`);
  expect(result.stderr).toContain(`cf-metrics: updated to ${NEXT_VERSION}; re-running the command`);
  expect(stubOutput(result.stdout)).toEqual({ version: NEXT_VERSION, argv: ["credential", "list", "--format", "json"], reexec: "1" });
  expect(result.exitCode).toBe(7);

  expect(await versionAt(copy.packageDir)).toBe(NEXT_VERSION);
  const paths = registry.requests.map((request) => request.path);
  expect(paths).toContain(`/-/package/${PACKAGE_NAME}/dist-tags`);
  expect(paths).toContain(`/${PACKAGE_NAME}`);
  expect(paths.some((path) => path.startsWith("/tarballs/"))).toBe(true);
  expect(registry.requests[0]?.userAgent).toBe(`cf-metrics/${installedVersion} saptools-self-update`);
  expect(await readState()).toMatchObject({ version: 1, latest: NEXT_VERSION, lastInstall: { version: NEXT_VERSION, ok: true } });
  await expect(readdir(join(root, "saptools", "updates"))).resolves.toEqual(["saptools__cf-metrics.json"]);
});

test("an up-to-date install runs the command untouched, remembers the check, and stays offline for the next hour", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: installedVersion });
  const copy = await installedCopy();

  const first = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe("");
  expect(JSON.parse(first.stdout)).toEqual([]);
  expect(registry.requests).toHaveLength(1);
  expect(await readState()).toMatchObject({ latest: installedVersion });

  const second = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());
  expect(second.exitCode).toBe(0);
  expect(registry.requests).toHaveLength(1);
});

test("an unreachable registry never gets in the way and is not retried on every command", async () => {
  const copy = await installedCopy();
  const env = updateEnv({ SAPTOOLS_NPM_REGISTRY: "http://127.0.0.1:9", SAPTOOLS_UPDATE_DEBUG: "1" });

  const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], env);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("cf-metrics: [self-update] registry check failed");
  expect(result.stderr).not.toContain("updating");
  const state = await readState();
  expect(typeof state["lastFailureAt"]).toBe("string");

  const again = await runAt(copy.bin, ["credential", "list", "--format", "json"], env);
  expect(again.stderr).toContain("skipping the registry check after a recent failure");
});

test("SAPTOOLS_AUTO_UPDATE=notify announces the release with the manual command and installs nothing", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const copy = await installedCopy();

  const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv({ SAPTOOLS_AUTO_UPDATE: "notify" }));
  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe(
    `cf-metrics: ${NEXT_VERSION} is available (installed ${installedVersion}) but was not installed: SAPTOOLS_AUTO_UPDATE is notify. Run: npm install -g ${PACKAGE_NAME}@${NEXT_VERSION}`,
  );
  expect(await versionAt(copy.packageDir)).toBe(installedVersion);
  expect(registry.requests.map((request) => request.path)).toEqual([`/-/package/${PACKAGE_NAME}/dist-tags`]);

  const again = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv({ SAPTOOLS_AUTO_UPDATE: "notify" }));
  expect(again.stderr).toBe("");
});

test("off, a CI environment, and the re-exec marker each make no request and leave no state behind", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const copy = await installedCopy();

  const variants: Record<string, NodeJS.ProcessEnv> = {
    "SAPTOOLS_AUTO_UPDATE=off": updateEnv({ SAPTOOLS_AUTO_UPDATE: "off" }),
    "CF_METRICS_AUTO_UPDATE=off beats the global on": updateEnv({ CF_METRICS_AUTO_UPDATE: "off" }),
    "CI=true with no explicit policy": updateEnv({ CI: "true" }, ["SAPTOOLS_AUTO_UPDATE"]),
    "re-exec marker set": updateEnv({ SAPTOOLS_SELF_UPDATE_REEXEC: "1" }),
  };
  for (const [label, env] of Object.entries(variants)) {
    const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], env);
    expect(result.exitCode, label).toBe(0);
    expect(result.stderr, label).toBe("");
    expect(await versionAt(copy.packageDir), label).toBe(installedVersion);
  }
  expect(registry.requests).toEqual([]);
  await expect(readdir(join(root, "saptools"))).rejects.toThrow();
});

test("a checkout or linked package is never upgraded, even with updates forced on", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const result = await runAt(CLI_PATH, ["credential", "list", "--format", "json"], updateEnv({ SAPTOOLS_UPDATE_DEBUG: "1" }));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("source checkout");
  expect(registry.requests).toEqual([]);
});

test("a failed install keeps the current version running and is not retried before a day has passed", async () => {
  // A 404 fails npm fast; a 5xx would make it retry with backoff for over a minute.
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball, tarballStatus: 404 });
  const copy = await installedCopy();

  const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain(`cf-metrics: updating ${installedVersion} -> ${NEXT_VERSION} ...`);
  expect(result.stderr).toContain(`cf-metrics: update to ${NEXT_VERSION} failed (`);
  expect(result.stderr).toContain(`continuing with ${installedVersion}. Run: npm install -g ${PACKAGE_NAME}@${NEXT_VERSION}`);
  expect(await versionAt(copy.packageDir)).toBe(installedVersion);
  expect(await readState()).toMatchObject({ lastInstall: { version: NEXT_VERSION, ok: false } });
  const tarballRequests = registry.requests.filter((request) => request.path.startsWith("/tarballs/")).length;
  expect(tarballRequests).toBeGreaterThan(0);

  const again = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());
  expect(again.exitCode).toBe(0);
  expect(again.stderr).toContain("but was not installed: the previous attempt failed (");
  expect(registry.requests.filter((request) => request.path.startsWith("/tarballs/")).length).toBe(tarballRequests);
});

test("another instance holding the lock makes this one step aside silently", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const copy = await installedCopy();
  await mkdir(join(root, "saptools", "updates"), { recursive: true });
  await writeFile(join(root, "saptools", "updates", "saptools__cf-metrics.lock"), JSON.stringify({ pid: 1, at: new Date().toISOString() }));

  const result = await runAt(copy.bin, ["credential", "list", "--format", "json"], updateEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(await versionAt(copy.packageDir)).toBe(installedVersion);
});

test("self-update --check reports without installing; self-update installs without re-running", async () => {
  registry = await startFakeRegistry({ packageName: PACKAGE_NAME, latest: NEXT_VERSION, tarball: stubTarball });
  const copy = await installedCopy();

  const check = await runAt(copy.bin, ["self-update", "--check"], updateEnv({}, ["SAPTOOLS_AUTO_UPDATE"]));
  expect(check.exitCode).toBe(0);
  expect(check.stdout).toContain(`package=${PACKAGE_NAME}`);
  expect(check.stdout).toContain(`installed=${installedVersion}`);
  expect(check.stdout).toContain(`latest=${NEXT_VERSION}`);
  expect(check.stdout).toContain("policy=on (default)");
  expect(check.stdout).toContain(`install=npm-global ${copy.packageDir}`);
  expect(check.stdout).toContain(`registry=${registry.url}`);
  expect(check.stdout.trim().endsWith("result=update-available")).toBe(true);
  expect(await versionAt(copy.packageDir)).toBe(installedVersion);

  const install = await runAt(copy.bin, ["self-update"], updateEnv({ SAPTOOLS_AUTO_UPDATE: "off" }));
  expect(install.exitCode).toBe(0);
  expect(install.stdout.trim().endsWith(`result=updated ${installedVersion} -> ${NEXT_VERSION}`)).toBe(true);
  expect(install.stderr).toContain(`cf-metrics: updated to ${NEXT_VERSION}`);
  expect(stubOutput(install.stdout)).toBeUndefined();
  expect(await versionAt(copy.packageDir)).toBe(NEXT_VERSION);
});
