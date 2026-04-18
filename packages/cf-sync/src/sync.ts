import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ora } from "ora";
import ora from "ora";

import type { CfExecContext } from "./cf.js";
import { cfApi, cfApps, cfAuth, cfOrgs, cfSpaces, cfTargetOrg, cfTargetSpace } from "./cf.js";
import { getAllRegions } from "./regions.js";
import {
  completeRuntimeState,
  failRuntimeState,
  findRegion,
  initializeRuntimeState,
  mergeRuntimeRegion,
  readRegionView,
  readRuntimeState,
  readStructure,
  releaseSyncLock,
  toSyncMetadata,
  tryAcquireSyncLock,
  waitForRuntimeStateToSettle,
  writeStructure,
} from "./structure.js";
import type {
  AppNode,
  CfStructure,
  OrgNode,
  Region,
  RegionKey,
  RegionNode,
  RegionView,
  SpaceNode,
  SyncMetadata,
} from "./types.js";

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

export interface SyncResult {
  readonly structure: CfStructure;
  readonly accessibleRegions: readonly string[];
  readonly inaccessibleRegions: readonly string[];
}

interface LogCtx {
  readonly spinner: Ora | undefined;
  readonly verbose: boolean;
  readonly interactive: boolean;
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

function createLogContext(options: SyncOptions): LogCtx {
  const spinner = options.interactive ? ora("Starting CF sync...").start() : undefined;
  return {
    spinner,
    verbose: options.verbose === true,
    interactive: options.interactive === true,
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
  try {
    await cfTargetSpace(orgName, spaceName, cfContext);
    const apps = (await cfApps(cfContext)).map((name): AppNode => ({ name }));
    log(ctx, `${regionKey} • ${orgName}/${spaceName}: ${apps.length.toString()} apps`);
    return { name: spaceName, apps };
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${regionKey} • ${orgName}/${spaceName}: skipped (${message})`);
    return { name: spaceName, apps: [], error: message };
  }
}

async function collectOrg(
  regionKey: string,
  orgName: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<OrgNode> {
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
    return { name: orgName, spaces: [], error: message };
  }
}

async function collectRegion(
  region: Region,
  email: string,
  password: string,
  ctx: LogCtx,
  cfContext: CfExecContext,
): Promise<RegionNode> {
  log(ctx, `Authenticating ${region.key}...`);

  try {
    await cfApi(region.apiEndpoint, cfContext);
    await cfAuth(email, password, cfContext);
  } catch (error) {
    const message = errorMessage(error);
    log(ctx, `${region.key}: no access (${message})`);
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

  try {
    for (const region of regions) {
      const currentState = await readRuntimeState();
      const existingRegion =
        currentState?.syncId === syncId ? findRegion(currentState.structure, region.key) : undefined;

      if (existingRegion) {
        log(ctx, `${region.key}: already available in runtime state`);
        continue;
      }

      const node = await collectRegionWithIsolatedSession(region, options.email, options.password, ctx);
      await mergeRuntimeRegion(
        syncId,
        regions.map((candidate) => candidate.key),
        node,
      );
    }

    const completedState = await completeRuntimeState(syncId);
    await writeStructure(completedState.structure);

    if (ctx.spinner) {
      ctx.spinner.succeed(
        `Sync done - ${completedState.completedRegionKeys.length.toString()} completed region(s)`,
      );
    }

    return buildResult(completedState.structure);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRuntimeState(syncId, message);
    throw error;
  }
}

async function releaseOwnedLock(lockHandle: FileHandle | undefined): Promise<void> {
  if (lockHandle) {
    await releaseSyncLock(lockHandle);
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

    const runtimeState = await readRuntimeState();
    if (runtimeState?.status === "running") {
      await mergeRuntimeRegion(runtimeState.syncId, runtimeState.requestedRegionKeys, freshRegion);
      return {
        source: "fresh",
        region: freshRegion,
        metadata: toSyncMetadata((await readRuntimeState()) ?? runtimeState),
      };
    }

    return {
      source: "fresh",
      region: freshRegion,
      metadata: runtimeState ? toSyncMetadata(runtimeState) : undefined,
    };
  } catch {
    return cachedView;
  }
}

async function runSyncInternal(options: SyncOptions): Promise<SyncResult> {
  const regions = getRequestedRegions(options);
  const ctx = createLogContext(options);
  const syncId = randomUUID();
  let lockHandle: FileHandle | undefined;

  try {
    lockHandle = await tryAcquireSyncLock(syncId);
    if (!lockHandle) {
      log(ctx, "Another sync is already running, waiting for it to finish...");
      const waitedResult = await readSettledSyncResult();
      if (ctx.spinner) {
        ctx.spinner.succeed("Reused the active CF sync result");
      }
      return waitedResult;
    }

    return await runOwnedSync(syncId, regions, options, ctx);
  } finally {
    await releaseOwnedLock(lockHandle);
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
