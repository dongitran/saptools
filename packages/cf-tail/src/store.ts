/* eslint import/order: "off" -- mirrors @saptools/cf-logs/store layout */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "./lock.js";
import { cfTailStoreLockPath, cfTailStorePath } from "./paths.js";
import type { AppSnapshotResult, TailStore, TailStoreEntry, TailStoreKey } from "./types.js";

export function emptyTailStore(): TailStore {
  return { version: 1, entries: [] };
}

export async function readTailStore(storePath?: string): Promise<TailStore> {
  return await readTailStoreUnlocked(resolveStorePath(storePath));
}

export async function clearTailStore(storePath?: string): Promise<void> {
  const targetPath = resolveStorePath(storePath);
  await withFileLock(resolveLockPath(targetPath), async () => {
    await writeTailStoreUnlocked(emptyTailStore(), targetPath);
  });
}

export interface PersistTailSnapshotInput {
  readonly key: TailStoreKey;
  readonly fetchedAt: string;
  readonly apps: readonly AppSnapshotResult[];
  readonly storePath?: string;
}

export async function persistTailSnapshot(
  input: PersistTailSnapshotInput,
): Promise<TailStoreEntry> {
  const storePath = resolveStorePath(input.storePath);
  return await withFileLock(resolveLockPath(storePath), async () => {
    const store = await readTailStoreUnlocked(storePath);
    const entry: TailStoreEntry = {
      key: input.key,
      fetchedAt: input.fetchedAt,
      updatedAt: new Date().toISOString(),
      appCount: input.apps.length,
      rowCount: input.apps.reduce((sum, app) => sum + app.rows.length, 0),
      apps: input.apps
        .map((app) => ({
          appName: app.appName,
          rowCount: app.rows.length,
          truncated: app.truncated,
        }))
        .sort((left, right) => left.appName.localeCompare(right.appName)),
    };
    await writeTailStoreUnlocked(upsertEntry(store, entry), storePath);
    return entry;
  });
}

export function findTailStoreEntry(
  store: TailStore,
  key: TailStoreKey,
): TailStoreEntry | undefined {
  return store.entries.find((entry) => matchesKey(entry.key, key));
}

function upsertEntry(store: TailStore, entry: TailStoreEntry): TailStore {
  const existing = findTailStoreEntry(store, entry.key);
  if (existing === undefined) {
    return { ...store, entries: [...store.entries, entry] };
  }
  return {
    ...store,
    entries: store.entries.map((item) => (matchesKey(item.key, entry.key) ? entry : item)),
  };
}

function resolveStorePath(storePath?: string): string {
  return storePath ?? cfTailStorePath();
}

function resolveLockPath(storePath: string): string {
  return storePath === cfTailStorePath() ? cfTailStoreLockPath() : `${storePath}.lock`;
}

async function readTailStoreUnlocked(storePath: string): Promise<TailStore> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidTailStore(parsed) ? parsed : emptyTailStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyTailStore();
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

async function writeTailStoreUnlocked(store: TailStore, storePath: string): Promise<void> {
  const tempPath = `${storePath}.tmp`;
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, storePath);
}

function isValidTailStore(value: unknown): value is TailStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    "entries" in value &&
    value.version === 1 &&
    Array.isArray(value.entries)
  );
}

function matchesKey(left: TailStoreKey, right: TailStoreKey): boolean {
  return (
    left.apiEndpoint === right.apiEndpoint &&
    left.org === right.org &&
    left.space === right.space
  );
}
