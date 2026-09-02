import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnLike } from "../../src/self-update/process-types.js";
import type { ReexecRequest } from "../../src/self-update/reexec.js";
import { inspectSelfUpdate, runSelfUpdate } from "../../src/self-update/run.js";
import type { SelfUpdateOptions, SelfUpdateRuntime } from "../../src/self-update/run.js";
import { acquireUpdateLock, readUpdateState, updateLockPath, updateStatePath } from "../../src/self-update/state.js";

const NAME = "@saptools/demo";
const REGISTRY = "https://registry.example";
const NOW = new Date("2026-09-02T10:00:00.000Z");

let root: string;
let prefix: string;
let packageDirectory: string;
let bin: string;

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

interface Harness {
  readonly options: SelfUpdateOptions;
  readonly runtime: Partial<SelfUpdateRuntime>;
  readonly notices: string[];
  readonly fetchCalls: string[];
  readonly installs: { file: string; args: readonly string[] }[];
  readonly reexecs: ReexecRequest[];
}

interface HarnessConfig {
  readonly latest?: string | Error;
  readonly installBehaviour?: "succeed" | "fail" | "stale";
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: Date;
  readonly reexecError?: Error;
  readonly options?: Partial<SelfUpdateOptions>;
}

function installedVersion(): string {
  return (JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { version: string }).version;
}

function harness(config: HarnessConfig = {}): Harness {
  const notices: string[] = [];
  const fetchCalls: string[] = [];
  const installs: { file: string; args: readonly string[] }[] = [];
  const reexecs: ReexecRequest[] = [];
  const latest = config.latest ?? "0.7.0";
  const fetchImpl: typeof fetch = (input) => {
    fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return latest instanceof Error ? Promise.reject(latest) : Promise.resolve(new Response(JSON.stringify({ latest }), { status: 200 }));
  };
  const spawnImpl: SpawnLike = (file, args) => {
    installs.push({ file, args });
    const child = new FakeChild();
    queueMicrotask(() => {
      const behaviour = config.installBehaviour ?? "succeed";
      if (behaviour === "fail") {
        child.stderr.emit("data", "npm error EACCES\n");
        child.emit("close", 1, null);
        return;
      }
      if (behaviour === "succeed") {
        writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: NAME, version: typeof latest === "string" ? latest : "0.0.0" }));
      }
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return {
    notices,
    fetchCalls,
    installs,
    reexecs,
    options: {
      packageName: NAME,
      currentVersion: "0.6.0",
      binName: "demo",
      envPrefix: "DEMO",
      notice: (line) => {
        notices.push(line);
      },
      ...config.options,
    },
    runtime: {
      env: { SAPTOOLS_ROOT: root, SAPTOOLS_NPM_REGISTRY: REGISTRY, ...config.env },
      argv: config.argv ?? ["/usr/bin/node", bin, "names", "--json"],
      execPath: "/usr/bin/node",
      execArgv: [],
      platform: "linux",
      homeDirectory: join(root, "home"),
      now: () => config.now ?? NOW,
      fetchImpl,
      spawnImpl,
      reexecImpl: (request) => {
        reexecs.push(request);
        return config.reexecError === undefined ? Promise.resolve() : Promise.reject(config.reexecError);
      },
      exists: () => false,
      checkTimeoutMs: 500,
      installTimeoutMs: 500,
    },
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "core-run-")));
  prefix = join(root, "prefix");
  packageDirectory = join(prefix, "lib", "node_modules", "@saptools", "demo");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await mkdir(join(prefix, "bin"));
  await mkdir(join(root, "home"));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: NAME, version: "0.6.0" }));
  await writeFile(join(packageDirectory, "dist", "cli.js"), "");
  bin = join(prefix, "bin", "demo");
  await symlink(join(packageDirectory, "dist", "cli.js"), bin);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("runSelfUpdate: nothing to do", () => {
  it("reports current when the registry has no newer release, and remembers the check", async () => {
    const h = harness({ latest: "0.6.0" });
    expect(await runSelfUpdate(h.options, h.runtime)).toEqual({ kind: "current", latest: "0.6.0" });
    expect(h.fetchCalls).toEqual([`${REGISTRY}/-/package/${encodeURIComponent(NAME)}/dist-tags`]);
    expect(h.notices).toEqual([]);
    expect(readUpdateState(updateStatePath(root, NAME))).toEqual({ version: 1, checkedAt: NOW.toISOString(), latest: "0.6.0" });
  });

  it("reuses a fresh cached answer without touching the network, and re-checks once the interval has passed", async () => {
    const first = harness({ latest: "0.6.0" });
    await runSelfUpdate(first.options, first.runtime);
    const cached = harness({ latest: "0.7.0", now: new Date(NOW.getTime() + 59 * 60_000) });
    expect(await runSelfUpdate(cached.options, cached.runtime)).toEqual({ kind: "current", latest: "0.6.0" });
    expect(cached.fetchCalls).toEqual([]);
    const later = harness({ latest: "0.7.0", now: new Date(NOW.getTime() + 61 * 60_000) });
    const outcome = await runSelfUpdate(later.options, later.runtime);
    expect(later.fetchCalls).toHaveLength(1);
    expect(outcome.kind).toBe("updated");
  });

  it("checks on every run when the interval is zero", async () => {
    const first = harness({ latest: "0.6.0", env: { SAPTOOLS_UPDATE_INTERVAL_MINUTES: "0" } });
    await runSelfUpdate(first.options, first.runtime);
    const second = harness({ latest: "0.6.0", env: { SAPTOOLS_UPDATE_INTERVAL_MINUTES: "0" } });
    await runSelfUpdate(second.options, second.runtime);
    expect(second.fetchCalls).toHaveLength(1);
  });

  it("is off, silent and file-free when disabled or when running from a checkout", async () => {
    const off = harness({ env: { SAPTOOLS_AUTO_UPDATE: "off" } });
    expect(await runSelfUpdate(off.options, off.runtime)).toEqual({ kind: "skipped", reason: "SAPTOOLS_AUTO_UPDATE is off" });
    expect(off.fetchCalls).toEqual([]);
    expect(existsSync(join(root, "updates"))).toBe(false);

    const checkout = join(root, "repo", "packages", "demo");
    await mkdir(join(checkout, "dist"), { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: NAME, version: "0.6.0" }));
    await writeFile(join(checkout, "dist", "cli.js"), "");
    const local = harness({ argv: ["/usr/bin/node", join(checkout, "dist", "cli.js"), "names"] });
    const outcome = await runSelfUpdate(local.options, local.runtime);
    expect(outcome.kind).toBe("skipped");
    expect(outcome.kind === "skipped" ? outcome.reason : "").toContain("source checkout");
    expect(local.fetchCalls).toEqual([]);
  });

  it("swallows a registry failure, records it, and backs off for a while", async () => {
    const failing = harness({ latest: new Error("ECONNREFUSED") });
    expect(await runSelfUpdate(failing.options, failing.runtime)).toEqual({ kind: "skipped", reason: "the latest version is unknown" });
    const state = readUpdateState(updateStatePath(root, NAME));
    expect(state.lastFailureAt).toBe(NOW.toISOString());
    expect(state.lastFailureReason).toContain("ECONNREFUSED");

    const soon = harness({ latest: "0.7.0", now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(await runSelfUpdate(soon.options, soon.runtime)).toEqual({ kind: "skipped", reason: "the latest version is unknown" });
    expect(soon.fetchCalls).toEqual([]);

    const later = harness({ latest: "0.7.0", now: new Date(NOW.getTime() + 16 * 60_000) });
    expect((await runSelfUpdate(later.options, later.runtime)).kind).toBe("updated");
    expect(readUpdateState(updateStatePath(root, NAME)).lastFailureAt).toBeUndefined();
  });

  it("never throws: an unexpected error becomes a skip, with the reason on stderr only in debug mode", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const explode = (): boolean => {
      throw new TypeError("boom");
    };
    const quiet = harness();
    expect(await runSelfUpdate(quiet.options, { ...quiet.runtime, isWritable: explode })).toEqual({ kind: "skipped", reason: "boom" });
    expect(write).not.toHaveBeenCalled();

    const debug = harness({ env: { SAPTOOLS_UPDATE_DEBUG: "1" } });
    expect(await runSelfUpdate(debug.options, { ...debug.runtime, isWritable: explode })).toEqual({ kind: "skipped", reason: "boom" });
    expect(write).toHaveBeenCalledWith("demo: [self-update] boom\n");
  });
});

describe("runSelfUpdate: a newer release exists", () => {
  it("installs the exact version, verifies it, announces both steps, and re-runs the same command", async () => {
    const h = harness();
    const outcome = await runSelfUpdate(h.options, h.runtime);
    expect(outcome).toEqual({ kind: "updated", from: "0.6.0", to: "0.7.0" });
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]?.file).toBe("npm");
    expect(h.installs[0]?.args).toEqual(["install", "--global", "--prefix", prefix, "@saptools/demo@0.7.0", "--registry", REGISTRY, "--no-fund", "--no-audit", "--no-update-notifier", "--loglevel=error"]);
    expect(h.notices).toEqual(["updating 0.6.0 -> 0.7.0 ...", "updated to 0.7.0; re-running the command"]);
    expect(h.reexecs).toEqual([{ execPath: "/usr/bin/node", execArgv: [], binPath: bin, args: ["names", "--json"], env: h.runtime.env }]);
    expect(installedVersion()).toBe("0.7.0");
    expect(readUpdateState(updateStatePath(root, NAME)).lastInstall).toEqual({ version: "0.7.0", at: NOW.toISOString(), ok: true });
    expect(existsSync(updateLockPath(updateStatePath(root, NAME)))).toBe(false);
  });

  it("skips the re-run when asked not to, for the manual command", async () => {
    const h = harness({ options: { reexec: false, manual: true } });
    expect(await runSelfUpdate(h.options, h.runtime)).toEqual({ kind: "updated", from: "0.6.0", to: "0.7.0" });
    expect(h.reexecs).toEqual([]);
    expect(h.notices.at(-1)).toBe("updated to 0.7.0");
  });

  it("keeps the command running on the old version when the install fails, and does not retry for a day", async () => {
    const h = harness({ installBehaviour: "fail" });
    const outcome = await runSelfUpdate(h.options, h.runtime);
    expect(outcome).toEqual({ kind: "failed", latest: "0.7.0", reason: "npm install -g @saptools/demo@0.7.0 exited with code 1: npm error EACCES" });
    expect(h.notices[1]).toBe("update to 0.7.0 failed (npm install -g @saptools/demo@0.7.0 exited with code 1: npm error EACCES); continuing with 0.6.0. Run: npm install -g @saptools/demo@0.7.0");
    expect(h.reexecs).toEqual([]);
    expect(installedVersion()).toBe("0.6.0");

    const retry = harness({ now: new Date(NOW.getTime() + 60 * 60_000 + 1) });
    const second = await runSelfUpdate(retry.options, retry.runtime);
    expect(second.kind).toBe("notified");
    expect(retry.installs).toEqual([]);
    expect(retry.notices).toEqual(["0.7.0 is available (installed 0.6.0) but was not installed: the previous attempt failed (npm install -g @saptools/demo@0.7.0 exited with code 1: npm error EACCES). Run: npm install -g @saptools/demo@0.7.0"]);

    const nextDay = harness({ now: new Date(NOW.getTime() + 25 * 60 * 60_000) });
    expect((await runSelfUpdate(nextDay.options, nextDay.runtime)).kind).toBe("updated");
  });

  it("treats an install that left the old files in place as a failure", async () => {
    const h = harness({ installBehaviour: "stale" });
    const outcome = await runSelfUpdate(h.options, h.runtime);
    expect(outcome).toEqual({ kind: "failed", latest: "0.7.0", reason: "the installed version is 0.6.0, not 0.7.0" });
    expect(h.reexecs).toEqual([]);
  });

  it("only notifies under the notify policy, once per version per day", async () => {
    const h = harness({ env: { SAPTOOLS_AUTO_UPDATE: "notify" } });
    expect(await runSelfUpdate(h.options, h.runtime)).toEqual({ kind: "notified", latest: "0.7.0", reason: "SAPTOOLS_AUTO_UPDATE is notify" });
    expect(h.notices).toEqual(["0.7.0 is available (installed 0.6.0) but was not installed: SAPTOOLS_AUTO_UPDATE is notify. Run: npm install -g @saptools/demo@0.7.0"]);
    expect(h.installs).toEqual([]);

    const again = harness({ env: { SAPTOOLS_AUTO_UPDATE: "notify" }, now: new Date(NOW.getTime() + 2 * 60 * 60_000) });
    expect((await runSelfUpdate(again.options, again.runtime)).kind).toBe("notified");
    expect(again.notices).toEqual([]);

    const newer = harness({ latest: "0.8.0", env: { SAPTOOLS_AUTO_UPDATE: "notify" }, now: new Date(NOW.getTime() + 3 * 60 * 60_000) });
    await runSelfUpdate(newer.options, newer.runtime);
    expect(newer.notices).toHaveLength(1);
    expect(newer.notices[0]).toContain("0.8.0 is available");
  });

  it("notifies instead of installing when the install directory is read-only", async () => {
    const h = harness();
    const outcome = await runSelfUpdate(h.options, { ...h.runtime, isWritable: () => false });
    expect(outcome).toEqual({ kind: "notified", latest: "0.7.0", reason: "the install directory is not writable by this user" });
    expect(h.installs).toEqual([]);
  });

  it("steps aside when another process holds the update lock", async () => {
    const lock = acquireUpdateLock(updateLockPath(updateStatePath(root, NAME)), NOW);
    const h = harness();
    expect(await runSelfUpdate(h.options, h.runtime)).toEqual({ kind: "skipped", reason: "another process is installing the update" });
    expect(h.installs).toEqual([]);
    lock?.release();
  });

  it("continues on the loaded version when the re-run itself cannot start", async () => {
    const h = harness({ reexecError: new Error("spawn EAGAIN") });
    expect(await runSelfUpdate(h.options, h.runtime)).toEqual({ kind: "updated", from: "0.6.0", to: "0.7.0" });
    expect(h.notices.at(-1)).toBe("could not re-run on 0.7.0 (spawn EAGAIN); continuing with the already loaded 0.6.0");
  });

  it("ignores the interval and the exclusions in manual mode", async () => {
    const seed = harness({ latest: "0.6.0" });
    await runSelfUpdate(seed.options, seed.runtime);
    const manual = harness({ options: { manual: true, reexec: false, commandPath: "self-update" }, env: { CI: "true" } });
    expect((await runSelfUpdate(manual.options, manual.runtime)).kind).toBe("updated");
    expect(manual.fetchCalls).toHaveLength(1);
  });
});

describe("inspectSelfUpdate", () => {
  it("reports the install, the policy, the registry and the fresh latest version", async () => {
    const h = harness({ env: { SAPTOOLS_AUTO_UPDATE: "notify" } });
    const status = await inspectSelfUpdate(h.options, h.runtime);
    expect(status).toMatchObject({
      packageName: NAME,
      installed: "0.6.0",
      latest: "0.7.0",
      checkError: undefined,
      registryUrl: REGISTRY,
      statePath: updateStatePath(root, NAME),
      policy: { policy: "notify", explicit: true },
      location: { kind: "npm-global", prefix },
    });
  });

  it("carries the registry error instead of a version when the check fails", async () => {
    const h = harness({ latest: new Error("offline") });
    const status = await inspectSelfUpdate(h.options, h.runtime);
    expect(status.latest).toBeUndefined();
    expect(status.checkError).toContain("offline");
  });
});
