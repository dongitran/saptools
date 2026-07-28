import type { Db } from '../db/connection.js';

type CanonicalEvidence = Record<string, unknown> | undefined;

const canonicalEvidenceCache = new WeakMap<
  Db,
  Map<string, CanonicalEvidence>
>();

export function resetCanonicalImplementationEvidence(db: Db): void {
  canonicalEvidenceCache.delete(db);
}

export function cachedCanonicalImplementationEvidence(
  db: Db,
  operationId: string | number,
  resolve: () => CanonicalEvidence,
): CanonicalEvidence {
  const key = String(operationId);
  let cache = canonicalEvidenceCache.get(db);
  if (cache?.has(key)) return cache.get(key);
  const evidence = resolve();
  if (!cache) {
    cache = new Map();
    canonicalEvidenceCache.set(db, cache);
  }
  cache.set(key, evidence);
  return evidence;
}
