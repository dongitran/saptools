import type { CompileResult, HanaLensDefinition } from "./types.js";
import { isRecord } from "./validation.js";

export const CACHE_KINDS = {
  DB: "db",
  SERVICE: "service",
  ALL: "all",
} as const;

export type CacheKind = typeof CACHE_KINDS[keyof typeof CACHE_KINDS];

export function parseCacheKind(value: string | undefined): CacheKind {
  const candidate = value ?? CACHE_KINDS.DB;
  if (
    candidate === CACHE_KINDS.DB
    || candidate === CACHE_KINDS.SERVICE
    || candidate === CACHE_KINDS.ALL
  ) {
    return candidate;
  }
  throw new Error(`--kind must be one of db|service|all (got ${JSON.stringify(value)})`);
}

function collectServiceNames(results: readonly CompileResult[]): ReadonlySet<string> {
  const serviceNames = new Set<string>();
  for (const result of results) {
    for (const [name, definition] of Object.entries(result.definitions)) {
      if (isRecord(definition) && definition["kind"] === "service") {
        serviceNames.add(name);
      }
    }
  }
  return serviceNames;
}

function isServiceOwned(name: string, serviceNames: ReadonlySet<string>): boolean {
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    if (serviceNames.has(name.slice(0, dot))) {
      return true;
    }
  }
  return false;
}

// Keep this property-presence check aligned with cache.ts isProjection().
function hasProjectionShape(definition: Record<string, unknown>): boolean {
  return definition["query"] !== undefined || definition["projection"] !== undefined;
}

function isServiceShaped(definition: Record<string, unknown>): boolean {
  return hasProjectionShape(definition)
    || definition["@cds.external"] === true
    || definition["@cds.persistence.skip"] === true;
}

function collectNonPersistentNames(results: readonly CompileResult[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const result of results) {
    for (const [name, definition] of Object.entries(result.definitions)) {
      if (isRecord(definition) && isServiceShaped(definition)) {
        names.add(name);
      }
    }
  }
  return names;
}

function isFreeSupportKind(kind: unknown): boolean {
  return kind === "type" || kind === "aspect";
}

function isInScope(
  name: string,
  definition: Record<string, unknown>,
  kind: CacheKind,
  serviceNames: ReadonlySet<string>,
  nonPersistentNames: ReadonlySet<string>,
): boolean {
  if (kind === CACHE_KINDS.ALL) {
    return true;
  }
  if (definition["kind"] === "entity" && !isServiceShaped(definition)) {
    if (isServiceOwned(name, serviceNames)) {
      if (nonPersistentNames.has(name)) {
        return kind === CACHE_KINDS.SERVICE;
      }
      // CAP persists and exposes plain entities declared inside service bodies.
      return true;
    }
    return kind === CACHE_KINDS.DB;
  }
  if (isServiceOwned(name, serviceNames)) {
    return kind === CACHE_KINDS.SERVICE;
  }
  if (isFreeSupportKind(definition["kind"])) {
    return true;
  }
  return kind === CACHE_KINDS.SERVICE;
}

function filterDefinitions(
  result: CompileResult,
  kind: CacheKind,
  serviceNames: ReadonlySet<string>,
  nonPersistentNames: ReadonlySet<string>,
): Readonly<Record<string, HanaLensDefinition>> {
  return Object.fromEntries(
    Object.entries(result.definitions)
      .filter(([name, definition]) => isRecord(definition)
        && isInScope(name, definition, kind, serviceNames, nonPersistentNames)),
  );
}

export function applyCacheKindFilter(
  results: readonly CompileResult[],
  kind: CacheKind,
): CompileResult[] {
  if (kind === CACHE_KINDS.ALL) {
    return [...results];
  }
  const serviceNames = collectServiceNames(results);
  const nonPersistentNames = collectNonPersistentNames(results);
  return results.map((result) => ({
    ...result,
    definitions: filterDefinitions(result, kind, serviceNames, nonPersistentNames),
  }));
}
