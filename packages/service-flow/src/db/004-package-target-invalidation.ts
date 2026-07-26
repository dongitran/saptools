import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';
import {
  parsePackageImportReference,
} from '../parsers/012-package-fact-contract.js';

interface PackageCallRow {
  id: number;
  repoId: number;
  evidence: Record<string, unknown>;
}

export interface PackageInvalidationBatch {
  publishingRepoIds: ReadonlySet<number>;
  affectedCallerRepoIds: Set<number>;
  affectedWorkspaceIds: Set<number>;
}

const resolverKeys = new Set([
  'candidateStrategy', 'candidateCount', 'eligibleCandidateCount',
  'selectedCandidateCount', 'candidateSetComplete', 'resolvedModulePath',
  'resolvedTargetRepositoryId', 'unresolvedReason',
  'targetRepositoryCandidateCount', 'targetRepositoryCandidates',
  'shownTargetRepositoryCandidateCount',
  'omittedTargetRepositoryCandidateCount', 'publicSurface',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parsedEvidence(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function packageName(evidence: Record<string, unknown>): string | undefined {
  return parsePackageImportReference(evidence.importBinding)
    ?.requestedPackageName ?? undefined;
}

function packageCallEvidenceValid(
  evidence: Record<string, unknown>,
): boolean {
  const binding = record(evidence.importBinding);
  const classified = evidence.relation === 'package_import'
    || binding?.moduleKind === 'package';
  return !classified || packageName(evidence) !== undefined;
}

function currentCalls(
  db: Db,
  workspaceId: number,
  targetRepoId: number,
): PackageCallRow[] {
  const rows = db.prepare(`SELECT sc.id,sc.repo_id repoId,
    sc.evidence_json evidenceJson FROM symbol_calls sc
    JOIN repositories r ON r.id=sc.repo_id
    WHERE r.workspace_id=? AND r.id<>? AND r.fact_analyzer_version=?
    ORDER BY sc.id`).all(workspaceId, targetRepoId, ANALYZER_VERSION);
  return rows.flatMap((row) => {
    const evidence = parsedEvidence(row.evidenceJson);
    if (!evidence || typeof row.id !== 'number'
      || typeof row.repoId !== 'number')
      throw new Error('invalid_current_package_import_evidence');
    if (!packageCallEvidenceValid(evidence))
      throw new Error('invalid_current_package_import_evidence');
    return evidence.relation === 'package_import'
      || record(evidence.importBinding)?.moduleKind === 'package'
      ? [{ id: row.id, repoId: row.repoId, evidence }]
      : [];
  });
}

function pendingEvidence(evidence: Record<string, unknown>): string {
  const parser = Object.fromEntries(Object.entries(evidence).filter(
    ([key]) => !resolverKeys.has(key),
  ));
  if (!packageName(parser))
    throw new Error('invalid_current_package_import_evidence');
  return JSON.stringify({
    ...parser,
    candidateStrategy: 'package_import_pending',
    candidateCount: 0,
    eligibleCandidateCount: 0,
    selectedCandidateCount: 0,
    candidateSetComplete: false,
    unresolvedReason: 'package_resolution_pending',
  });
}

function targetWorkspace(
  db: Db,
  repoId: number,
): { workspaceId: number; packageName?: string | null } {
  const row = db.prepare(`SELECT workspace_id workspaceId,
    package_name packageName FROM repositories WHERE id=?`).get(repoId);
  if (typeof row?.workspaceId !== 'number')
    throw new Error('Repository target is missing its workspace');
  return {
    workspaceId: row.workspaceId,
    packageName: typeof row.packageName === 'string'
      || row.packageName === null ? row.packageName : undefined,
  };
}

function packageIdentityChanged(
  previous: string | null | undefined,
  next: string | undefined,
): boolean {
  const previousName = typeof previous === 'string' ? previous : null;
  const nextName = typeof next === 'string' ? next : null;
  return previousName !== nextName;
}

export function invalidatePackageTargetFacts(
  db: Db,
  targetRepoId: number,
  newPackageName: string | undefined,
  batch: PackageInvalidationBatch,
): void {
  const target = targetWorkspace(db, targetRepoId);
  const names = new Set(
    [target.packageName, newPackageName].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  if (names.size === 0) return;
  const update = db.prepare(`UPDATE symbol_calls SET callee_symbol_id=NULL,
    status='unresolved',unresolved_reason='package_resolution_pending',
    evidence_json=? WHERE id=?`);
  let matched = false;
  for (const call of currentCalls(db, target.workspaceId, targetRepoId)) {
    const requested = packageName(call.evidence);
    if (!requested || !names.has(requested)) continue;
    update.run(pendingEvidence(call.evidence), call.id);
    batch.affectedCallerRepoIds.add(call.repoId);
    matched = true;
  }
  if (matched || packageIdentityChanged(
    target.packageName, newPackageName,
  )) batch.affectedWorkspaceIds.add(target.workspaceId);
}

export function createPackageInvalidationBatch(
  publishingRepoIds: readonly number[],
): PackageInvalidationBatch {
  return {
    publishingRepoIds: new Set(publishingRepoIds),
    affectedCallerRepoIds: new Set(),
    affectedWorkspaceIds: new Set(),
  };
}

export function finalizePackageTargetInvalidations(
  db: Db,
  batch: PackageInvalidationBatch,
): void {
  const increment = db.prepare(`UPDATE repositories
    SET fact_generation=fact_generation+1 WHERE id=?`);
  for (const repoId of batch.affectedCallerRepoIds)
    if (!batch.publishingRepoIds.has(repoId)) increment.run(repoId);
  const stale = db.prepare(`UPDATE repositories
    SET graph_stale_reason='package_target_facts_changed',
      graph_stale_at=datetime('now') WHERE workspace_id=?`);
  for (const workspaceId of batch.affectedWorkspaceIds)
    stale.run(workspaceId);
}
