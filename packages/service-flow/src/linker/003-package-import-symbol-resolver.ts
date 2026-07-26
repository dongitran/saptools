import type { Db } from '../db/connection.js';
import type {
  PackagePublicScope,
  PackagePublicSurfaceFact,
  PublicSurfaceTarget,
} from '../parsers/003-package-public-surface.js';
import type {
  SymbolImportReference,
} from '../parsers/002-symbol-import-bindings.js';
import {
  parsePackageImportReference,
  parsePackagePublicSurfaceFact,
} from '../parsers/012-package-fact-contract.js';

export interface PackageSymbolLinkSummary {
  resolved: number;
  ambiguous: number;
  unresolved: number;
}

interface PackageCallRow {
  id: number;
  callerRepoId: number;
  binding: SymbolImportReference;
  evidence: Record<string, unknown>;
}

interface PackageRepository {
  id: number;
  surface: PackagePublicSurfaceFact;
}

export interface PackageCallResolution {
  id: number | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason: string | null;
  strategy: string;
  candidateCount: number;
  eligibleCandidateCount: number;
  selectedCandidateCount: 0 | 1;
  candidateSetComplete: boolean;
  resolvedModulePath?: string;
  targetRepoId?: number;
  repositoryCandidateIds: number[];
  publicSurface?: {
    total: number;
    shown: number;
    omitted: number;
  };
}

export interface PackageResolutionInput {
  callId: number;
  binding: SymbolImportReference;
}

export interface PackageResolutionResult extends PackageCallResolution {
  callId: number;
}

const REPOSITORY_REFERENCE_CAP = 5;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function importBinding(
  evidence: Record<string, unknown>,
): SymbolImportReference | undefined {
  return parsePackageImportReference(evidence.importBinding);
}

function packageCallRows(db: Db, workspaceId: number): PackageCallRow[] {
  const rows = db.prepare(`SELECT sc.id,sc.repo_id callerRepoId,
    sc.evidence_json evidenceJson FROM symbol_calls sc
    JOIN repositories r ON r.id=sc.repo_id
    WHERE r.workspace_id=?
      AND json_extract(sc.evidence_json,'$.importBinding.moduleKind')='package'
    ORDER BY sc.id`).all(workspaceId);
  return rows.flatMap((row) => {
    const evidence = parseRecord(row.evidenceJson);
    const binding = evidence ? importBinding(evidence) : undefined;
    return typeof row.id === 'number' && typeof row.callerRepoId === 'number'
      && evidence && binding
      ? [{ id: row.id, callerRepoId: row.callerRepoId, evidence, binding }]
      : [];
  });
}

function parseSurface(
  value: unknown,
  packageName: string,
): PackagePublicSurfaceFact | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parsePackagePublicSurfaceFact(
      JSON.parse(value) as unknown,
      packageName,
    );
  } catch {
    return undefined;
  }
}

function repositoriesByPackage(
  db: Db,
  workspaceId: number,
): Map<string, PackageRepository[]> {
  const rows = db.prepare(`SELECT id,package_name packageName,
    package_public_surface_json surfaceJson FROM repositories
    WHERE workspace_id=? AND package_name IS NOT NULL
    ORDER BY package_name COLLATE BINARY,id`).all(workspaceId);
  const result = new Map<string, PackageRepository[]>();
  for (const row of rows) {
    if (typeof row.id !== 'number' || typeof row.packageName !== 'string')
      continue;
    const surface = parseSurface(row.surfaceJson, row.packageName);
    if (!surface) continue;
    const repositories = result.get(row.packageName) ?? [];
    repositories.push({ id: row.id, surface });
    result.set(row.packageName, repositories);
  }
  return result;
}

function unresolved(
  reason: string,
  options: Partial<PackageCallResolution> = {},
): PackageCallResolution {
  return {
    id: null,
    status: 'unresolved',
    reason,
    strategy: 'package_public_surface_unresolved',
    candidateCount: 0,
    eligibleCandidateCount: 0,
    selectedCandidateCount: 0,
    candidateSetComplete: true,
    repositoryCandidateIds: [],
    ...options,
  };
}

function repositoryScopeResolution(
  call: PackageCallRow,
  repositories: Map<string, PackageRepository[]>,
): PackageRepository | PackageCallResolution {
  const matches = repositories.get(call.binding.requestedPackageName ?? '')
    ?? [];
  if (matches.length === 1 && matches[0]) return matches[0];
  const ids = matches.map((item) => item.id);
  if (matches.length > 1) return unresolved(
    'package_repository_scope_ambiguous',
    {
      candidateSetComplete: false,
      candidateCount: matches.length,
      repositoryCandidateIds: ids,
    },
  );
  return unresolved('package_repository_not_indexed');
}

function publicScope(
  surface: PackagePublicSurfaceFact,
  binding: SymbolImportReference,
): PackagePublicScope | PackageCallResolution {
  const surfaceCounts = {
    total: surface.total,
    shown: surface.shown,
    omitted: surface.omitted,
  };
  if (surface.status !== 'complete') return unresolved(
    surface.status === 'unsupported'
      ? 'package_public_surface_unsupported'
      : 'public_surface_evidence_incomplete',
    { candidateSetComplete: false, publicSurface: surfaceCounts },
  );
  if (binding.typeOnly) return unresolved(
    'package_binding_type_only',
    { publicSurface: surfaceCounts },
  );
  const matches = surface.scopes.filter((scope) =>
    scope.entry === binding.requestedModuleSubpath
    && scope.publicName === binding.requestedPublicName);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) return unresolved(
    'package_public_scope_duplicate',
    {
      candidateSetComplete: false,
      candidateCount: matches.reduce(
        (sum, scope) => sum + scope.candidateCount, 0,
      ),
      publicSurface: surfaceCounts,
    },
  );
  return unresolved(
    surface.omitted > 0
      ? 'public_surface_evidence_incomplete'
      : 'package_public_name_not_exposed',
    {
      candidateSetComplete: surface.omitted === 0,
      publicSurface: surfaceCounts,
    },
  );
}

function symbolEvidenceMatches(
  evidenceJson: unknown,
  target: PublicSurfaceTarget,
  scope: PackagePublicScope,
): boolean {
  const evidence = parseRecord(evidenceJson);
  if (!evidence) return false;
  const surface = record(evidence.packagePublicSurface);
  if (!surface) return false;
  const body = record(surface.bodyEligibility);
  const exposures = surface.exposures;
  if (!body || !Array.isArray(exposures)) return false;
  const exactProof = [
    body.eligible === true,
    body.reason === target.bodyEligibility.reason,
    surface.recordCap === 256,
    surface.exposureTotal === exposures.length,
    surface.shownExposureCount === exposures.length,
    surface.omittedExposureCount === 0,
  ];
  if (exactProof.includes(false)) return false;
  return exposures.some((item) => {
    const exposure = record(item);
    return exposure?.entry === scope.entry
      && exposure.modulePath === scope.modulePath
      && exposure.publicName === scope.publicName;
  });
}

function targetSymbolIds(
  db: Db,
  repositoryId: number,
  scope: PackagePublicScope,
): number[] {
  return scope.targets.flatMap((target) => {
    if (!target.bodyEligibility.eligible) return [];
    const rows = db.prepare(`SELECT id,evidence_json evidenceJson FROM symbols
      WHERE repo_id=? AND source_file=? AND kind=? AND qualified_name=?
        AND start_offset=? AND end_offset=?
      ORDER BY id`).all(
      repositoryId,
      target.sourceFile,
      target.kind,
      target.qualifiedName,
      target.startOffset,
      target.endOffset,
    );
    return rows.flatMap((row) =>
      typeof row.id === 'number'
        && symbolEvidenceMatches(row.evidenceJson, target, scope)
        ? [row.id] : []);
  });
}

function scopeResolution(
  db: Db,
  repository: PackageRepository,
  scope: PackagePublicScope,
): PackageCallResolution {
  const ids = [...new Set(targetSymbolIds(db, repository.id, scope))];
  if (ids.length !== scope.eligibleCandidateCount) return unresolved(
    'public_surface_evidence_incomplete',
    {
      candidateCount: scope.candidateCount,
      eligibleCandidateCount: ids.length,
      candidateSetComplete: false,
      resolvedModulePath: scope.modulePath,
      targetRepoId: repository.id,
      repositoryCandidateIds: [repository.id],
    },
  );
  const base = {
    candidateCount: scope.candidateCount,
    eligibleCandidateCount: scope.eligibleCandidateCount,
    selectedCandidateCount: 0 as const,
    candidateSetComplete: scope.candidateSetComplete,
    resolvedModulePath: scope.modulePath,
    targetRepoId: repository.id,
    repositoryCandidateIds: [repository.id],
  };
  if (ids.length === 1 && ids[0] !== undefined) return {
    ...base,
    id: ids[0],
    status: 'resolved',
    reason: null,
    strategy: 'package_public_surface_exact',
    selectedCandidateCount: 1,
  };
  if (ids.length > 1) return {
    ...base,
    id: null,
    status: 'ambiguous',
    reason: 'package_public_target_ambiguous',
    strategy: 'package_public_surface_ambiguous',
  };
  return unresolved(
    scope.candidateCount > 0 && scope.eligibleCandidateCount === 0
      ? 'public_symbol_has_no_executable_body'
      : 'package_public_name_not_exposed',
    base,
  );
}

function resolvePackageCall(
  db: Db,
  call: PackageCallRow,
  repositories: Map<string, PackageRepository[]>,
): PackageCallResolution {
  const repository = repositoryScopeResolution(call, repositories);
  if ('status' in repository) return repository;
  const scope = publicScope(repository.surface, call.binding);
  if ('status' in scope) return {
    ...scope,
    targetRepoId: repository.id,
    repositoryCandidateIds: [repository.id],
  };
  return scopeResolution(db, repository, scope);
}

export function expectedPackageImportResolutions(
  db: Db,
  workspaceId: number,
  inputs: readonly PackageResolutionInput[],
): PackageResolutionResult[] {
  const repositories = repositoriesByPackage(db, workspaceId);
  return inputs.map((input) => ({
    callId: input.callId,
    ...resolvePackageCall(
      db,
      {
        id: input.callId,
        callerRepoId: 0,
        binding: input.binding,
        evidence: {},
      },
      repositories,
    ),
  }));
}

const resolverEvidenceKeys = new Set([
  'candidateStrategy', 'candidateCount', 'eligibleCandidateCount',
  'selectedCandidateCount', 'candidateSetComplete', 'resolvedModulePath',
  'resolvedTargetRepositoryId', 'unresolvedReason',
  'targetRepositoryCandidateCount', 'targetRepositoryCandidates',
  'shownTargetRepositoryCandidateCount',
  'omittedTargetRepositoryCandidateCount', 'publicSurface',
]);

function parserEvidence(
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(evidence).filter(
    ([key]) => !resolverEvidenceKeys.has(key),
  ));
}

function resolutionEvidence(
  call: PackageCallRow,
  resolution: PackageCallResolution,
): string {
  const ids = resolution.repositoryCandidateIds
    .slice(0, REPOSITORY_REFERENCE_CAP);
  return JSON.stringify({
    ...parserEvidence(call.evidence),
    candidateStrategy: resolution.strategy,
    candidateCount: resolution.candidateCount,
    eligibleCandidateCount: resolution.eligibleCandidateCount,
    selectedCandidateCount: resolution.selectedCandidateCount,
    candidateSetComplete: resolution.candidateSetComplete,
    unresolvedReason: resolution.reason,
    ...(resolution.resolvedModulePath
      ? { resolvedModulePath: resolution.resolvedModulePath } : {}),
    ...(resolution.targetRepoId
      ? { resolvedTargetRepositoryId: resolution.targetRepoId } : {}),
    targetRepositoryCandidateCount:
      resolution.repositoryCandidateIds.length,
    targetRepositoryCandidates: ids,
    shownTargetRepositoryCandidateCount: ids.length,
    omittedTargetRepositoryCandidateCount:
      resolution.repositoryCandidateIds.length - ids.length,
    ...(resolution.publicSurface
      ? { publicSurface: resolution.publicSurface } : {}),
  });
}

export function linkPackageImportSymbolCalls(
  db: Db,
  workspaceId: number,
): PackageSymbolLinkSummary {
  const repositories = repositoriesByPackage(db, workspaceId);
  const update = db.prepare(`UPDATE symbol_calls SET callee_symbol_id=?,
    status=?,unresolved_reason=?,evidence_json=? WHERE id=?`);
  const summary: PackageSymbolLinkSummary = {
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
  };
  for (const call of packageCallRows(db, workspaceId)) {
    const resolution = resolvePackageCall(db, call, repositories);
    update.run(
      resolution.id,
      resolution.status,
      resolution.reason,
      resolutionEvidence(call, resolution),
      call.id,
    );
    summary[resolution.status] += 1;
  }
  return summary;
}
