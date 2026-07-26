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

function isPersistenceSkipIfUnused(definition: Record<string, unknown>): boolean {
  return definition["@cds.persistence.skip"] === "if-unused";
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

function collectIfUnusedNames(results: readonly CompileResult[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const result of results) {
    for (const [name, definition] of Object.entries(result.definitions)) {
      if (isRecord(definition) && isPersistenceSkipIfUnused(definition)) {
        names.add(name);
      }
    }
  }
  return names;
}

function collectReferencedTargetNames(results: readonly CompileResult[]): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const result of results) {
    for (const definition of Object.values(result.definitions)) {
      const elements = isRecord(definition) ? definition["elements"] : undefined;
      if (!isRecord(elements)) {
        continue;
      }
      for (const element of Object.values(elements)) {
        if (isRecord(element) && typeof element["target"] === "string") {
          targets.add(element["target"]);
        }
      }
    }
  }
  return targets;
}

// Exact match or any dot-suffix match, mirroring targets.ts's isTargetNameMatch without importing
// its ambiguity-resolution machinery -- a real reference to a persistence-skip-if-unused entity
// only needs "is this name a plausible target of some element", not exact-vs-ambiguous resolution.
// Known limitation: a bare/short target name (most likely from the --allow-fallback regex parser,
// which never namespace-qualifies association targets) can suffix-match an unrelated same-named
// entity in a different namespace, marking it "referenced" when it is not. That failure direction
// is the safe one here -- it only keeps an unreferenced entity in `db` a build too long, never the
// reverse (wrongly dropping one CAP still persists), so no ambiguity check is done for this.
function isReferenced(name: string, referencedTargetNames: ReadonlySet<string>): boolean {
  if (referencedTargetNames.has(name)) {
    return true;
  }
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    if (referencedTargetNames.has(name.slice(dot + 1))) {
      return true;
    }
  }
  return false;
}

// `@cds.persistence.skip: 'if-unused'` means CAP only materializes the table when something else
// references it -- treating the string form identically to `true` (unconditionally non-persistent)
// would wrongly drop referenced code lists (e.g. sap.common.Currencies) out of `db`, and treating
// it identically to unannotated (today's bug) wrongly keeps unreferenced ones in unconditionally.
// hana-lens has the whole model in hand, so it approximates real usage via name matching rather
// than assuming one behavior for every skip -- see isReferenced's own limitation note above.
function collectUnreferencedIfUnusedNames(results: readonly CompileResult[]): ReadonlySet<string> {
  const ifUnusedNames = collectIfUnusedNames(results);
  if (ifUnusedNames.size === 0) {
    return ifUnusedNames;
  }
  const referencedTargetNames = collectReferencedTargetNames(results);
  const unreferenced = new Set<string>();
  for (const name of ifUnusedNames) {
    if (!isReferenced(name, referencedTargetNames)) {
      unreferenced.add(name);
    }
  }
  return unreferenced;
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
  unreferencedIfUnusedNames: ReadonlySet<string>,
): boolean {
  if (kind === CACHE_KINDS.ALL) {
    return true;
  }
  const effectivelyServiceShaped = isServiceShaped(definition) || unreferencedIfUnusedNames.has(name);
  if (definition["kind"] === "entity" && !effectivelyServiceShaped) {
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
  unreferencedIfUnusedNames: ReadonlySet<string>,
): Readonly<Record<string, HanaLensDefinition>> {
  return Object.fromEntries(
    Object.entries(result.definitions)
      .filter(([name, definition]) => isRecord(definition)
        && isInScope(name, definition, kind, serviceNames, nonPersistentNames, unreferencedIfUnusedNames)),
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
  const unreferencedIfUnusedNames = collectUnreferencedIfUnusedNames(results);
  return results.map((result) => ({
    ...result,
    definitions: filterDefinitions(result, kind, serviceNames, nonPersistentNames, unreferencedIfUnusedNames),
  }));
}
