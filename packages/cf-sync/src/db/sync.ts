import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CfExecContext } from "../cf/index.js";
import { cfApi, cfAuth, cfEnv, cfTargetOrg, cfTargetSpace } from "../cf/index.js";
import { getRegion } from "../config/regions.js";
import { readRuntimeState, readStructure } from "../topology/structure.js";
import type {
  AppDbSnapshot,
  CfStructure,
  CfDbSnapshot,
  DbSyncHistoryEntry,
  DbSyncTarget,
  ExplicitDbTargetSelector,
  RegionKey,
} from "../types.js";

import { extractHanaBindingsFromCfEnv } from "./parser.js";
import {
  appendDbSyncHistory,
  completeDbRuntimeState,
  failDbRuntimeState,
  initializeDbRuntimeState,
  mergeDbRuntimeEntry,
  readDbSnapshot,
  releaseDbSyncLock,
  tryAcquireDbSyncLock,
  waitForDbRuntimeStateToSettle,
  writeDbSnapshot,
} from "./store.js";
import {
  collectDbTargets,
  formatDbSelector,
  parseDbTargetSelector,
  resolveDbTargetSelector,
} from "./targets.js";

export interface DbSyncOptions {
  readonly email: string;
  readonly password: string;
  readonly targets: readonly DbSyncTarget[];
  readonly syncId?: string;
  readonly verbose?: boolean;
}

export interface DbSyncResult {
  readonly snapshot: CfDbSnapshot;
  readonly requestedTargets: readonly string[];
}

interface LogCtx {
  readonly verbose: boolean;
  readonly syncId: string;
}

type DbSyncHistoryDetails = Omit<
  DbSyncHistoryEntry,
  "at" | "pid" | "hostname" | "syncId" | "event"
>;

let activeDbSyncPromise: Promise<DbSyncResult> | undefined;
const APP_ENV_READ_CONCURRENCY = 4;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(ctx: LogCtx, message: string): void {
  if (ctx.verbose) {
    process.stdout.write(`[cf-sync/db] ${message}\n`);
  }
}

async function recordHistory(
  ctx: LogCtx,
  event: string,
  details: DbSyncHistoryDetails = {},
): Promise<void> {
  await appendDbSyncHistory({
    syncId: ctx.syncId,
    event,
    ...details,
  });
}

function groupTargetsBy<T extends string>(
  targets: readonly DbSyncTarget[],
  pick: (target: DbSyncTarget) => T,
): readonly [T, readonly DbSyncTarget[]][] {
  const groups = new Map<T, DbSyncTarget[]>();
  for (const target of targets) {
    const key = pick(target);
    const existing = groups.get(key);
    if (existing) {
      existing.push(target);
      continue;
    }
    groups.set(key, [target]);
  }
  return [...groups.entries()].map(([key, groupedTargets]) => [key, groupedTargets] as const);
}

async function withCfSession<T>(work: (context: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-db-sync-session-"));
  const context: CfExecContext = {
    env: { CF_HOME: cfHome },
  };

  try {
    return await work(context);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

function createDbEntry(
  target: DbSyncTarget,
  bindings: AppDbSnapshot["bindings"],
): AppDbSnapshot {
  return {
    selector: target.selector,
    regionKey: target.regionKey,
    orgName: target.orgName,
    spaceName: target.spaceName,
    appName: target.appName,
    syncedAt: new Date().toISOString(),
    bindings,
  };
}

function createErroredDbEntry(target: DbSyncTarget, message: string): AppDbSnapshot {
  return {
    ...createDbEntry(target, []),
    error: message,
  };
}

function buildResult(
  snapshot: CfDbSnapshot,
  requestedTargets: readonly string[],
): DbSyncResult {
  return {
    snapshot,
    requestedTargets,
  };
}

function toExplicitDbSyncTarget(selector: ExplicitDbTargetSelector): DbSyncTarget {
  return {
    selector: formatDbSelector(
      selector.regionKey,
      selector.orgName,
      selector.spaceName,
      selector.appName,
    ),
    regionKey: selector.regionKey,
    apiEndpoint: getRegion(selector.regionKey).apiEndpoint,
    orgName: selector.orgName,
    spaceName: selector.spaceName,
    appName: selector.appName,
  };
}

async function readTopologyForDbSyncSelection(): Promise<CfStructure> {
  const topologyRuntimeState = await readRuntimeState();
  if (topologyRuntimeState?.status === "running") {
    throw new Error(
      "CF topology sync is still running. Wait for `cf-sync sync` to finish before syncing DB bindings.",
    );
  }

  const structure =
    (await readStructure()) ??
    (topologyRuntimeState?.status === "completed"
      ? topologyRuntimeState.structure
      : undefined);

  if (!structure) {
    throw new Error(
      "Run `cf-sync sync` first to build a topology snapshot before syncing DB bindings.",
    );
  }

  return structure;
}

async function mergeEntry(
  target: DbSyncTarget,
  entry: AppDbSnapshot,
  requestedTargets: readonly string[],
  ctx: LogCtx,
): Promise<void> {
  await mergeDbRuntimeEntry(ctx.syncId, requestedTargets, entry);
  await recordHistory(ctx, "db_runtime_entry_merged", {
    selector: target.selector,
    regionKey: target.regionKey,
    orgName: target.orgName,
    spaceName: target.spaceName,
    appName: target.appName,
    status: "running",
  });
}

async function mergeErrorEntries(
  targets: readonly DbSyncTarget[],
  requestedTargets: readonly string[],
  message: string,
  ctx: LogCtx,
): Promise<void> {
  for (const target of targets) {
    await mergeEntry(target, createErroredDbEntry(target, message), requestedTargets, ctx);
  }
}

async function collectAppEntry(
  target: DbSyncTarget,
  cfContext: CfExecContext,
  requestedTargets: readonly string[],
  ctx: LogCtx,
): Promise<void> {
  await recordHistory(ctx, "db_app_started", {
    selector: target.selector,
    regionKey: target.regionKey,
    orgName: target.orgName,
    spaceName: target.spaceName,
    appName: target.appName,
  });

  try {
    const stdout = await cfEnv(target.appName, cfContext);
    const bindings = extractHanaBindingsFromCfEnv(stdout);
    const entry = createDbEntry(target, bindings);
    await mergeEntry(target, entry, requestedTargets, ctx);
    await recordHistory(ctx, "db_app_loaded", {
      selector: target.selector,
      regionKey: target.regionKey,
      orgName: target.orgName,
      spaceName: target.spaceName,
      appName: target.appName,
    });
  } catch (error) {
    const message = errorMessage(error);
    await mergeEntry(
      target,
      createErroredDbEntry(target, message),
      requestedTargets,
      ctx,
    );
    await recordHistory(ctx, "db_app_failed", {
      selector: target.selector,
      regionKey: target.regionKey,
      orgName: target.orgName,
      spaceName: target.spaceName,
      appName: target.appName,
      error: message,
    });
  }
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item === undefined) {
          return;
        }
        await work(item);
      }
    }),
  );
}

async function collectSpaceTargets(
  orgName: string,
  spaceName: string,
  targets: readonly DbSyncTarget[],
  cfContext: CfExecContext,
  requestedTargets: readonly string[],
  ctx: LogCtx,
): Promise<void> {
  try {
    await cfTargetSpace(orgName, spaceName, cfContext);
  } catch (error) {
    await mergeErrorEntries(targets, requestedTargets, errorMessage(error), ctx);
    return;
  }

  await runWithConcurrency(targets, APP_ENV_READ_CONCURRENCY, async (target) => {
    await collectAppEntry(target, cfContext, requestedTargets, ctx);
  });
}

async function collectOrgTargets(
  orgName: string,
  targets: readonly DbSyncTarget[],
  cfContext: CfExecContext,
  requestedTargets: readonly string[],
  ctx: LogCtx,
): Promise<void> {
  try {
    await cfTargetOrg(orgName, cfContext);
  } catch (error) {
    await mergeErrorEntries(targets, requestedTargets, errorMessage(error), ctx);
    return;
  }

  const spaceGroups = groupTargetsBy(targets, (target) => target.spaceName);
  for (const [spaceName, groupedTargets] of spaceGroups) {
    await collectSpaceTargets(
      orgName,
      spaceName,
      groupedTargets,
      cfContext,
      requestedTargets,
      ctx,
    );
  }
}

async function collectRegionTargets(
  regionKey: RegionKey,
  targets: readonly DbSyncTarget[],
  options: DbSyncOptions,
  requestedTargets: readonly string[],
  ctx: LogCtx,
): Promise<void> {
  const apiEndpoint = targets[0]?.apiEndpoint ?? getRegion(regionKey).apiEndpoint;

  await withCfSession(async (cfContext) => {
    try {
      await cfApi(apiEndpoint, cfContext);
      await cfAuth(options.email, options.password, cfContext);
    } catch (error) {
      await mergeErrorEntries(targets, requestedTargets, errorMessage(error), ctx);
      return;
    }

    const orgGroups = groupTargetsBy(targets, (target) => target.orgName);
    for (const [orgName, groupedTargets] of orgGroups) {
      await collectOrgTargets(orgName, groupedTargets, cfContext, requestedTargets, ctx);
    }
  });
}

async function readSettledDbSyncResult(): Promise<DbSyncResult> {
  const settledState = await waitForDbRuntimeStateToSettle();
  if (settledState) {
    if (settledState.status === "failed") {
      const reason = settledState.error ? `: ${settledState.error}` : "";
      throw new Error(`The active DB sync failed${reason}`);
    }
    return buildResult(settledState.snapshot, settledState.requestedTargets);
  }

  const snapshot = await readDbSnapshot();
  if (!snapshot) {
    throw new Error("The active DB sync finished without a readable snapshot");
  }

  return buildResult(
    snapshot,
    snapshot.entries.map((entry) => entry.selector),
  );
}

async function runOwnedDbSync(
  syncId: string,
  targets: readonly DbSyncTarget[],
  options: DbSyncOptions,
  ctx: LogCtx,
): Promise<DbSyncResult> {
  const requestedTargets = targets.map((target) => target.selector);
  await initializeDbRuntimeState(syncId, requestedTargets);
  await recordHistory(ctx, "db_runtime_initialized", {
    requestedTargets,
    status: "running",
  });

  try {
    const regionGroups = groupTargetsBy(targets, (target) => target.regionKey);
    for (const [regionKey, groupedTargets] of regionGroups) {
      await recordHistory(ctx, "db_region_started", { regionKey });
      await collectRegionTargets(
        regionKey,
        groupedTargets,
        options,
        requestedTargets,
        ctx,
      );
    }

    const completedState = await completeDbRuntimeState(syncId);
    await writeDbSnapshot(completedState.snapshot);
    await recordHistory(ctx, "db_sync_completed", {
      status: "completed",
      requestedTargets: completedState.requestedTargets,
      completedTargets: completedState.completedTargets,
    });
    return buildResult(completedState.snapshot, completedState.requestedTargets);
  } catch (error) {
    const message = errorMessage(error);
    await failDbRuntimeState(syncId, message);
    await recordHistory(ctx, "db_sync_failed", {
      status: "failed",
      error: message,
    });
    throw error;
  }
}

async function releaseOwnedDbLock(
  lockHandle: FileHandle | undefined,
  ctx: LogCtx,
): Promise<void> {
  if (!lockHandle) {
    return;
  }
  await releaseDbSyncLock(lockHandle);
  await recordHistory(ctx, "db_sync_lock_released");
}

async function runDbSyncInternal(options: DbSyncOptions): Promise<DbSyncResult> {
  if (options.targets.length === 0) {
    throw new Error("No DB sync targets were resolved");
  }

  const syncId = options.syncId ?? randomUUID();
  const ctx: LogCtx = {
    verbose: options.verbose ?? false,
    syncId,
  };
  let lockHandle: FileHandle | undefined;

  try {
    await recordHistory(ctx, "db_sync_requested", {
      requestedTargets: options.targets.map((target) => target.selector),
    });
    lockHandle = await tryAcquireDbSyncLock(syncId);
    if (!lockHandle) {
      log(ctx, "Another DB sync is already running, waiting for it to finish...");
      await recordHistory(ctx, "db_sync_waiting_for_active_lock", {
        requestedTargets: options.targets.map((target) => target.selector),
      });
      const waitedResult = await readSettledDbSyncResult();
      await recordHistory(ctx, "db_sync_reused_active_result");
      return waitedResult;
    }

    await recordHistory(ctx, "db_sync_lock_acquired");
    return await runOwnedDbSync(syncId, options.targets, options, ctx);
  } finally {
    await releaseOwnedDbLock(lockHandle, ctx);
  }
}

export async function resolveDbSyncTargetsFromCurrentTopology(
  rawSelector?: string,
): Promise<readonly DbSyncTarget[]> {
  const selector = rawSelector ? parseDbTargetSelector(rawSelector) : undefined;
  if (selector?.type === "explicit") {
    return [toExplicitDbSyncTarget(selector)];
  }

  const structure = await readTopologyForDbSyncSelection();

  if (selector?.type === "name") {
    return resolveDbTargetSelector(structure, selector.appName);
  }

  const targets = collectDbTargets(structure);
  if (targets.length === 0) {
    throw new Error("No apps were found in the CF topology snapshot");
  }
  return targets;
}

export async function runDbSync(options: DbSyncOptions): Promise<DbSyncResult> {
  if (activeDbSyncPromise) {
    return await activeDbSyncPromise;
  }

  const inFlight = runDbSyncInternal(options);
  activeDbSyncPromise = inFlight;

  try {
    return await inFlight;
  } finally {
    if (activeDbSyncPromise === inFlight) {
      activeDbSyncPromise = undefined;
    }
  }
}
