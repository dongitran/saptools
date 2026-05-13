import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ora } from "ora";
import ora from "ora";

import type { CfExecContext } from "../cf/index.js";
import { cfApi, cfAppDetails, cfAuth, cfOrgs, cfSpaces, cfTargetOrg, cfTargetSpace } from "../cf/index.js";
import { getAllRegions } from "../config/regions.js";
import type {
  CfStructure,
  OrgNode,
  Region,
  RegionKey,
  RegionNode,
  RegionView,
  SpaceNode,
  SyncHistoryEntry,
  SyncMetadata,
} from "../types.js";

import { persistOrg, persistSpace } from "./space-sync-store.js";
import {
  appendSyncHistory,
  completeRuntimeState,
  failRuntimeState,
  findRegion,
  initializeRuntimeState,
  mergeRuntimeRegion,
  persistRegion,
  readRegionView,
  readRuntimeState,
  readStructure,
  releaseSyncLock,
  tryAcquireSyncLock,
  waitForRuntimeStateToSettle,
} from "./structure.js";

export { syncRegionOrgs } from "./region-org-sync.js";
export type { SyncRegionOrgsOptions, SyncRegionOrgsResult } from "./region-org-sync.js";

export interface SyncOptions {
  readonly email: string;
  readonly password: string;
  readonly verbose?: boolean;
  readonly interactive?: boolean;
  readonly onlyRegions?: readonly string[];
}

export interface GetRegionOptions {
  readonly regionKey: RegionKey;
  readonly email?: string;
  readonly password?: string;
  readonly refreshIfMissing?: boolean;
}

export interface SyncSpaceOptions {
  readonly regionKey: RegionKey;
  readonly orgName: string;
  readonly spaceName: string;
  readonly email: string;
  readonly password: string;
  readonly verbose?: boolean;
}

export interface SyncOrgOptions {
  readonly regionKey: RegionKey;
  readonly orgName: string;
  readonly email: string;
  readonly password: string;
  readonly verbose?: boolean;
}

export interface SyncResult {
  readonly structure: CfStructure;
  readonly accessibleRegions: readonly string[];
  readonly inaccessibleRegions: readonly string[];
}

export interface SyncSpaceResult {
  readonly region: RegionNode;
  readonly org: OrgNode;
  readonly space: SpaceNode;
  readonly metadata?: SyncMetadata;
}

export interface SyncOrgResult {
  readonly region: RegionNode;
  readonly org: OrgNode;
  readonly metadata?: SyncMetadata;
}

interface LogCtx {
  readonly spinner: Ora | undefined;
  readonly verbose: boolean;
  readonly interactive: boolean;
  readonly syncId?: string;
}

let activeSyncPromise: Promise<SyncResult> | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(ctx: LogCtx, message: string): void {
  if (ctx.interactive && ctx.spinner) {
    ctx.spinner.text = message;
    return;
  }

  if (ctx.verbose) {
    process.stdout.write(`[cf-sync] ${message}\n`);
  }
}

type SyncHistoryDetails = Omit<SyncHistoryEntry, "at" | "pid" | "hostname" | "syncId" | "event">;

async function recordHistory(
  ctx: LogCtx,
  event: string,
  details: SyncHistoryDetails = {},
): Promise<void> {
  if (!ctx.syncId) {
    return;
  }

  await appendSyncHistory({
    syncId: ctx.syncId,
    event,
    ...details,
  });
}

function buildResult(structure: CfStructure): SyncResult {
  const accessibleRegions = structure.regions.filter((region) => region.accessible).map((region) => region.key);
  const inaccessibleRegions = structure.regions
    .filter((region) => !region.accessible)
    .map((region) => region.key);

  return {
    structure,
    accessibleRegions,
    inaccessibleRegions,
  };
}

function isRunningMetadata(metadata: SyncMetadata | undefined): boolean {
  return metadata?.status === "running";
}

function shouldRefreshRegion(
  regionView: RegionView | undefined,
  options: GetRegionOptions,
): options is GetRegionOptions & { readonly email: string; readonly password: string } {
  if (options.refreshIfMissing === false) {
    return false;
  }

  if (!options.email || !options.password) {
    return false;
  }

  if (!regionView) {
    return true;
  }

  return regionView.source === "stable" && isRunningMetadata(regionView.metadata);
}

function createLogContext(options: SyncOptions, syncId?: string): LogCtx {
  const spinner = options.interactive ? ora("Starting CF sync...").start() : undefined;
  return {
    spinner,
    verbose: options.verbose === true,
    interactive: options.interactive === true,
    ...(syncId ? { syncId } : {}),
  };
}

async function withCfSession<T>(work: (context: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-cf-session-"));
  const context: CfExecContext = {
    env: { CF_HOME: cfHome },
  };

  try {
    return await work(context);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

function getRequestedRegions(options: SyncOptions): readonly Region[] {
  const allRegions = getAllRegions();
  return options.onlyRegions
    ? allRegions.filter((region) => options.onlyRegions?.includes(region.key))
    : allRegions;
}

function getRegionDefinition(regionKey: RegionKey): Region {
  const region = getAllRegions().find((candidate) => candidate.key === regionKey);
  if (!region) {
    throw new Error(`Unknown region key: ${regionKey}`);
  }
  return region;
}

async function collectSpace(
  regionKey: string,
  orgName: string,
  spaceName: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<SpaceNode> {
  await recordHistory(ctx, "space_started", { regionKey: regionKey as RegionKey, orgName, spaceName });

  try {
    await cfTargetSpace(orgName, spaceName, cfContext);
    const apps = await cfAppDetails(cfContext);
    log(ctx, `${regionKey} • ${orgName}/${spaceName}: ${apps.length.toString()} apps`);
    await recordHistory(ctx, "space_apps_loaded", {
      regionKey: regionKey as RegionKey,
      orgName,
      spaceName,
      appCount: apps.length,
    });
    return { name: spaceName, apps };
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${regionKey} • ${orgName}/${spaceName}: skipped (${message})`);
    await recordHistory(ctx, "space_failed", {
      regionKey: regionKey as RegionKey,
      orgName,
      spaceName,
      error: message,
    });
    return { name: spaceName, apps: [], error: message };
  }
}

async function collectOrg(
  regionKey: string,
  orgName: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<OrgNode> {
  await recordHistory(ctx, "org_started", { regionKey: regionKey as RegionKey, orgName });

  try {
    await cfTargetOrg(orgName, cfContext);
    const spaces = await cfSpaces(cfContext);
    const collectedSpaces: SpaceNode[] = [];

    for (const spaceName of spaces) {
      collectedSpaces.push(await collectSpace(regionKey, orgName, spaceName, ctx, cfContext));
    }

    return { name: orgName, spaces: collectedSpaces };
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${regionKey} • ${orgName}: skipped (${message})`);
    await recordHistory(ctx, "org_failed", {
      regionKey: regionKey as RegionKey,
      orgName,
      error: message,
    });
    return { name: orgName, spaces: [], error: message };
  }
}

async function collectTargetedOrg(
  regionKey: RegionKey,
  orgName: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<OrgNode> {
  await recordHistory(ctx, "org_started", { regionKey, orgName });

  try {
    await cfTargetOrg(orgName, cfContext);
    const spaces = await cfSpaces(cfContext);
    const collectedSpaces: SpaceNode[] = [];

    for (const spaceName of spaces) {
      collectedSpaces.push(await collectSpace(regionKey, orgName, spaceName, ctx, cfContext));
    }

    return { name: orgName, spaces: collectedSpaces };
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${regionKey} • ${orgName}: failed (${message})`);
    await recordHistory(ctx, "org_failed", {
      regionKey,
      orgName,
      error: message,
    });
    throw new Error(`Failed to refresh org ${regionKey}/${orgName}: ${message}`, { cause: error });
  }
}

async function collectRegion(
  region: Region,
  email: string,
  password: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<RegionNode> {
  await recordHistory(ctx, "region_auth_started", { regionKey: region.key });
  log(ctx, `Authenticating ${region.key}...`);

  try {
    await cfApi(region.apiEndpoint, cfContext);
    await cfAuth(email, password, cfContext);
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${region.key}: no access (${message})`);
    await recordHistory(ctx, "region_access_denied", {
      regionKey: region.key,
      error: message,
    });
    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: false,
      orgs: [],
      error: message,
    };
  }

  try {
    const orgNames = await cfOrgs(cfContext);
    log(ctx, `${region.key}: ${orgNames.length.toString()} org(s)`);
    await recordHistory(ctx, "region_orgs_loaded", {
      regionKey: region.key,
      orgCount: orgNames.length,
    });
    const orgs: OrgNode[] = [];

    for (const orgName of orgNames) {
      orgs.push(await collectOrg(region.key, orgName, ctx, cfContext));
    }

    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: true,
      orgs,
    };
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${region.key}: orgs lookup failed (${message})`);
    await recordHistory(ctx, "region_failed", {
      regionKey: region.key,
      error: message,
    });
    return {
      key: region.key,
      label: region.label,
      apiEndpoint: region.apiEndpoint,
      accessible: true,
      orgs: [],
      error: message,
    };
  }
}

async function collectRegionWithIsolatedSession(
  region: Region,
  email: string,
  password: string,
  ctx: LogCtx,
): Promise<RegionNode> {
  return await withCfSession(async (cfContext) => await collectRegion(region, email, password, ctx, cfContext));
}

async function readSettledSyncResult(): Promise<SyncResult> {
  const settledState = await waitForRuntimeStateToSettle();
  if (settledState) {
    if (settledState.status === "failed") {
      const reason = settledState.error ? `: ${settledState.error}` : "";
      throw new Error(`The active CF sync failed${reason}`);
    }
    return buildResult(settledState.structure);
  }

  const structure = await readStructure();
  if (!structure) {
    throw new Error("The active CF sync finished without a readable snapshot");
  }

  return buildResult(structure);
}

async function runOwnedSync(
  syncId: string,
  regions: readonly Region[],
  options: SyncOptions,
  ctx: LogCtx,
): Promise<SyncResult> {
  await initializeRuntimeState(
    syncId,
    regions.map((region) => region.key),
  );
  await recordHistory(ctx, "runtime_initialized", {
    requestedRegionKeys: regions.map((region) => region.key),
    status: "running",
  });

  try {
    for (const region of regions) {
      const currentState = await readRuntimeState();
      const existingRegion =
        currentState?.syncId === syncId && currentState.completedRegionKeys.includes(region.key)
          ? findRegion(currentState.structure, region.key)
          : undefined;

      if (existingRegion) {
        log(ctx, `${region.key}: already available in runtime state`);
        await recordHistory(ctx, "region_skipped_existing", {
          regionKey: region.key,
        });
        continue;
      }

      await recordHistory(ctx, "region_started", { regionKey: region.key });
      const node = await collectRegionWithIsolatedSession(region, options.email, options.password, ctx);
      await mergeRuntimeRegion(
        syncId,
        regions.map((candidate) => candidate.key),
        node,
      );
      await recordHistory(ctx, "runtime_region_merged", {
        regionKey: region.key,
        status: "running",
      });
    }

    const completedState = await completeRuntimeState(syncId, {
      mergeWithStableStructure: options.onlyRegions !== undefined,
      writeStableStructure: true,
    });
    await recordHistory(ctx, "sync_completed", {
      status: "completed",
      completedRegionKeys: completedState.completedRegionKeys,
      requestedRegionKeys: completedState.requestedRegionKeys,
    });

    if (ctx.spinner) {
      ctx.spinner.succeed(
        `Sync done - ${completedState.completedRegionKeys.length.toString()} completed region(s)`,
      );
    }

    return buildResult(completedState.structure);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRuntimeState(syncId, message);
    await recordHistory(ctx, "sync_failed", {
      status: "failed",
      error: message,
    });
    throw error;
  }
}

async function releaseOwnedLock(lockHandle: FileHandle | undefined, ctx: LogCtx): Promise<void> {
  if (lockHandle) {
    await releaseSyncLock(lockHandle);
    await recordHistory(ctx, "sync_lock_released");
  }
}

export async function getRegionView(options: GetRegionOptions): Promise<RegionView | undefined> {
  const cachedView = await readRegionView(options.regionKey);
  if (!shouldRefreshRegion(cachedView, options)) {
    return cachedView;
  }

  try {
    const freshRegion = await collectRegionWithIsolatedSession(
      getRegionDefinition(options.regionKey),
      options.email,
      options.password,
      { spinner: undefined, verbose: false, interactive: false },
    );
    const metadata = await persistRegion(freshRegion);

    return {
      source: "fresh",
      region: freshRegion,
      metadata,
    };
  } catch {
    return cachedView;
  }
}

async function collectSingleSpaceWithIsolatedSession(
  region: Region,
  orgName: string,
  spaceName: string,
  email: string,
  password: string,
  ctx: LogCtx,
): Promise<SpaceNode> {
  return await withCfSession(async (cfContext) => {
    await recordHistory(ctx, "space_sync_auth_started", { regionKey: region.key, orgName, spaceName });
    log(ctx, `Refreshing ${region.key} • ${orgName}/${spaceName}...`);
    await cfApi(region.apiEndpoint, cfContext);
    await cfAuth(email, password, cfContext);
    return await collectSpace(region.key, orgName, spaceName, ctx, cfContext);
  });
}

export async function syncSpace(options: SyncSpaceOptions): Promise<SyncSpaceResult> {
  const region = getRegionDefinition(options.regionKey);
  const syncId = randomUUID();
  const ctx = createLogContext(
    {
      email: options.email,
      password: options.password,
      verbose: options.verbose ?? false,
      interactive: false,
    },
    syncId,
  );

  try {
    await recordHistory(ctx, "space_sync_requested", {
      regionKey: options.regionKey,
      orgName: options.orgName,
      spaceName: options.spaceName,
    });
    const space = await collectSingleSpaceWithIsolatedSession(
      region,
      options.orgName,
      options.spaceName,
      options.email,
      options.password,
      ctx,
    );
    const result = await persistSpace(region, options.orgName, space);
    await recordHistory(ctx, "space_sync_completed", {
      regionKey: options.regionKey,
      orgName: options.orgName,
      spaceName: options.spaceName,
      appCount: result.space.apps.length,
    });
    return result;
  } catch (error) {
    await recordHistory(ctx, "space_sync_failed", {
      regionKey: options.regionKey,
      orgName: options.orgName,
      spaceName: options.spaceName,
      error: errorMessage(error),
    });
    throw error;
  }
}

async function collectSingleOrgWithIsolatedSession(
  region: Region,
  orgName: string,
  email: string,
  password: string,
  ctx: LogCtx,
): Promise<OrgNode> {
  return await withCfSession(async (cfContext) => {
    await recordHistory(ctx, "org_sync_auth_started", { regionKey: region.key, orgName });
    log(ctx, `Refreshing ${region.key} • ${orgName}...`);
    await cfApi(region.apiEndpoint, cfContext);
    await cfAuth(email, password, cfContext);
    return await collectTargetedOrg(region.key, orgName, ctx, cfContext);
  });
}

export async function syncOrg(options: SyncOrgOptions): Promise<SyncOrgResult> {
  const region = getRegionDefinition(options.regionKey);
  const syncId = randomUUID();
  const ctx = createLogContext(
    {
      email: options.email,
      password: options.password,
      verbose: options.verbose ?? false,
      interactive: false,
    },
    syncId,
  );

  try {
    await recordHistory(ctx, "org_sync_requested", {
      regionKey: options.regionKey,
      orgName: options.orgName,
    });
    const org = await collectSingleOrgWithIsolatedSession(
      region,
      options.orgName,
      options.email,
      options.password,
      ctx,
    );
    const result = await persistOrg(region, org);
    await recordHistory(ctx, "org_sync_completed", {
      regionKey: options.regionKey,
      orgName: options.orgName,
    });
    return result;
  } catch (error) {
    await recordHistory(ctx, "org_sync_failed", {
      regionKey: options.regionKey,
      orgName: options.orgName,
      error: errorMessage(error),
    });
    throw error;
  }
}

async function runSyncInternal(options: SyncOptions): Promise<SyncResult> {
  const regions = getRequestedRegions(options);
  const syncId = randomUUID();
  const ctx = createLogContext(options, syncId);
  let lockHandle: FileHandle | undefined;

  try {
    await recordHistory(ctx, "sync_requested", {
      requestedRegionKeys: regions.map((region) => region.key),
    });
    lockHandle = await tryAcquireSyncLock(syncId);
    if (!lockHandle) {
      log(ctx, "Another sync is already running, waiting for it to finish...");
      await recordHistory(ctx, "sync_waiting_for_active_lock", {
        requestedRegionKeys: regions.map((region) => region.key),
      });
      const waitedResult = await readSettledSyncResult();
      await recordHistory(ctx, "sync_reused_active_result");
      if (ctx.spinner) {
        ctx.spinner.succeed("Reused the active CF sync result");
      }
      return waitedResult;
    }

    await recordHistory(ctx, "sync_lock_acquired");
    return await runOwnedSync(syncId, regions, options, ctx);
  } finally {
    await releaseOwnedLock(lockHandle, ctx);
  }
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  if (activeSyncPromise) {
    return await activeSyncPromise;
  }

  const inFlight = runSyncInternal(options);
  activeSyncPromise = inFlight;

  try {
    return await inFlight;
  } finally {
    if (activeSyncPromise === inFlight) {
      activeSyncPromise = undefined;
    }
  }
}
