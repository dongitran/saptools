/* eslint import/order: "off" -- eslint-plugin-import 2.32 crashes on this file with ESLint 10 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { appendRawLogText } from "./parser.js";
import { cfLogsStoreLockPath, cfLogsStorePath } from "./paths.js";
import { withFileLock } from "./lock.js";
import type {
  LogStore,
  LogStoreEntry,
  LogStoreKey,
  PersistSnapshotInput,
} from "./types.js";

export function emptyStore(): LogStore {
  return { version: 1, entries: [] };
}

export async function readStore(storePath?: string): Promise<LogStore> {
  return await readStoreUnlocked(resolveStorePath(storePath));
}

export async function writeStore(store: LogStore, storePath?: string): Promise<void> {
  const targetPath = resolveStorePath(storePath);
  await withFileLock(resolveLockPath(targetPath), async () => {
    await writeStoreUnlocked(store, targetPath);
  });
}

export function findStoreEntry(
  store: LogStore,
  key: LogStoreKey,
): LogStoreEntry | undefined {
  return store.entries.find((entry) => matchesStoreKey(entry.key, key));
}

export function upsertStoreEntry(
  store: LogStore,
  entry: LogStoreEntry,
): LogStore {
  const existing = findStoreEntry(store, entry.key);
  if (existing === undefined) {
    return { ...store, entries: [...store.entries, entry] };
  }
  return {
    ...store,
    entries: store.entries.map((item) => (matchesStoreKey(item.key, entry.key) ? entry : item)),
  };
}

export async function persistSnapshot(
  input: PersistSnapshotInput,
): Promise<LogStoreEntry> {
  const storePath = resolveStorePath(input.storePath);
  return await withFileLock(resolveLockPath(storePath), async () => {
    const store = await readStoreUnlocked(storePath);
    const rawText = appendRawLogText(
      "",
      input.rawText,
      input.logLimit === undefined ? {} : { logLimit: input.logLimit },
    );
    const entry = {
      key: input.key,
      rawText,
      fetchedAt: input.fetchedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rowCount: input.rows.length,
      truncated: rawText.length < input.rawText.length,
    } satisfies LogStoreEntry;
    await writeStoreUnlocked(upsertStoreEntry(store, entry), storePath);
    return entry;
  });
}

function resolveStorePath(storePath?: string): string {
  return storePath ?? cfLogsStorePath();
}

function resolveLockPath(storePath: string): string {
  return storePath === cfLogsStorePath() ? cfLogsStoreLockPath() : `${storePath}.lock`;
}

async function readStoreUnlocked(storePath: string): Promise<LogStore> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidStore(parsed) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

async function writeStoreUnlocked(store: LogStore, storePath: string): Promise<void> {
  const tempPath = `${storePath}.tmp`;
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, storePath);
}

function isValidStore(value: unknown): value is LogStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    "entries" in value &&
    value.version === 1 &&
    Array.isArray(value.entries)
  );
}

function matchesStoreKey(left: LogStoreKey, right: LogStoreKey): boolean {
  return (
    left.apiEndpoint === right.apiEndpoint &&
    left.org === right.org &&
    left.space === right.space &&
    left.app === right.app
  );
}
