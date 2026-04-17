import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RegionKey } from "./types.js";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_VERSION = 1;

export interface SpaceCache {
  readonly apps: string[];
  readonly appsUpdatedAt: string;
}

export interface OrgCache {
  readonly spaces: Record<string, SpaceCache>;
  readonly spacesUpdatedAt: string;
}

export interface RegionCache {
  readonly orgs: Record<string, OrgCache>;
  readonly orgsUpdatedAt: string;
}

export interface CacheData {
  readonly version: number;
  readonly regions: Partial<Record<RegionKey, RegionCache>>;
}

export function getCacheDir(): string {
  return join(homedir(), ".config", "saptools");
}

function getCachePath(): string {
  return join(getCacheDir(), "cache.json");
}

export function isFresh(updatedAt: string, ttlMs = CACHE_TTL_MS): boolean {
  return Date.now() - new Date(updatedAt).getTime() < ttlMs;
}

export async function readCache(): Promise<CacheData | null> {
  const filePath = getCachePath();

  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as CacheData;

    // Reject stale schema versions
    if (data.version !== CACHE_VERSION) return null;

    return data;
  } catch {
    return null;
  }
}

async function ensureCacheDir(): Promise<void> {
  const dir = getCacheDir();

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function writeCache(data: CacheData): Promise<void> {
  await ensureCacheDir();
  await writeFile(getCachePath(), JSON.stringify(data, null, 2), "utf-8");
}

const EMPTY_CACHE: CacheData = { version: CACHE_VERSION, regions: {} };

export async function getCachedOrgs(region: RegionKey): Promise<string[] | null> {
  const cache = await readCache();
  const r = cache?.regions[region];

  if (!r || !isFresh(r.orgsUpdatedAt)) return null;

  return Object.keys(r.orgs);
}

export async function setCachedOrgs(region: RegionKey, orgs: string[]): Promise<void> {
  const existing = (await readCache()) ?? EMPTY_CACHE;
  const existingRegion = existing.regions[region] ?? { orgsUpdatedAt: "", orgs: {} };

  // Preserve existing space/app data for orgs that still exist
  const updatedOrgs: Record<string, OrgCache> = {};

  for (const org of orgs) {
    updatedOrgs[org] = existingRegion.orgs[org] ?? { spacesUpdatedAt: "", spaces: {} };
  }

  await writeCache({
    ...existing,
    regions: { ...existing.regions, [region]: { orgsUpdatedAt: new Date().toISOString(), orgs: updatedOrgs } },
  });
}

export async function getCachedSpaces(region: RegionKey, org: string): Promise<string[] | null> {
  const cache = await readCache();
  const o = cache?.regions[region]?.orgs[org];

  if (!o || !isFresh(o.spacesUpdatedAt)) return null;

  return Object.keys(o.spaces);
}

export async function setCachedSpaces(region: RegionKey, org: string, spaces: string[]): Promise<void> {
  const existing = (await readCache()) ?? EMPTY_CACHE;
  const existingRegion = existing.regions[region] ?? { orgsUpdatedAt: new Date().toISOString(), orgs: {} };
  const existingOrg = existingRegion.orgs[org] ?? { spacesUpdatedAt: "", spaces: {} };

  const updatedSpaces: Record<string, SpaceCache> = {};

  for (const space of spaces) {
    updatedSpaces[space] = existingOrg.spaces[space] ?? { apps: [], appsUpdatedAt: "" };
  }

  await writeCache({
    ...existing,
    regions: {
      ...existing.regions,
      [region]: {
        ...existingRegion,
        orgs: { ...existingRegion.orgs, [org]: { spacesUpdatedAt: new Date().toISOString(), spaces: updatedSpaces } },
      },
    },
  });
}

export async function getCachedApps(region: RegionKey, org: string, space: string): Promise<string[] | null> {
  const cache = await readCache();
  const s = cache?.regions[region]?.orgs[org]?.spaces[space];

  if (!s || !isFresh(s.appsUpdatedAt)) return null;

  return s.apps;
}

export async function setCachedApps(region: RegionKey, org: string, space: string, apps: string[]): Promise<void> {
  const existing = (await readCache()) ?? EMPTY_CACHE;
  const existingRegion = existing.regions[region] ?? { orgsUpdatedAt: new Date().toISOString(), orgs: {} };
  const existingOrg = existingRegion.orgs[org] ?? { spacesUpdatedAt: new Date().toISOString(), spaces: {} };

  await writeCache({
    ...existing,
    regions: {
      ...existing.regions,
      [region]: {
        ...existingRegion,
        orgs: {
          ...existingRegion.orgs,
          [org]: {
            ...existingOrg,
            spaces: { ...existingOrg.spaces, [space]: { apps, appsUpdatedAt: new Date().toISOString() } },
          },
        },
      },
    },
  });
}
