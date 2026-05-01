import { CfExplorerError } from "../core/errors.js";
import type { ExplorerMeta, LifecycleOptions, LifecycleResult } from "../core/types.js";
import { withPreparedCfSession } from "../discovery/runner.js";
import { explorerHome } from "../session/paths.js";
import { markSessionsStaleForTarget } from "../session/storage.js";

import { cfEnableSsh, cfRestartApp, cfSshEnabled, type CfRunOptions } from "./client.js";
import { normalizeTarget, resolveProcessName } from "./target.js";

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
    return await cfSshEnabled(target, context, effectiveRunLimits(options));
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
    await cfEnableSsh(target, context, effectiveRunLimits(options));
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
    await cfRestartApp(target, context, effectiveRunLimits(options));
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
    const limits = effectiveRunLimits(options);
    const enabled = await cfSshEnabled(target, context, limits);
    if (enabled) {
      return false;
    }
    requireLifecycleConfirmation("prepare-ssh", options.confirmImpact);
    await cfEnableSsh(target, context, limits);
    await cfRestartApp(target, context, limits);
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

function effectiveRunLimits(options: LifecycleOptions): CfRunOptions {
  const runtime = options.runtime;
  return {
    ...(runtime?.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    ...(runtime?.maxBytes === undefined ? {} : { maxBytes: runtime.maxBytes }),
  };
}
