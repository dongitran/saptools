import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import {
  cfDbRuntimeStatePath,
  cfDbSnapshotPath,
  cfDbStateLockPath,
  cfDbSyncHistoryPath,
  cfDbSyncLockPath,
} from "./paths.js";
import type {
  AppDbSnapshot,
  CfDbSnapshot,
  DbAppView,
  DbSnapshotView,
  DbSyncHistoryEntry,
  DbSyncMetadata,
  RuntimeDbSyncState,
} from "./types.js";

const FILE_LOCK_POLL_MS = 50;
const FILE_LOCK_TIMEOUT_MS = 10_000;
const DB_SYNC_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

interface DbSyncLockContent {
  readonly syncId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
}

interface LegacyDbSyncLockContent {
  readonly syncId: string;
  readonly startedAt: string;
}

type ParsedDbSyncLock =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly content: DbSyncLockContent }
  | { readonly kind: "legacy"; readonly content: LegacyDbSyncLockContent }
  | { readonly kind: "invalid" };

type DbSyncHistoryWriteInput = Omit<DbSyncHistoryEntry, "at" | "pid" | "hostname"> &
  Partial<Pick<DbSyncHistoryEntry, "at" | "pid" | "hostname">>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptySnapshot(at: string): CfDbSnapshot {
  return {
    version: 1,
    syncedAt: at,
    entries: [],
  };
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  });
}

async function withDbStateLock<T>(work: () => Promise<T>): Promise<T> {
  const handle = await acquireFileLock(cfDbStateLockPath(), FILE_LOCK_TIMEOUT_MS);
  try {
    return await work();
  } finally {
    await releaseFileLock(cfDbStateLockPath(), handle);
  }
}

function orderSelectors(
  selectors: readonly string[],
  requestedTargets: readonly string[],
): readonly string[] {
  const requested = new Map(requestedTargets.map((target, index) => [target, index]));
  return [...new Set(selectors)].sort((left, right) => {
    const leftIndex = requested.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function orderEntries(
  entries: readonly AppDbSnapshot[],
  requestedTargets: readonly string[],
): readonly AppDbSnapshot[] {
  const requested = new Map(requestedTargets.map((target, index) => [target, index]));
  return [...entries].sort((left, right) => {
    const leftIndex = requested.get(left.selector) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requested.get(right.selector) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function upsertDbEntry(
  snapshot: CfDbSnapshot,
  entry: AppDbSnapshot,
  requestedTargets: readonly string[],
  syncedAt: string,
): CfDbSnapshot {
  const remaining = snapshot.entries.filter((candidate) => candidate.selector !== entry.selector);
  return {
    version: 1,
    syncedAt,
    entries: orderEntries([...remaining, entry], requestedTargets),
  };
}

function mergeEntryIntoRuntimeState(
  current: RuntimeDbSyncState,
  entry: AppDbSnapshot,
  requestedTargets: readonly string[],
  updatedAt: string,
): RuntimeDbSyncState {
  return {
    ...current,
    updatedAt,
    completedTargets: orderSelectors(
      [...current.completedTargets, entry.selector],
      requestedTargets,
    ),
    snapshot: upsertDbEntry(current.snapshot, entry, requestedTargets, updatedAt),
  };
}

function resolveAppEntry(
  snapshot: CfDbSnapshot,
  rawSelector: string,
): AppDbSnapshot | undefined {
  const trimmed = rawSelector.trim();
  if (trimmed.includes("/")) {
    return snapshot.entries.find((entry) => entry.selector === trimmed);
  }

  const matches = snapshot.entries.filter((entry) => entry.appName === trimmed);
  if (matches.length <= 1) {
    return matches[0];
  }

  throw new Error(
    `App name "${trimmed}" is ambiguous. Use one of: ${matches
      .map((entry) => entry.selector)
      .join(", ")}`,
  );
}

function parseDbSyncLockContent(raw: string): ParsedDbSyncLock {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<DbSyncLockContent>;
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

async function readDbSyncLockContent(): Promise<ParsedDbSyncLock> {
  try {
    const raw = await readFile(cfDbSyncLockPath(), "utf8");
    return parseDbSyncLockContent(raw);
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

function isDbSyncLockStale(lock: DbSyncLockContent): boolean {
  if (lock.hostname !== getHostname()) {
    return false;
  }
  return !isPidAlive(lock.pid);
}

function parseIsoTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isDbRuntimeStateFresh(state: RuntimeDbSyncState | undefined): boolean {
  if (state?.status !== "running") {
    return false;
  }

  const updatedAt = parseIsoTimestamp(state.updatedAt);
  if (updatedAt === undefined) {
    return false;
  }

  return Date.now() - updatedAt <= DB_SYNC_WAIT_TIMEOUT_MS;
}

async function markStaleDbRuntimeAsFailed(staleSyncId: string): Promise<void> {
  await withDbStateLock(async () => {
    const current = await readDbRuntimeState();
    if (current?.syncId !== staleSyncId || current.status !== "running") {
      return;
    }

    const finishedAt = new Date().toISOString();
    await writeJsonFileAtomic(cfDbRuntimeStatePath(), {
      ...current,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      error: "DB sync process exited without finishing",
    } satisfies RuntimeDbSyncState);
  });
}

async function writeLockHandle(handle: FileHandle, content: DbSyncLockContent): Promise<void> {
  await handle.writeFile(`${JSON.stringify(content)}\n`, "utf8");
}

async function openDbSyncLockExclusive(
  content: DbSyncLockContent,
): Promise<FileHandle | undefined> {
  await mkdir(dirname(cfDbSyncLockPath()), { recursive: true });
  try {
    const handle = await open(cfDbSyncLockPath(), "wx");
    await writeLockHandle(handle, content);
    return handle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw err;
  }
}

async function removeDbSyncLockFile(): Promise<void> {
  await unlink(cfDbSyncLockPath()).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  });
}

async function recordRecoveredDbLock(
  syncId: string,
  reason: string,
  lockSyncId: string | undefined,
): Promise<void> {
  await appendDbSyncHistory({
    syncId,
    event: "db_sync_lock_recovered",
    reason,
    ...(lockSyncId ? { lockSyncId } : {}),
  });
}

async function recoverValidDbLock(
  syncId: string,
  content: DbSyncLockContent,
  nextContent: DbSyncLockContent,
): Promise<FileHandle | undefined> {
  if (!isDbSyncLockStale(content)) {
    return undefined;
  }

  await removeDbSyncLockFile();
  await markStaleDbRuntimeAsFailed(content.syncId);
  await recordRecoveredDbLock(syncId, "dead-pid", content.syncId);
  return await openDbSyncLockExclusive(nextContent);
}

async function recoverLegacyDbLock(
  syncId: string,
  content: LegacyDbSyncLockContent,
  nextContent: DbSyncLockContent,
): Promise<FileHandle | undefined> {
  const runtimeState = await readDbRuntimeState();
  const runtimeMatchesLock = runtimeState?.syncId === content.syncId;
  const canRecover =
    !runtimeState ||
    (runtimeState.status === "running" &&
      (!runtimeMatchesLock || !isDbRuntimeStateFresh(runtimeState)));

  if (!canRecover) {
    return undefined;
  }

  await removeDbSyncLockFile();
  await markStaleDbRuntimeAsFailed(content.syncId);
  await recordRecoveredDbLock(syncId, "legacy-format-stale-runtime", content.syncId);
  return await openDbSyncLockExclusive(nextContent);
}

async function recoverInvalidDbLock(
  syncId: string,
  nextContent: DbSyncLockContent,
): Promise<FileHandle | undefined> {
  const runtimeState = await readDbRuntimeState();
  const canRecover =
    !runtimeState ||
    (runtimeState.status === "running" && !isDbRuntimeStateFresh(runtimeState));
  if (!canRecover) {
    return undefined;
  }

  await removeDbSyncLockFile();
  if (runtimeState?.status === "running") {
    await markStaleDbRuntimeAsFailed(runtimeState.syncId);
  }
  await recordRecoveredDbLock(syncId, "invalid-format-stale-runtime", runtimeState?.syncId);
  return await openDbSyncLockExclusive(nextContent);
}

export function toDbSyncMetadata(state: RuntimeDbSyncState): DbSyncMetadata {
  const completedTargets = orderSelectors(state.completedTargets, state.requestedTargets);
  const completedSet = new Set(completedTargets);
  const pendingTargets = state.requestedTargets.filter((target) => !completedSet.has(target));

  return {
    syncId: state.syncId,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    requestedTargets: state.requestedTargets,
    completedTargets,
    pendingTargets,
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}

export async function readDbSnapshot(): Promise<CfDbSnapshot | undefined> {
  return await readJsonFile<CfDbSnapshot>(cfDbSnapshotPath());
}

export async function writeDbSnapshot(snapshot: CfDbSnapshot): Promise<void> {
  await writeJsonFileAtomic(cfDbSnapshotPath(), snapshot);
}

export async function readDbRuntimeState(): Promise<RuntimeDbSyncState | undefined> {
  return await readJsonFile<RuntimeDbSyncState>(cfDbRuntimeStatePath());
}

export async function readDbSyncHistory(): Promise<readonly DbSyncHistoryEntry[]> {
  try {
    const raw = await readFile(cfDbSyncHistoryPath(), "utf8");
    return parseJsonLines(raw) as readonly DbSyncHistoryEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function appendDbSyncHistory(
  input: DbSyncHistoryWriteInput,
): Promise<DbSyncHistoryEntry> {
  const entry: DbSyncHistoryEntry = {
    at: input.at ?? new Date().toISOString(),
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? getHostname(),
    ...input,
  };

  await withDbStateLock(async () => {
    await mkdir(dirname(cfDbSyncHistoryPath()), { recursive: true });
    await appendFile(cfDbSyncHistoryPath(), `${JSON.stringify(entry)}\n`, "utf8");
  });

  return entry;
}

export async function initializeDbRuntimeState(
  syncId: string,
  requestedTargets: readonly string[],
): Promise<RuntimeDbSyncState> {
  return await withDbStateLock(async () => {
    const startedAt = new Date().toISOString();
    const state: RuntimeDbSyncState = {
      syncId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      requestedTargets,
      completedTargets: [],
      snapshot: emptySnapshot(startedAt),
    };
    await writeJsonFileAtomic(cfDbRuntimeStatePath(), state);
    return state;
  });
}

export async function mergeDbRuntimeEntry(
  syncId: string,
  requestedTargets: readonly string[],
  entry: AppDbSnapshot,
): Promise<RuntimeDbSyncState | undefined> {
  return await withDbStateLock(async () => {
    const current = await readDbRuntimeState();
    if (current?.syncId !== syncId) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const next = mergeEntryIntoRuntimeState(current, entry, requestedTargets, updatedAt);
    await writeJsonFileAtomic(cfDbRuntimeStatePath(), next);
    return next;
  });
}

export async function completeDbRuntimeState(syncId: string): Promise<RuntimeDbSyncState> {
  return await withDbStateLock(async () => {
    const current = await readDbRuntimeState();
    if (current?.syncId !== syncId) {
      throw new Error(`Missing DB runtime state for sync ${syncId}`);
    }

    const finishedAt = new Date().toISOString();
    const next: RuntimeDbSyncState = {
      ...current,
      status: "completed",
      updatedAt: finishedAt,
      finishedAt,
      completedTargets: orderSelectors(current.completedTargets, current.requestedTargets),
      snapshot: {
        version: 1,
        syncedAt: finishedAt,
        entries: orderEntries(current.snapshot.entries, current.requestedTargets),
      },
    };
    await writeJsonFileAtomic(cfDbRuntimeStatePath(), next);
    return next;
  });
}

export async function failDbRuntimeState(syncId: string, error: string): Promise<void> {
  await withDbStateLock(async () => {
    const current = await readDbRuntimeState();
    if (current?.syncId !== syncId) {
      return;
    }

    const finishedAt = new Date().toISOString();
    const next: RuntimeDbSyncState = {
      ...current,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      error,
    };
    await writeJsonFileAtomic(cfDbRuntimeStatePath(), next);
  });
}

export async function readDbSnapshotView(): Promise<DbSnapshotView | undefined> {
  const runtimeState = await readDbRuntimeState();
  if (runtimeState) {
    return {
      source: "runtime",
      snapshot: runtimeState.snapshot,
      metadata: toDbSyncMetadata(runtimeState),
    };
  }

  const snapshot = await readDbSnapshot();
  if (!snapshot) {
    return undefined;
  }

  return {
    source: "stable",
    snapshot,
    metadata: undefined,
  };
}

export async function readDbAppView(rawSelector: string): Promise<DbAppView | undefined> {
  const runtimeState = await readDbRuntimeState();
  const runtimeEntry = runtimeState
    ? resolveAppEntry(runtimeState.snapshot, rawSelector)
    : undefined;
  if (runtimeEntry) {
    return {
      source: "runtime",
      entry: runtimeEntry,
      metadata: runtimeState ? toDbSyncMetadata(runtimeState) : undefined,
    };
  }

  const snapshot = await readDbSnapshot();
  const stableEntry = snapshot ? resolveAppEntry(snapshot, rawSelector) : undefined;
  if (!stableEntry) {
    return undefined;
  }

  return {
    source: "stable",
    entry: stableEntry,
    metadata: undefined,
  };
}

export async function tryAcquireDbSyncLock(syncId: string): Promise<FileHandle | undefined> {
  const content: DbSyncLockContent = {
    syncId,
    pid: process.pid,
    hostname: getHostname(),
    startedAt: new Date().toISOString(),
  };

  const first = await openDbSyncLockExclusive(content);
  if (first) {
    return first;
  }

  const existing = await readDbSyncLockContent();
  if (existing.kind === "valid") {
    return await recoverValidDbLock(syncId, existing.content, content);
  }

  if (existing.kind === "legacy") {
    return await recoverLegacyDbLock(syncId, existing.content, content);
  }

  if (existing.kind === "invalid") {
    return await recoverInvalidDbLock(syncId, content);
  }

  return undefined;
}

export async function releaseDbSyncLock(handle: FileHandle): Promise<void> {
  await releaseFileLock(cfDbSyncLockPath(), handle);
}

export async function waitForDbRuntimeStateToSettle(): Promise<RuntimeDbSyncState | undefined> {
  const deadline = Date.now() + DB_SYNC_WAIT_TIMEOUT_MS;

  for (;;) {
    const state = await readDbRuntimeState();
    if (state && state.status !== "running") {
      return state;
    }

    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the active DB sync to finish");
    }

    await sleep(FILE_LOCK_POLL_MS);
  }
}
