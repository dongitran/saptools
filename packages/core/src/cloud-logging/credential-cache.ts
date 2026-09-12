import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensurePrivateDirectorySync, readJsonFileSync, resolveSaptoolsRoot, writeFileAtomicSync } from "../saptools-paths.js";

import type { DashboardsCredential, ResolvedTarget } from "./types.js";

const CACHE_FILE_NAME = "credentials.json";
const DEFAULT_TTL_MINUTES = 10_080;
const AUTO_INSTANCE_SELECTOR = "auto";

interface StoredCredentialEntry {
  readonly region: string;
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly instanceSelector: string;
  readonly instance: string;
  readonly source: string;
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  readonly cachedAt: string;
  readonly expiresAt: string;
}

interface StoredCredentialCache {
  readonly version: 1;
  readonly entries: readonly StoredCredentialEntry[];
}

export interface CredentialCacheKey {
  readonly target: ResolvedTarget;
  readonly instanceSelector?: string;
}

export interface CredentialCacheOptions {
  /** Which consumer's cache file to use — `~/.saptools/<cliName>/credentials.json`. Required: keeps cf-otel's, cf-metrics's, and cf-log-search's caches from ever colliding. */
  readonly cliName: string;
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
  readonly ttlMinutes?: number;
}

export interface CachedCredentialSummary {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly instance: string;
  readonly source: string;
  readonly dashboardsEndpoint: string;
  readonly cachedAt: string;
  readonly expiresAt: string;
}

const EMPTY_CACHE: StoredCredentialCache = { version: 1, entries: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cachePath(options: CredentialCacheOptions): string {
  return join(resolveSaptoolsRoot(options.saptoolsRoot), options.cliName, CACHE_FILE_NAME);
}

function isStoredEntry(value: unknown): value is StoredCredentialEntry {
  if (!isRecord(value)) {
    return false;
  }
  const stringKeys: readonly (keyof StoredCredentialEntry)[] = [
    "region", "apiEndpoint", "org", "space", "instanceSelector", "instance", "source", "dashboardsEndpoint", "username", "password", "cachedAt", "expiresAt",
  ];
  return stringKeys.every((key) => {
    return typeof value[key] === "string";
  });
}

function readStore(path: string): StoredCredentialCache {
  const parsed = readJsonFileSync(path);
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["entries"])) {
    return EMPTY_CACHE;
  }
  return { version: 1, entries: parsed["entries"].filter(isStoredEntry) };
}

function writeStore(path: string, store: StoredCredentialCache): void {
  ensurePrivateDirectorySync(dirname(path));
  writeFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

function normalizeEndpoint(apiEndpoint: string): string {
  return apiEndpoint.trim().toLowerCase().replace(/\/+$/, "");
}

function matchesKey(entry: StoredCredentialEntry, key: CredentialCacheKey): boolean {
  if (normalizeEndpoint(entry.apiEndpoint) !== normalizeEndpoint(key.target.apiEndpoint) || entry.org !== key.target.org || entry.space !== key.target.space) {
    return false;
  }
  if (key.instanceSelector === undefined) {
    return entry.instanceSelector === AUTO_INSTANCE_SELECTOR;
  }
  return entry.instance === key.instanceSelector;
}

function isLive(entry: StoredCredentialEntry, nowMs: number): boolean {
  const expires = Date.parse(entry.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

function liveEntries(store: StoredCredentialCache, nowMs: number): readonly StoredCredentialEntry[] {
  return store.entries.filter((entry) => isLive(entry, nowMs));
}

export function readCachedCredential(key: CredentialCacheKey, options: CredentialCacheOptions): Promise<DashboardsCredential | undefined> {
  const store = readStore(cachePath(options));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const entry = liveEntries(store, nowMs).find((candidate) => matchesKey(candidate, key));
  if (entry === undefined) {
    // eslint-disable-next-line unicorn/no-useless-undefined
    return Promise.resolve(undefined);
  }
  return Promise.resolve({ dashboardsEndpoint: entry.dashboardsEndpoint, username: entry.username, password: entry.password, source: entry.source, instance: entry.instance });
}

export function writeCachedCredential(key: CredentialCacheKey, credential: DashboardsCredential, options: CredentialCacheOptions): Promise<void> {
  const path = cachePath(options);
  const store = readStore(path);
  const now = options.now?.() ?? new Date();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const entry: StoredCredentialEntry = {
    region: key.target.region,
    apiEndpoint: key.target.apiEndpoint,
    org: key.target.org,
    space: key.target.space,
    instanceSelector: key.instanceSelector ?? AUTO_INSTANCE_SELECTOR,
    instance: credential.instance,
    source: credential.source,
    dashboardsEndpoint: credential.dashboardsEndpoint,
    username: credential.username,
    password: credential.password,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  };
  const kept = liveEntries(store, now.getTime()).filter((candidate) => !matchesKey(candidate, key));
  writeStore(path, { version: 1, entries: [...kept, entry] });
  return Promise.resolve();
}

export function deleteCachedCredential(key: CredentialCacheKey, options: CredentialCacheOptions): Promise<boolean> {
  const path = cachePath(options);
  const store = readStore(path);
  const kept = store.entries.filter((candidate) => !matchesKey(candidate, key));
  if (kept.length === store.entries.length) {
    return Promise.resolve(false);
  }
  writeStore(path, { version: 1, entries: kept });
  return Promise.resolve(true);
}

export function listCachedCredentials(options: CredentialCacheOptions): Promise<readonly CachedCredentialSummary[]> {
  const store = readStore(cachePath(options));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const result = liveEntries(store, nowMs)
    .map((entry) => {
      return { region: entry.region, org: entry.org, space: entry.space, instance: entry.instance, source: entry.source, dashboardsEndpoint: entry.dashboardsEndpoint, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt };
    })
    .sort((left, right) => {
      return `${left.region}/${left.org}/${left.space}/${left.instance}`.localeCompare(`${right.region}/${right.org}/${right.space}/${right.instance}`);
    });
  return Promise.resolve(result);
}

export async function clearCredentialCache(options: CredentialCacheOptions): Promise<number> {
  const path = cachePath(options);
  const store = readStore(path);
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const count = liveEntries(store, nowMs).length;
  await rm(path, { force: true });
  const directory = dirname(path);
  const prefix = `${CACHE_FILE_NAME}.`;
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return count;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
      .map(async (name) => {
        await rm(join(directory, name), { force: true });
      }),
  );
  return count;
}
