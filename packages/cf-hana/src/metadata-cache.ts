import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HanaClientInfo } from "./types.js";

export const METADATA_CACHE_TTL_MS = 30 * 60_000;

export interface CatalogObjectInfo {
  readonly schema: string;
  readonly name: string;
  readonly type: "TABLE" | "VIEW";
}

interface StoredMetadataCache {
  readonly version: 1;
  readonly createdAt: string;
  readonly scope: MetadataCacheScope;
  readonly objects: readonly CatalogObjectInfo[];
}

export interface MetadataCacheScope {
  readonly selector: string;
  readonly appName: string;
  readonly host: string;
  readonly schema: string;
  readonly role: string;
  readonly driver: string;
  readonly bindingName?: string;
  readonly bindingIndex?: number;
}

export interface MetadataCacheOptions {
  readonly saptoolsRoot?: string;
  readonly now?: () => Date;
}

function metadataCacheRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? join(homedir(), ".saptools"), "cf-hana", "metadata");
}

export function toMetadataCacheScope(info: HanaClientInfo): MetadataCacheScope {
  return {
    selector: info.selector,
    appName: info.appName,
    host: info.host,
    schema: info.schema,
    role: info.role,
    driver: info.driver,
    ...(info.bindingName === undefined ? {} : { bindingName: info.bindingName }),
    ...(info.bindingIndex === undefined ? {} : { bindingIndex: info.bindingIndex }),
  };
}

export function metadataCacheKey(scope: MetadataCacheScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function metadataCachePath(scope: MetadataCacheScope, saptoolsRoot?: string): string {
  return join(metadataCacheRoot(saptoolsRoot), `${metadataCacheKey(scope)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogObject(value: unknown): value is CatalogObjectInfo {
  return (
    isRecord(value) &&
    typeof value["schema"] === "string" &&
    typeof value["name"] === "string" &&
    (value["type"] === "TABLE" || value["type"] === "VIEW")
  );
}

function isScope(value: unknown): value is MetadataCacheScope {
  return (
    isRecord(value) &&
    typeof value["selector"] === "string" &&
    typeof value["appName"] === "string" &&
    typeof value["host"] === "string" &&
    typeof value["schema"] === "string" &&
    typeof value["role"] === "string" &&
    typeof value["driver"] === "string" &&
    (value["bindingName"] === undefined || typeof value["bindingName"] === "string") &&
    (value["bindingIndex"] === undefined || typeof value["bindingIndex"] === "number")
  );
}

function scopesEqual(left: MetadataCacheScope, right: MetadataCacheScope): boolean {
  return metadataCacheKey(left) === metadataCacheKey(right);
}

function isStored(value: unknown): value is StoredMetadataCache {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    typeof value["createdAt"] === "string" &&
    isScope(value["scope"]) &&
    Array.isArray(value["objects"]) &&
    value["objects"].every(isCatalogObject)
  );
}

export async function readMetadataCache(
  scope: MetadataCacheScope,
  options: MetadataCacheOptions = {},
): Promise<readonly CatalogObjectInfo[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(metadataCachePath(scope, options.saptoolsRoot), "utf8"),
    );
    if (!isStored(parsed) || !scopesEqual(parsed.scope, scope)) {
      return undefined;
    }
    const createdAt = Date.parse(parsed.createdAt);
    const now = options.now?.() ?? new Date();
    const ageMs = now.getTime() - createdAt;
    if (!Number.isFinite(createdAt) || ageMs < 0 || ageMs >= METADATA_CACHE_TTL_MS) {
      return undefined;
    }
    return parsed.objects;
  } catch {
    return undefined;
  }
}

export async function writeMetadataCache(
  scope: MetadataCacheScope,
  objects: readonly CatalogObjectInfo[],
  options: MetadataCacheOptions = {},
): Promise<void> {
  const root = metadataCacheRoot(options.saptoolsRoot);
  const path = metadataCachePath(scope, options.saptoolsRoot);
  const tempPath = `${path}.tmp-${process.pid.toString()}`;
  const stored: StoredMetadataCache = {
    version: 1,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    scope,
    objects,
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await rm(tempPath, { force: true });
  await writeFile(tempPath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

export async function loadCatalogObjectsWithCache(
  scope: MetadataCacheScope,
  refresh: boolean,
  loader: () => Promise<readonly CatalogObjectInfo[]>,
  options: MetadataCacheOptions = {},
): Promise<readonly CatalogObjectInfo[]> {
  if (!refresh) {
    const cached = await readMetadataCache(scope, options);
    if (cached !== undefined) {
      return cached;
    }
  }
  const objects = await loader();
  try {
    await writeMetadataCache(scope, objects, options);
  } catch {
    // A cache write failure must not suppress suggestions built from fresh metadata.
  }
  return objects;
}
