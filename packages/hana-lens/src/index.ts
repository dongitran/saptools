export { buildCache } from "./build-cache.js";
export { readCache, writeCache } from "./cache.js";
export { describeEntity, formatCsnExpression } from "./describe.js";
export { autoLinkPackages, scanForPackages } from "./packages.js";
export { findIncomingReferences, formatFieldSearchResults, formatIncomingReferences, formatSearchResults, searchDefinitions, searchFields } from "./search.js";
export { CACHE_KINDS, applyCacheKindFilter, parseCacheKind } from "./scope.js";
export { findTargetCandidates, isAssociationElement, isTargetNameMatch, resolveTarget } from "./targets.js";
export type { CacheKind } from "./scope.js";
export type { FieldSearchResult, HanaLensCsn, HanaLensDefinition, HanaLensElement, IncomingReference, SapPackage, SearchResult } from "./types.js";
