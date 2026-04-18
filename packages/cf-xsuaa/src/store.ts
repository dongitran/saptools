import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { xsuaaDataPath } from "./paths.js";
import type { AppRef, CachedToken, XsuaaCredentials, XsuaaEntry, XsuaaStore } from "./types.js";

const EMPTY_STORE: XsuaaStore = { version: 1, entries: [] };

export async function readStore(): Promise<XsuaaStore> {
  try {
    const raw = await readFile(xsuaaDataPath(), "utf8");
    const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return EMPTY_STORE;
    }
    return parsed as XsuaaStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STORE;
    }
    throw err;
  }
}

export async function writeStore(store: XsuaaStore): Promise<void> {
  const path = xsuaaDataPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function matchesRef(entry: XsuaaEntry, ref: AppRef): boolean {
  return (
    entry.region === ref.region &&
    entry.org === ref.org &&
    entry.space === ref.space &&
    entry.app === ref.app
  );
}

export function findEntry(store: XsuaaStore, ref: AppRef): XsuaaEntry | undefined {
  return store.entries.find((e) => matchesRef(e, ref));
}

export function upsertSecret(
  store: XsuaaStore,
  ref: AppRef,
  credentials: XsuaaCredentials,
  now: Date = new Date(),
): XsuaaStore {
  const fetchedAt = now.toISOString();
  const existing = findEntry(store, ref);
  const updated: XsuaaEntry = existing
    ? { ...existing, credentials, fetchedAt }
    : { ...ref, credentials, fetchedAt };

  const entries = existing
    ? store.entries.map((e) => (matchesRef(e, ref) ? updated : e))
    : [...store.entries, updated];

  return { ...store, entries };
}

export function upsertToken(store: XsuaaStore, ref: AppRef, token: CachedToken): XsuaaStore {
  const existing = findEntry(store, ref);
  if (!existing) {
    throw new Error("Cannot cache token: entry not found (fetch-secret first)");
  }
  const updated: XsuaaEntry = { ...existing, token };
  const entries = store.entries.map((e) => (matchesRef(e, ref) ? updated : e));
  return { ...store, entries };
}
