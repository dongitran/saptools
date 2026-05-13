import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CfExecContext } from "../cf/index.js";
import { cfApi, cfAuth, cfOrgs } from "../cf/index.js";
import { getAllRegions } from "../config/regions.js";
import type { Region, RegionKey, RegionNode, SyncHistoryEntry, SyncMetadata } from "../types.js";

import { persistRegionOrgs } from "./space-sync-store.js";
import { appendSyncHistory } from "./structure.js";

export interface SyncRegionOrgsOptions {
  readonly regionKey: RegionKey;
  readonly email: string;
  readonly password: string;
  readonly verbose?: boolean;
}

export interface SyncRegionOrgsResult {
  readonly region: RegionNode;
  readonly orgNames: readonly string[];
  readonly metadata?: SyncMetadata;
}

interface LogCtx {
  readonly verbose: boolean;
  readonly syncId: string;
}

type SyncHistoryDetails = Omit<SyncHistoryEntry, "at" | "pid" | "hostname" | "syncId" | "event">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(ctx: LogCtx, message: string): void {
  if (ctx.verbose) {
    process.stdout.write(`[cf-sync] ${message}\n`);
  }
}

async function recordHistory(ctx: LogCtx, event: string, details: SyncHistoryDetails = {}): Promise<void> {
  await appendSyncHistory({
    syncId: ctx.syncId,
    event,
    ...details,
  });
}

function getRegionDefinition(regionKey: RegionKey): Region {
  const region = getAllRegions().find((candidate) => candidate.key === regionKey);
  if (!region) {
    throw new Error(`Unknown region key: ${regionKey}`);
  }
  return region;
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

async function collectRegionOrgNames(
  region: Region,
  email: string,
  password: string,
  ctx: LogCtx,
): Promise<readonly string[]> {
  return await withCfSession(async (cfContext) => {
    await recordHistory(ctx, "region_orgs_sync_auth_started", { regionKey: region.key });
    log(ctx, `Refreshing ${region.key} org list...`);
    await cfApi(region.apiEndpoint, cfContext);
    await cfAuth(email, password, cfContext);
    const orgNames = await cfOrgs(cfContext);
    await recordHistory(ctx, "region_orgs_sync_loaded", {
      regionKey: region.key,
      orgCount: orgNames.length,
    });
    return orgNames;
  });
}

export async function syncRegionOrgs(
  options: SyncRegionOrgsOptions,
): Promise<SyncRegionOrgsResult> {
  const region = getRegionDefinition(options.regionKey);
  const ctx: LogCtx = {
    syncId: randomUUID(),
    verbose: options.verbose ?? false,
  };

  try {
    await recordHistory(ctx, "region_orgs_sync_requested", { regionKey: options.regionKey });
    const orgNames = await collectRegionOrgNames(region, options.email, options.password, ctx);
    const result = await persistRegionOrgs(region, orgNames);
    await recordHistory(ctx, "region_orgs_sync_completed", {
      regionKey: options.regionKey,
      orgCount: result.orgNames.length,
    });
    return result;
  } catch (error) {
    await recordHistory(ctx, "region_orgs_sync_failed", {
      regionKey: options.regionKey,
      error: errorMessage(error),
    });
    throw error;
  }
}
