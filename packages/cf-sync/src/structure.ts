import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  cfRuntimeStatePath,
  cfStateLockPath,
  cfStructurePath,
  cfSyncLockPath,
} from "./paths.js";
import type {
  CfStructure,
  OrgNode,
  RegionKey,
  RegionNode,
  RegionView,
  RuntimeSyncState,
  SpaceNode,
  StructureView,
  SyncMetadata,
} from "./types.js";

const FILE_LOCK_POLL_MS = 50;
const FILE_LOCK_TIMEOUT_MS = 10_000;
const FULL_SYNC_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function acquireFileLock(path: string, timeoutMs: number): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      return await open(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring file lock at ${path}`);
    }

    await sleep(FILE_LOCK_POLL_MS);
  }
}

async function releaseFileLock(path: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await unlink(path).catch((err: unknown) => {
    const fileError = err as NodeJS.ErrnoException;
    if (fileError.code !== "ENOENT") {
      throw fileError;
    }
  });
}

async function withStateLock<T>(work: () => Promise<T>): Promise<T> {
  const handle = await acquireFileLock(cfStateLockPath(), FILE_LOCK_TIMEOUT_MS);

  try {
    return await work();
  } finally {
    await releaseFileLock(cfStateLockPath(), handle);
  }
}

function orderRegionKeys(
  keys: readonly RegionKey[],
  requestedRegionKeys: readonly RegionKey[],
): readonly RegionKey[] {
  const requested = new Map(requestedRegionKeys.map((key, index) => [key, index]));
  return [...new Set(keys)].sort((left, right) => {
    const leftIndex = requested.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function orderRegions(
  regions: readonly RegionNode[],
  requestedRegionKeys: readonly RegionKey[],
): readonly RegionNode[] {
  const requested = new Map(requestedRegionKeys.map((key, index) => [key, index]));
  return [...regions].sort((left, right) => {
    const leftIndex = requested.get(left.key) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right.key) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function upsertRegion(
  structure: CfStructure,
  region: RegionNode,
  requestedRegionKeys: readonly RegionKey[],
  syncedAt: string,
): CfStructure {
  const regions = structure.regions.filter((candidate) => candidate.key !== region.key);
  return {
    syncedAt,
    regions: orderRegions([...regions, region], requestedRegionKeys),
  };
}

export function toSyncMetadata(state: RuntimeSyncState): SyncMetadata {
  const completedRegionKeys = orderRegionKeys(state.completedRegionKeys, state.requestedRegionKeys);
  const completedSet = new Set(completedRegionKeys);
  const pendingRegionKeys = state.requestedRegionKeys.filter((key) => !completedSet.has(key));

  return {
    syncId: state.syncId,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    requestedRegionKeys: state.requestedRegionKeys,
    completedRegionKeys,
    pendingRegionKeys,
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}

function regionViewFromState(
  state: RuntimeSyncState | undefined,
  region: RegionNode | undefined,
  source: "runtime" | "stable",
): RegionView | undefined {
  if (!region) {
    return undefined;
  }

  return {
    source,
    region,
    metadata: state ? toSyncMetadata(state) : undefined,
  };
}

export async function readStructure(): Promise<CfStructure | undefined> {
  return await readJsonFile<CfStructure>(cfStructurePath());
}

export async function writeStructure(structure: CfStructure): Promise<void> {
  await writeJsonFileAtomic(cfStructurePath(), structure);
}

export async function readRuntimeState(): Promise<RuntimeSyncState | undefined> {
  return await readJsonFile<RuntimeSyncState>(cfRuntimeStatePath());
}

export async function initializeRuntimeState(
  syncId: string,
  requestedRegionKeys: readonly RegionKey[],
): Promise<RuntimeSyncState> {
  return await withStateLock(async () => {
    const startedAt = new Date().toISOString();
    const state: RuntimeSyncState = {
      syncId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      requestedRegionKeys,
      completedRegionKeys: [],
      structure: {
        syncedAt: startedAt,
        regions: [],
      },
    };
    await writeJsonFileAtomic(cfRuntimeStatePath(), state);
    return state;
  });
}

export async function mergeRuntimeRegion(
  syncId: string,
  requestedRegionKeys: readonly RegionKey[],
  region: RegionNode,
): Promise<RuntimeSyncState | undefined> {
  return await withStateLock(async () => {
    const current = await readRuntimeState();
    if (current?.syncId !== syncId) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const completedRegionKeys = orderRegionKeys(
      [...current.completedRegionKeys, region.key],
      requestedRegionKeys,
    );
    const next: RuntimeSyncState = {
      ...current,
      updatedAt,
      completedRegionKeys,
      structure: upsertRegion(current.structure, region, requestedRegionKeys, updatedAt),
    };
    await writeJsonFileAtomic(cfRuntimeStatePath(), next);
    return next;
  });
}

export async function completeRuntimeState(syncId: string): Promise<RuntimeSyncState> {
  return await withStateLock(async () => {
    const current = await readRuntimeState();
    if (current?.syncId !== syncId) {
      throw new Error(`Missing runtime state for sync ${syncId}`);
    }

    const finishedAt = new Date().toISOString();
    const next: RuntimeSyncState = {
      ...current,
      status: "completed",
      updatedAt: finishedAt,
      finishedAt,
      completedRegionKeys: orderRegionKeys(current.completedRegionKeys, current.requestedRegionKeys),
      structure: {
        syncedAt: finishedAt,
        regions: orderRegions(current.structure.regions, current.requestedRegionKeys),
      },
    };
    await writeJsonFileAtomic(cfRuntimeStatePath(), next);
    return next;
  });
}

export async function failRuntimeState(syncId: string, error: string): Promise<void> {
  await withStateLock(async () => {
    const current = await readRuntimeState();
    if (current?.syncId !== syncId) {
      return;
    }

    const finishedAt = new Date().toISOString();
    const next: RuntimeSyncState = {
      ...current,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      error,
    };
    await writeJsonFileAtomic(cfRuntimeStatePath(), next);
  });
}

export async function readStructureView(): Promise<StructureView | undefined> {
  const runtimeState = await readRuntimeState();
  if (runtimeState) {
    return {
      source: "runtime",
      structure: runtimeState.structure,
      metadata: toSyncMetadata(runtimeState),
    };
  }

  const structure = await readStructure();
  if (!structure) {
    return undefined;
  }

  return {
    source: "stable",
    structure,
    metadata: undefined,
  };
}

export async function readRegionView(key: RegionKey): Promise<RegionView | undefined> {
  const runtimeState = await readRuntimeState();
  const runtimeRegion = runtimeState ? findRegion(runtimeState.structure, key) : undefined;
  if (runtimeRegion) {
    return regionViewFromState(runtimeState, runtimeRegion, "runtime");
  }

  const structure = await readStructure();
  return regionViewFromState(runtimeState, structure ? findRegion(structure, key) : undefined, "stable");
}

export async function tryAcquireSyncLock(syncId: string): Promise<FileHandle | undefined> {
  try {
    const handle = await acquireFileLock(cfSyncLockPath(), 1);
    await handle.writeFile(`${JSON.stringify({ syncId, startedAt: new Date().toISOString() })}\n`, "utf8");
    return handle;
  } catch (err) {
    if ((err as Error).message.includes("Timed out acquiring file lock")) {
      return undefined;
    }
    throw err;
  }
}

export async function releaseSyncLock(handle: FileHandle): Promise<void> {
  await releaseFileLock(cfSyncLockPath(), handle);
}

export async function waitForRuntimeStateToSettle(): Promise<RuntimeSyncState | undefined> {
  const deadline = Date.now() + FULL_SYNC_WAIT_TIMEOUT_MS;

  for (;;) {
    const state = await readRuntimeState();
    if (state && state.status !== "running") {
      return state;
    }

    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the active CF sync to finish");
    }

    await sleep(FILE_LOCK_POLL_MS);
  }
}

export function findRegion(structure: CfStructure, key: RegionKey): RegionNode | undefined {
  return structure.regions.find((r) => r.key === key);
}

export function findOrg(region: RegionNode, orgName: string): OrgNode | undefined {
  return region.orgs.find((o) => o.name === orgName);
}

export function findSpace(org: OrgNode, spaceName: string): SpaceNode | undefined {
  return org.spaces.find((s) => s.name === spaceName);
}

export function findApp(space: SpaceNode, appName: string): { readonly name: string } | undefined {
  return space.apps.find((a) => a.name === appName);
}
