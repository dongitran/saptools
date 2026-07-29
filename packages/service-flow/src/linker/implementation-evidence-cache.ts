import type { Db } from '../db/connection.js';

type CanonicalEvidence = Record<string, unknown> | undefined;

const canonicalEvidenceCache = new WeakMap<
  Db,
  Map<string, CanonicalEvidence>
>();

export function resetCanonicalImplementationEvidence(db: Db): void {
  canonicalEvidenceCache.delete(db);
}

// linkImplementations() already derives the same decision for every operation,
// so it can publish the result instead of leaving ownershipReason() to
// re-derive it later in the transaction. The diagnostics flag only controls an
// INSERT; it does not change the candidates or evidence being cached.
export function seedCanonicalImplementationEvidence(
  db: Db,
  operationId: string | number,
  evidence: CanonicalEvidence,
): void {
  const key = String(operationId);
  let cache = canonicalEvidenceCache.get(db);
  if (!cache) {
    cache = new Map();
    canonicalEvidenceCache.set(db, cache);
  }
  if (!cache.has(key)) cache.set(key, evidence);
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
