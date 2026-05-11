import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import {
  cfSyncHistoryPath,
  cfRuntimeStatePath,
  cfStateLockPath,
  cfStructurePath,
  cfSyncLockPath,
} from "../config/paths.js";
import { getAllRegions } from "../config/regions.js";
import type {
  CfStructure,
  Region,
  RegionKey,
  RegionNode,
  RegionView,
  RegionsView,
  RuntimeSyncState,
  StructureView,
  SyncHistoryEntry,
  SyncMetadata,
} from "../types.js";

import { findRegion } from "./find.js";

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

function parseJsonLines(raw: string): readonly unknown[] {
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
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

function stableRegionOrder(structure: CfStructure | undefined): readonly RegionKey[] {
  const existingKeys = structure?.regions.map((region) => region.key) ?? [];
  const catalogKeys = getAllRegions().map((region) => region.key);
  return [...new Set([...existingKeys, ...catalogKeys])];
}

function mergeRegionIntoRuntimeState(
  current: RuntimeSyncState,
  region: RegionNode,
  requestedRegionKeys: readonly RegionKey[],
  updatedAt: string,
): RuntimeSyncState {
  return {
    ...current,
    updatedAt,
    completedRegionKeys: orderRegionKeys([...current.completedRegionKeys, region.key], requestedRegionKeys),
    structure: upsertRegion(current.structure, region, requestedRegionKeys, updatedAt),
  };
}

function mergeRegionIntoStableStructure(
  current: CfStructure | undefined,
  region: RegionNode,
  updatedAt: string,
): CfStructure {
  return upsertRegion(
    current ?? {
      syncedAt: updatedAt,
      regions: [],
    },
    region,
    stableRegionOrder(current),
    updatedAt,
  );
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

function toRegionDefinition(region: Pick<RegionNode, "key" | "label" | "apiEndpoint">): Region {
  return {
    key: region.key,
    label: region.label,
    apiEndpoint: region.apiEndpoint,
  };
}

function getStableRegionsWithOrgs(structure: CfStructure): readonly Region[] {
  return structure.regions.filter((region) => region.orgs.length > 0).map(toRegionDefinition);
}

function buildRegionsView(
  source: "catalog" | "stable",
  regions: readonly Region[],
  runtimeState: RuntimeSyncState | undefined,
): RegionsView {
  return {
    source,
    regions,
    metadata: runtimeState ? toSyncMetadata(runtimeState) : undefined,
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

export async function readSyncHistory(): Promise<readonly SyncHistoryEntry[]> {
  try {
    const raw = await readFile(cfSyncHistoryPath(), "utf8");
    return parseJsonLines(raw) as readonly SyncHistoryEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

type SyncHistoryWriteInput = Omit<SyncHistoryEntry, "at" | "pid" | "hostname"> &
  Partial<Pick<SyncHistoryEntry, "at" | "pid" | "hostname">>;

export async function appendSyncHistory(input: SyncHistoryWriteInput): Promise<SyncHistoryEntry> {
  const entry: SyncHistoryEntry = {
    at: input.at ?? new Date().toISOString(),
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? getHostname(),
    ...input,
  };

  await withStateLock(async () => {
    await mkdir(dirname(cfSyncHistoryPath()), { recursive: true });
    await appendFile(cfSyncHistoryPath(), `${JSON.stringify(entry)}\n`, "utf8");
  });

  return entry;
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
    const next = mergeRegionIntoRuntimeState(current, region, requestedRegionKeys, updatedAt);
    await writeJsonFileAtomic(cfRuntimeStatePath(), next);
    return next;
  });
}

export async function persistRegion(region: RegionNode): Promise<SyncMetadata | undefined> {
  return await withStateLock(async () => {
    const updatedAt = new Date().toISOString();
    const runtimeState = await readRuntimeState();

    if (runtimeState) {
      const nextRuntime = mergeRegionIntoRuntimeState(
        runtimeState,
        region,
        runtimeState.requestedRegionKeys,
        updatedAt,
      );
      await writeJsonFileAtomic(cfRuntimeStatePath(), nextRuntime);

      if (runtimeState.status !== "running") {
        const nextStable = mergeRegionIntoStableStructure(await readStructure(), region, updatedAt);
        await writeJsonFileAtomic(cfStructurePath(), nextStable);
      }

      return toSyncMetadata(nextRuntime);
    }

    const nextStable = mergeRegionIntoStableStructure(await readStructure(), region, updatedAt);
    await writeJsonFileAtomic(cfStructurePath(), nextStable);
    return;
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

export async function readRegionsView(): Promise<RegionsView> {
  const runtimeState = await readRuntimeState();
  if (runtimeState?.status === "running") {
    return buildRegionsView("catalog", getAllRegions(), runtimeState);
  }

  const stableStructure = await readStructure();
  const accountStructure =
    stableStructure ?? (runtimeState?.status === "completed" ? runtimeState.structure : undefined);

  if (accountStructure) {
    return buildRegionsView("stable", getStableRegionsWithOrgs(accountStructure), runtimeState);
  }

  return buildRegionsView("catalog", getAllRegions(), runtimeState);
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

interface SyncLockContent {
  readonly syncId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
}

interface LegacySyncLockContent {
  readonly syncId: string;
  readonly startedAt: string;
}

type ParsedSyncLock =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly content: SyncLockContent }
  | { readonly kind: "legacy"; readonly content: LegacySyncLockContent }
  | { readonly kind: "invalid" };

function parseSyncLockContent(raw: string): ParsedSyncLock {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<SyncLockContent>;
    if (
      typeof parsed.syncId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        kind: "valid",
        content: {
          syncId: parsed.syncId,
          pid: parsed.pid,
          hostname: parsed.hostname,
          startedAt: parsed.startedAt,
        },
      };
    }

    if (typeof parsed.syncId === "string" && typeof parsed.startedAt === "string") {
      return {
        kind: "legacy",
        content: {
          syncId: parsed.syncId,
          startedAt: parsed.startedAt,
        },
      };
    }

    return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

async function readSyncLockContent(): Promise<ParsedSyncLock> {
  try {
    const raw = await readFile(cfSyncLockPath(), "utf8");
    return parseSyncLockContent(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw err;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function parseIsoTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isRuntimeStateFresh(state: RuntimeSyncState | undefined): boolean {
  if (state?.status !== "running") {
    return false;
  }

  const updatedAt = parseIsoTimestamp(state.updatedAt);
  if (updatedAt === undefined) {
    return false;
  }

  return Date.now() - updatedAt <= FULL_SYNC_WAIT_TIMEOUT_MS;
}

function isIsoTimestampStale(value: string): boolean {
  const timestamp = parseIsoTimestamp(value);
  return timestamp === undefined || Date.now() - timestamp > FULL_SYNC_WAIT_TIMEOUT_MS;
}

async function markStaleRuntimeAsFailed(staleSyncId: string): Promise<void> {
  await withStateLock(async () => {
    const current = await readRuntimeState();
    if (current?.syncId !== staleSyncId || current.status !== "running") {
      return;
    }
    const finishedAt = new Date().toISOString();
    const next: RuntimeSyncState = {
      ...current,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      error: "sync process exited without finishing",
    };
    await writeJsonFileAtomic(cfRuntimeStatePath(), next);
  });
}

async function writeLockHandle(handle: FileHandle, content: SyncLockContent): Promise<void> { await handle.writeFile(`${JSON.stringify(content)}\n`, "utf8"); }

async function openSyncLockExclusive(content: SyncLockContent): Promise<FileHandle | undefined> {
  await mkdir(dirname(cfSyncLockPath()), { recursive: true });
  try {
    const handle = await open(cfSyncLockPath(), "wx");
    await writeLockHandle(handle, content);
    return handle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw err;
  }
}

async function removeSyncLockFile(): Promise<void> {
  await unlink(cfSyncLockPath()).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  });
}

async function recordRecoveredLock(syncId: string, reason: string, lockSyncId: string | undefined): Promise<void> {
  await appendSyncHistory({
    syncId,
    event: "sync_lock_recovered",
    reason,
    ...(lockSyncId ? { lockSyncId } : {}),
  });
}

async function getValidSyncLockRecoveryReason(content: SyncLockContent): Promise<string | undefined> {
  if (content.hostname !== getHostname()) {
    return undefined;
  }

  if (!isPidAlive(content.pid)) {
    return "dead-pid";
  }

  const runtimeState = await readRuntimeState();
  if (!runtimeState) {
    return isIsoTimestampStale(content.startedAt) ? "missing-runtime" : undefined;
  }
  if (runtimeState.syncId !== content.syncId) {
    return !isRuntimeStateFresh(runtimeState) && isIsoTimestampStale(content.startedAt)
      ? "stale-runtime"
      : undefined;
  }
  if (runtimeState.status !== "running") {
    return "settled-runtime";
  }
  return isRuntimeStateFresh(runtimeState) ? undefined : "stale-runtime";
}

export async function tryAcquireSyncLock(syncId: string): Promise<FileHandle | undefined> {
  const content: SyncLockContent = {
    syncId,
    pid: process.pid,
    hostname: getHostname(),
    startedAt: new Date().toISOString(),
  };

  const first = await openSyncLockExclusive(content);
  if (first) {
    return first;
  }

  const existing = await readSyncLockContent();
  if (existing.kind === "valid") {
    const reason = await getValidSyncLockRecoveryReason(existing.content);
    if (!reason) {
      return undefined;
    }
    await removeSyncLockFile();
    if (reason !== "settled-runtime") {
      await markStaleRuntimeAsFailed(existing.content.syncId);
    }
    await recordRecoveredLock(syncId, reason, existing.content.syncId);
    return await openSyncLockExclusive(content);
  }

  if (existing.kind === "legacy") {
    const runtimeState = await readRuntimeState();
    const runtimeMatchesLock = runtimeState?.syncId === existing.content.syncId;
    const canRecover =
      !runtimeState || (runtimeState.status === "running" && (!runtimeMatchesLock || !isRuntimeStateFresh(runtimeState)));

    if (!canRecover) {
      return undefined;
    }
    await removeSyncLockFile();
    await markStaleRuntimeAsFailed(existing.content.syncId);
    await recordRecoveredLock(syncId, "legacy-format-stale-runtime", existing.content.syncId);
    return await openSyncLockExclusive(content);
  }

  if (existing.kind === "invalid") {
    const runtimeState = await readRuntimeState();
    const canRecover = !runtimeState || (runtimeState.status === "running" && !isRuntimeStateFresh(runtimeState));
    if (!canRecover) {
      return undefined;
    }
    await removeSyncLockFile();
    if (runtimeState?.status === "running") {
      await markStaleRuntimeAsFailed(runtimeState.syncId);
    }
    await recordRecoveredLock(syncId, "invalid-format-stale-runtime", runtimeState?.syncId);
    return await openSyncLockExclusive(content);
  }

  return undefined;
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

export { findApp, findOrg, findRegion, findSpace } from "./find.js";
