import { cfEnableSsh, cfRestartApp, cfSshEnabled } from "./cf.js";
import { CfExplorerError } from "./errors.js";
import { explorerHome } from "./paths.js";
import { withPreparedCfSession } from "./runner.js";
import { markSessionsStaleForTarget } from "./storage.js";
import { normalizeTarget, resolveProcessName } from "./target.js";
import type { ExplorerMeta, LifecycleOptions, LifecycleResult } from "./types.js";

function requireLifecycleConfirmation(action: string, confirmImpact: boolean | undefined): void {
  if (confirmImpact === true) {
    return;
  }
  throw new CfExplorerError(
    "LIFECYCLE_CONFIRMATION_REQUIRED",
    `${action} can affect the running app. Pass confirmImpact: true or use --yes.`,
  );
}

function buildLifecycleMeta(
  options: LifecycleOptions,
  processName: string,
  startedAt: number,
  truncated: boolean,
): ExplorerMeta {
  return {
    target: normalizeTarget(options.target),
    process: processName,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

export async function sshStatus(options: LifecycleOptions): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const processName = resolveLifecycleProcess(options);
  const target = normalizeTarget(options.target);
  const enabled = await withPreparedCfSession(target, options.runtime, async (context) => {
    return await cfSshEnabled(target, context);
  });
  return {
    meta: buildLifecycleMeta(options, processName, startedAt, false),
    changed: false,
    status: enabled ? "enabled" : "disabled",
    message: enabled ? "SSH is enabled for the app." : "SSH is disabled for the app.",
  };
}

export async function enableSsh(options: LifecycleOptions): Promise<LifecycleResult> {
  const processName = resolveLifecycleProcess(options);
  requireLifecycleConfirmation("enable-ssh", options.confirmImpact);
  const startedAt = Date.now();
  const target = normalizeTarget(options.target);
  await withPreparedCfSession(target, options.runtime, async (context) => {
    await cfEnableSsh(target, context);
  });
  return {
    meta: buildLifecycleMeta(options, processName, startedAt, false),
    changed: true,
    status: "enabled",
    message: "SSH has been enabled for the app.",
  };
}

export async function restartApp(options: LifecycleOptions): Promise<LifecycleResult> {
  const processName = resolveLifecycleProcess(options);
  requireLifecycleConfirmation("restart", options.confirmImpact);
  const startedAt = Date.now();
  const target = normalizeTarget(options.target);
  await withPreparedCfSession(target, options.runtime, async (context) => {
    await cfRestartApp(target, context);
  });
  await invalidateSessions(options, "App restart invalidated the SSH session.");
  return {
    meta: buildLifecycleMeta(options, processName, startedAt, false),
    changed: true,
    status: "restarted",
    message: "App restart completed and matching explorer sessions were marked stale.",
  };
}

export async function prepareSsh(options: LifecycleOptions): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const processName = resolveLifecycleProcess(options);
  const target = normalizeTarget(options.target);
  const changed = await withPreparedCfSession(target, options.runtime, async (context) => {
    const enabled = await cfSshEnabled(target, context);
    if (enabled) {
      return false;
    }
    requireLifecycleConfirmation("prepare-ssh", options.confirmImpact);
    await cfEnableSsh(target, context);
    await cfRestartApp(target, context);
    return true;
  });
  if (changed) {
    await invalidateSessions(options, "prepare-ssh restarted the app.");
  }
  return {
    meta: buildLifecycleMeta(options, processName, startedAt, false),
    changed,
    status: changed ? "prepared" : "already-enabled",
    message: changed
      ? "SSH was enabled and the app was restarted."
      : "SSH was already enabled for the app.",
  };
}

async function invalidateSessions(options: LifecycleOptions, message: string): Promise<void> {
  const homeDir = options.runtime?.homeDir ?? explorerHome(options.runtime?.env);
  await markSessionsStaleForTarget(homeDir, normalizeTarget(options.target), message);
}

function resolveLifecycleProcess(options: LifecycleOptions): string {
  if (options.allInstances === true || options.instance !== undefined) {
    throw new CfExplorerError("UNSAFE_INPUT", "Lifecycle commands are app-level; omit instance selectors.");
  }
  return resolveProcessName(options.process);
}
