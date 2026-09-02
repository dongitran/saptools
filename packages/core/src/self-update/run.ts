import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { readPackageManifest } from "../package-metadata.js";
import { errorMessage } from "../records.js";
import { resolveSaptoolsRoot } from "../saptools-paths.js";

import { detectInstallLocation } from "./install-location.js";
import type { InstallLocation } from "./install-location.js";
import { buildInstallCommand, DEFAULT_INSTALL_TIMEOUT_MS, manualInstallCommand, runInstall } from "./installer.js";
import { DEBUG_ENV, isTruthyFlag, resolveCheckIntervalMs, resolveUpdatePolicy } from "./policy.js";
import type { PolicyDecision } from "./policy.js";
import type { SpawnLike } from "./process-types.js";
import { reexecProcess } from "./reexec.js";
import type { ReexecImpl } from "./reexec.js";
import { DEFAULT_CHECK_TIMEOUT_MS, fetchLatestVersion, readUserNpmrc, resolveRegistryUrl } from "./registry.js";
import { isNewerRelease } from "./semver.js";
import {
  acquireUpdateLock,
  clearFailure,
  EMPTY_UPDATE_STATE,
  readUpdateState,
  updateLockPath,
  updateStatePath,
  writeUpdateState,
} from "./state.js";
import type { UpdateState } from "./state.js";

export interface SelfUpdateOptions {
  /** npm package name, e.g. `@saptools/cf-metrics`. */
  readonly packageName: string;
  /** The running version, read from package.json (see readPackageMetadata). */
  readonly currentVersion: string;
  /** Executable name used as the prefix of every notice, e.g. `cf-metrics`. */
  readonly binName: string;
  /** Per-package override namespace: `CF_METRICS` honours `CF_METRICS_AUTO_UPDATE`. */
  readonly envPrefix?: string;
  /** Space-joined command paths that must never trigger an update (internal workers, daemons). */
  readonly skipCommands?: readonly string[];
  /** The command being run, supplied by the commander hook. */
  readonly commandPath?: string;
  readonly saptoolsRoot?: string;
  /** Where notices go; defaults to `<binName>: <line>` on stderr. Never stdout. */
  readonly notice?: (line: string) => void;
  /** The explicit `self-update` command: ignore the check interval, backoffs and policy gates. */
  readonly manual?: boolean;
  /** Re-run the command on the new version after installing (default true). */
  readonly reexec?: boolean;
}

export interface SelfUpdateRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
  readonly spawnImpl: SpawnLike;
  readonly reexecImpl: ReexecImpl;
  readonly checkTimeoutMs: number;
  readonly installTimeoutMs: number;
  readonly realpath?: (path: string) => string;
  readonly isWritable?: (path: string) => boolean;
  readonly exists?: (path: string) => boolean;
}

export type SelfUpdateOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "current"; readonly latest: string }
  | { readonly kind: "notified"; readonly latest: string; readonly reason: string }
  | { readonly kind: "updated"; readonly from: string; readonly to: string }
  | { readonly kind: "failed"; readonly latest: string; readonly reason: string };

export interface SelfUpdateStatus {
  readonly packageName: string;
  readonly installed: string;
  readonly location: InstallLocation;
  readonly policy: PolicyDecision;
  readonly registryUrl: string;
  readonly statePath: string;
  readonly latest: string | undefined;
  readonly checkError: string | undefined;
}

/** After a failed registry call, stay quiet this long instead of paying the timeout on every command. */
const FAILURE_BACKOFF_MS = 15 * 60_000;
/** A version we already announced is not announced again for a day. */
const NOTIFY_INTERVAL_MS = 24 * 60 * 60_000;
/** A version whose install failed is not retried for a day; the notice carries the manual command instead. */
const INSTALL_RETRY_BACKOFF_MS = 24 * 60 * 60_000;

interface Context {
  readonly options: SelfUpdateOptions;
  readonly runtime: SelfUpdateRuntime;
  readonly binPath: string;
  readonly location: InstallLocation;
  readonly decision: PolicyDecision;
  readonly registryUrl: string;
  readonly statePath: string;
  readonly intervalMs: number;
  state: UpdateState;
  readonly notice: (line: string) => void;
  readonly debug: (line: string) => void;
}

function defaultRuntime(): SelfUpdateRuntime {
  return {
    env: process.env,
    argv: process.argv,
    execPath: process.execPath,
    execArgv: process.execArgv,
    platform: process.platform,
    homeDirectory: homedir(),
    now: (): Date => new Date(),
    fetchImpl: fetch,
    spawnImpl: spawn,
    reexecImpl: reexecProcess,
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
  };
}

function ageMs(isoTimestamp: string, nowMs: number): number {
  const then = Date.parse(isoTimestamp);
  // A timestamp in the future means the clock moved backwards; treat it as stale so the state self-heals.
  return Number.isNaN(then) || then > nowMs ? Number.POSITIVE_INFINITY : nowMs - then;
}

function detectLocation(options: SelfUpdateOptions, runtime: SelfUpdateRuntime, binPath: string): InstallLocation {
  return detectInstallLocation({
    binPath,
    packageName: options.packageName,
    platform: runtime.platform,
    env: runtime.env,
    ...(runtime.realpath === undefined ? {} : { realpath: runtime.realpath }),
    ...(runtime.isWritable === undefined ? {} : { isWritable: runtime.isWritable }),
  });
}

function createContext(options: SelfUpdateOptions, runtime: SelfUpdateRuntime): Context {
  const { env } = runtime;
  const binPath = runtime.argv[1] ?? "";
  const location = detectLocation(options, runtime, binPath);
  const decision = resolveUpdatePolicy({
    env,
    location,
    skipCommands: options.skipCommands ?? [],
    manual: options.manual === true,
    ...(options.envPrefix === undefined ? {} : { envPrefix: options.envPrefix }),
    ...(options.commandPath === undefined ? {} : { commandPath: options.commandPath }),
  });
  const statePath = updateStatePath(resolveSaptoolsRoot(options.saptoolsRoot, env), options.packageName);
  const notice =
    options.notice ??
    ((line: string): void => {
      process.stderr.write(`${options.binName}: ${line}\n`);
    });
  const debug = isTruthyFlag(env[DEBUG_ENV])
    ? (line: string): void => {
        process.stderr.write(`${options.binName}: [self-update] ${line}\n`);
      }
    : (): void => {
        // Debug output is off unless SAPTOOLS_UPDATE_DEBUG is set.
      };
  return {
    options,
    runtime,
    binPath,
    location,
    decision,
    registryUrl: resolveRegistryUrl(env, readUserNpmrc(runtime.homeDirectory)),
    statePath,
    intervalMs: resolveCheckIntervalMs(env),
    // Loaded lazily in resolveLatest: a disabled run must not touch ~/.saptools at all.
    state: EMPTY_UPDATE_STATE,
    notice,
    debug,
  };
}

function saveState(ctx: Context): void {
  try {
    writeUpdateState(ctx.statePath, ctx.state);
  } catch (error) {
    ctx.debug(`cannot write ${ctx.statePath}: ${errorMessage(error)}`);
  }
}

/** The newest published version: from the state file while it is fresh, otherwise from the registry. */
async function resolveLatest(ctx: Context): Promise<string | undefined> {
  ctx.state = readUpdateState(ctx.statePath);
  const { state } = ctx;
  const nowMs = ctx.runtime.now().getTime();
  if (ctx.options.manual !== true) {
    if (state.latest !== undefined && state.checkedAt !== undefined && ageMs(state.checkedAt, nowMs) < ctx.intervalMs) {
      ctx.debug(`using cached latest ${state.latest} (checked ${state.checkedAt})`);
      return state.latest;
    }
    if (state.lastFailureAt !== undefined && ageMs(state.lastFailureAt, nowMs) < FAILURE_BACKOFF_MS) {
      ctx.debug(`skipping the registry check after a recent failure: ${state.lastFailureReason ?? "unknown"}`);
      return state.latest;
    }
  }
  const result = await fetchLatestVersion(ctx.options.packageName, ctx.registryUrl, {
    fetchImpl: ctx.runtime.fetchImpl,
    timeoutMs: ctx.runtime.checkTimeoutMs,
    userAgent: `${ctx.options.binName}/${ctx.options.currentVersion} saptools-self-update`,
  });
  const at = ctx.runtime.now().toISOString();
  if (result.ok) {
    ctx.state = clearFailure({ ...ctx.state, checkedAt: at, latest: result.latest });
    saveState(ctx);
    return result.latest;
  }
  ctx.state = { ...ctx.state, lastFailureAt: at, lastFailureReason: result.reason };
  saveState(ctx);
  ctx.debug(`registry check failed: ${result.reason}`);
  return ctx.state.latest;
}

function notify(ctx: Context, latest: string, reason: string): SelfUpdateOutcome {
  const nowMs = ctx.runtime.now().getTime();
  const alreadyAnnounced =
    ctx.state.notifiedVersion === latest && ctx.state.notifiedAt !== undefined && ageMs(ctx.state.notifiedAt, nowMs) < NOTIFY_INTERVAL_MS;
  if (!alreadyAnnounced || ctx.options.manual === true) {
    const command = manualInstallCommand(ctx.location.kind, `${ctx.options.packageName}@${latest}`);
    ctx.notice(`${latest} is available (installed ${ctx.options.currentVersion}) but was not installed: ${reason}. Run: ${command}`);
    ctx.state = { ...ctx.state, notifiedVersion: latest, notifiedAt: ctx.runtime.now().toISOString() };
    saveState(ctx);
  }
  return { kind: "notified", latest, reason };
}

function recentInstallFailure(ctx: Context, latest: string): string | undefined {
  const attempt = ctx.state.lastInstall;
  if (ctx.options.manual === true || attempt === undefined || attempt.ok || attempt.version !== latest) {
    return;
  }
  if (ageMs(attempt.at, ctx.runtime.now().getTime()) >= INSTALL_RETRY_BACKOFF_MS) {
    return;
  }
  return `the previous attempt failed (${attempt.reason ?? "unknown reason"})`;
}

function recordInstall(ctx: Context, latest: string, ok: boolean, reason?: string): void {
  const at = ctx.runtime.now().toISOString();
  ctx.state = { ...ctx.state, lastInstall: reason === undefined ? { version: latest, at, ok } : { version: latest, at, ok, reason } };
  saveState(ctx);
}

async function installLatest(ctx: Context, latest: string): Promise<SelfUpdateOutcome | undefined> {
  const command = buildInstallCommand({
    location: ctx.location,
    packageName: ctx.options.packageName,
    version: latest,
    registryUrl: ctx.registryUrl,
    execPath: ctx.runtime.execPath,
    platform: ctx.runtime.platform,
    ...(ctx.runtime.exists === undefined ? {} : { exists: ctx.runtime.exists }),
    ...(ctx.runtime.realpath === undefined ? {} : { realpath: ctx.runtime.realpath }),
  });
  if (command === undefined) {
    return notify(ctx, latest, "no supported package manager was found for this install");
  }
  const lock = acquireUpdateLock(updateLockPath(ctx.statePath), ctx.runtime.now());
  if (lock === undefined) {
    ctx.debug("another process holds the update lock");
    return { kind: "skipped", reason: "another process is installing the update" };
  }
  try {
    ctx.notice(`updating ${ctx.options.currentVersion} -> ${latest} ...`);
    const result = await runInstall(command, { env: ctx.runtime.env, timeoutMs: ctx.runtime.installTimeoutMs, spawnImpl: ctx.runtime.spawnImpl });
    const installed = ctx.location.packageDirectory === undefined ? undefined : readPackageManifest(ctx.location.packageDirectory)?.version;
    const failure = result.ok ? (installed === latest ? undefined : `the installed version is ${installed ?? "unreadable"}, not ${latest}`) : result.reason;
    if (failure !== undefined) {
      recordInstall(ctx, latest, false, failure);
      ctx.notice(`update to ${latest} failed (${failure}); continuing with ${ctx.options.currentVersion}. Run: ${command.display}`);
      return { kind: "failed", latest, reason: failure };
    }
    recordInstall(ctx, latest, true);
  } finally {
    lock.release();
  }
  return;
}

async function upgrade(ctx: Context, latest: string): Promise<SelfUpdateOutcome> {
  const failed = await installLatest(ctx, latest);
  if (failed !== undefined) {
    return failed;
  }
  const outcome: SelfUpdateOutcome = { kind: "updated", from: ctx.options.currentVersion, to: latest };
  if (ctx.options.reexec === false) {
    ctx.notice(`updated to ${latest}`);
    return outcome;
  }
  ctx.notice(`updated to ${latest}; re-running the command`);
  try {
    await ctx.runtime.reexecImpl({
      execPath: ctx.runtime.execPath,
      execArgv: ctx.runtime.execArgv,
      binPath: ctx.binPath,
      args: ctx.runtime.argv.slice(2),
      env: ctx.runtime.env,
    });
  } catch (error) {
    ctx.notice(`could not re-run on ${latest} (${errorMessage(error)}); continuing with the already loaded ${ctx.options.currentVersion}`);
  }
  return outcome;
}

async function runSelfUpdateUnsafe(options: SelfUpdateOptions, runtime: SelfUpdateRuntime): Promise<SelfUpdateOutcome> {
  const ctx = createContext(options, runtime);
  if (ctx.decision.policy === "off") {
    ctx.debug(`off: ${ctx.decision.reason}`);
    return { kind: "skipped", reason: ctx.decision.reason };
  }
  const latest = await resolveLatest(ctx);
  if (latest === undefined) {
    return { kind: "skipped", reason: "the latest version is unknown" };
  }
  if (!isNewerRelease(latest, options.currentVersion)) {
    return { kind: "current", latest };
  }
  if (ctx.decision.policy === "notify") {
    return notify(ctx, latest, ctx.decision.reason);
  }
  const backoff = recentInstallFailure(ctx, latest);
  if (backoff !== undefined) {
    return notify(ctx, latest, backoff);
  }
  return await upgrade(ctx, latest);
}

/**
 * Check for, install, and re-run on a newer release. Never throws, never
 * writes to stdout, never prompts, never escalates privileges: whatever goes
 * wrong, the command the user asked for still runs on the installed version.
 */
export async function runSelfUpdate(options: SelfUpdateOptions, overrides: Partial<SelfUpdateRuntime> = {}): Promise<SelfUpdateOutcome> {
  const runtime: SelfUpdateRuntime = { ...defaultRuntime(), ...overrides };
  try {
    return await runSelfUpdateUnsafe(options, runtime);
  } catch (error) {
    const reason = errorMessage(error);
    if (isTruthyFlag(runtime.env[DEBUG_ENV])) {
      process.stderr.write(`${options.binName}: [self-update] ${reason}\n`);
    }
    return { kind: "skipped", reason };
  }
}

/** Everything the `self-update` command reports; performs one fresh registry check. */
export async function inspectSelfUpdate(options: SelfUpdateOptions, overrides: Partial<SelfUpdateRuntime> = {}): Promise<SelfUpdateStatus> {
  const runtime: SelfUpdateRuntime = { ...defaultRuntime(), ...overrides };
  const ctx = createContext({ ...options, manual: true }, runtime);
  const result = await fetchLatestVersion(options.packageName, ctx.registryUrl, {
    fetchImpl: runtime.fetchImpl,
    timeoutMs: runtime.checkTimeoutMs,
    userAgent: `${options.binName}/${options.currentVersion} saptools-self-update`,
  });
  return {
    packageName: options.packageName,
    installed: options.currentVersion,
    location: ctx.location,
    policy: resolveUpdatePolicy({
      env: runtime.env,
      location: ctx.location,
      ...(options.envPrefix === undefined ? {} : { envPrefix: options.envPrefix }),
    }),
    registryUrl: ctx.registryUrl,
    statePath: ctx.statePath,
    latest: result.ok ? result.latest : undefined,
    checkError: result.ok ? undefined : result.reason,
  };
}
