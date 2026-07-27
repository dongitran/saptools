import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';
import type {
  PackagePublicScope,
  PackagePublicSurfaceFact,
  PublicSurfaceTarget,
} from '../parsers/package-public-surface.js';
import {
  parsePackageImportReference,
  parsePackagePublicSurfaceFact,
} from '../parsers/package-fact-contract.js';
import type { SymbolImportReference } from
  '../parsers/symbol-import-bindings.js';
import type { PackageFactPhase } from './current-fact-semantics.js';
import {
  expectedPackageImportResolutions,
  type PackageCallResolution,
} from '../linker/package-import-symbol-resolver.js';
import {
  invalidPackageSymbolSurfaceCount,
} from './package-symbol-surface-semantics.js';

export interface PackageFactCategoryCount {
  category: string;
  count: number;
}

interface PackageCallRow {
  id: number;
  workspaceId: number;
  importSource: string | null;
  status: string;
  unresolvedReason: string | null;
  calleeSymbolId: number | null;
  evidence: Record<string, unknown>;
}

interface ProvenanceMissingRow {
  importSource?: unknown;
  status?: unknown;
  unresolvedReason?: unknown;
  calleeSymbolId?: unknown;
}

const unresolvedReasons = new Set([
  'package_repository_scope_ambiguous',
  'package_repository_not_indexed',
  'package_public_surface_unsupported',
  'public_surface_evidence_incomplete',
  'package_binding_type_only',
  'package_public_scope_duplicate',
  'package_public_name_not_exposed',
  'public_symbol_has_no_executable_body',
]);

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

function currentPredicate(alias: string): string {
  return `${alias}.fact_analyzer_version=?
    AND (? IS NULL OR ${alias}.workspace_id=?)`;
}

function category(
  name: string,
  count: number,
): PackageFactCategoryCount[] {
  return count > 0 ? [{ category: name, count }] : [];
}

function repositorySurfaceInvalidCount(
  db: Db,
  workspaceId?: number,
): number {
  const rows = db.prepare(`SELECT package_name packageName,
    package_public_surface_json surfaceJson FROM repositories r
    WHERE ${currentPredicate('r')}`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.filter((row) => {
    const packageName = typeof row.packageName === 'string'
      ? row.packageName : null;
    const parsed = parseRecord(row.surfaceJson);
    return !parsed
      || !parsePackagePublicSurfaceFact(parsed, packageName);
  }).length;
}

function packageCallRows(
  db: Db,
  workspaceId?: number,
): PackageCallRow[] {
  const rows = db.prepare(`SELECT sc.id,r.workspace_id workspaceId,
    sc.import_source importSource,sc.status,sc.unresolved_reason unresolvedReason,
    sc.callee_symbol_id calleeSymbolId,sc.evidence_json evidenceJson
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE ${currentPredicate('r')}
      AND (json_extract(sc.evidence_json,'$.relation')='package_import'
        OR json_extract(sc.evidence_json,
          '$.importBinding.moduleKind')='package')
    ORDER BY sc.id`).all(ANALYZER_VERSION, workspaceId, workspaceId);
  return rows.flatMap((row) => {
    const evidence = parseRecord(row.evidenceJson);
    return typeof row.id === 'number' && typeof row.workspaceId === 'number'
      && typeof row.status === 'string' && evidence
      ? [{
          id: row.id,
          workspaceId: row.workspaceId,
          importSource: typeof row.importSource === 'string'
            ? row.importSource : null,
          status: row.status,
          unresolvedReason: typeof row.unresolvedReason === 'string'
            ? row.unresolvedReason : null,
          calleeSymbolId: typeof row.calleeSymbolId === 'number'
            ? row.calleeSymbolId : null,
          evidence,
        }]
      : [];
  });
}

function nonRelativeImportInvalidCount(
  db: Db,
  workspaceId?: number,
): number {
  const rows = db.prepare(`SELECT sc.status,
    sc.unresolved_reason unresolvedReason,
    sc.callee_symbol_id calleeSymbolId,sc.import_source importSource,
    sc.evidence_json evidenceJson
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE ${currentPredicate('r')}
      AND sc.import_source IS NOT NULL
      AND sc.import_source NOT LIKE '.%'`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.filter((row) => !nonRelativeImportValid(row)).length;
}

function nonRelativeImportValid(
  row: Record<string, unknown>,
): boolean {
  const evidence = parseRecord(row.evidenceJson);
  if (!evidence) return false;
  if (evidence.candidateStrategy === 'package_import_provenance_missing')
    return provenanceMissingRowValid(row, evidence);
  const direct = parsePackageImportReference(evidence.importBinding);
  if (direct) return all([
    evidence.relation === 'package_import',
    evidence.derivedImportBinding === undefined,
    row.importSource === direct.rawModuleSpecifier,
    evidence.targetName === direct.requestedPublicName,
  ]);
  return !derivedPackageRowInvalid(row);
}

function provenanceMissingRowValid(
  row: ProvenanceMissingRow,
  evidence: Record<string, unknown>,
): boolean {
  return all([
    typeof row.importSource === 'string',
    !String(row.importSource).startsWith('.'),
    row.status === 'unresolved',
    row.calleeSymbolId === null,
    row.unresolvedReason === 'package_import_provenance_missing',
    evidence.candidateStrategy === 'package_import_provenance_missing',
    integerField(evidence, 'candidateCount') === 0,
    integerField(evidence, 'eligibleCandidateCount') === 0,
    integerField(evidence, 'selectedCandidateCount') === 0,
    evidence.candidateSetComplete === true,
    evidence.unresolvedReason === row.unresolvedReason,
  ]);
}

function integerField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const item = value[key];
  return Number.isInteger(item) && Number(item) >= 0
    ? Number(item) : undefined;
}

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function pendingValid(row: PackageCallRow): boolean {
  const evidence = row.evidence;
  return all([
    row.status === 'unresolved',
    row.calleeSymbolId === null,
    row.unresolvedReason === 'package_resolution_pending',
    evidence.candidateStrategy === 'package_import_pending',
    integerField(evidence, 'candidateCount') === 0,
    integerField(evidence, 'eligibleCandidateCount') === 0,
    integerField(evidence, 'selectedCandidateCount') === 0,
    evidence.candidateSetComplete === false,
    evidence.unresolvedReason === row.unresolvedReason,
    ...pendingDetailsAbsent(evidence),
  ]);
}

function pendingDetailsAbsent(
  evidence: Record<string, unknown>,
): boolean[] {
  return [
    evidence.resolvedModulePath === undefined,
    evidence.resolvedTargetRepositoryId === undefined,
    evidence.targetRepositoryCandidateCount === undefined,
    evidence.targetRepositoryCandidates === undefined,
    evidence.shownTargetRepositoryCandidateCount === undefined,
    evidence.omittedTargetRepositoryCandidateCount === undefined,
    evidence.publicSurface === undefined,
  ];
}

function repositoryReferencesValid(
  evidence: Record<string, unknown>,
): boolean {
  const total = integerField(evidence, 'targetRepositoryCandidateCount');
  const shown = integerField(
    evidence, 'shownTargetRepositoryCandidateCount',
  );
  const omitted = integerField(
    evidence, 'omittedTargetRepositoryCandidateCount',
  );
  const ids = evidence.targetRepositoryCandidates;
  return total !== undefined && shown !== undefined && omitted !== undefined
    && Array.isArray(ids) && ids.every((id) =>
      Number.isInteger(id) && Number(id) > 0)
    && new Set(ids).size === ids.length && ids.length === shown
    && shown <= 5 && shown + omitted === total;
}

function terminalMatrixValid(row: PackageCallRow): boolean {
  const strategy = row.evidence.candidateStrategy;
  const evidenceReason = row.evidence.unresolvedReason;
  if (!repositoryReferencesValid(row.evidence)
    || evidenceReason !== row.unresolvedReason) return false;
  if (row.status === 'resolved') return all([
    strategy === 'package_public_surface_exact',
    row.unresolvedReason === null,
    row.calleeSymbolId !== null,
  ]);
  if (row.status === 'ambiguous') return all([
    strategy === 'package_public_surface_ambiguous',
    row.unresolvedReason === 'package_public_target_ambiguous',
    row.calleeSymbolId === null,
  ]);
  return unresolvedMatrixValid(row, strategy);
}

function unresolvedMatrixValid(
  row: PackageCallRow,
  strategy: unknown,
): boolean {
  return all([
    row.status === 'unresolved',
    strategy === 'package_public_surface_unresolved',
    typeof row.unresolvedReason === 'string',
    unresolvedReasons.has(String(row.unresolvedReason)),
    row.calleeSymbolId === null,
  ]);
}

function targetRepositories(
  db: Db,
  workspaceId: number,
  binding: SymbolImportReference,
): Array<{ id: number; surface: PackagePublicSurfaceFact }> {
  const rows = db.prepare(`SELECT id,package_public_surface_json surfaceJson
    FROM repositories WHERE workspace_id=? AND package_name=?
    ORDER BY id`).all(workspaceId, binding.requestedPackageName);
  return rows.flatMap((row) => {
    const value = parseRecord(row.surfaceJson);
    const surface = value
      ? parsePackagePublicSurfaceFact(value, binding.requestedPackageName)
      : undefined;
    return typeof row.id === 'number' && surface
      ? [{ id: row.id, surface }] : [];
  });
}

function exactPublicScope(
  surface: PackagePublicSurfaceFact,
  binding: SymbolImportReference,
): PackagePublicScope | undefined {
  if (surface.status !== 'complete') return undefined;
  const scopes = surface.scopes.filter((scope) =>
    scope.entry === binding.requestedModuleSubpath
    && scope.publicName === binding.requestedPublicName);
  return scopes.length === 1 ? scopes[0] : undefined;
}

function selectedTarget(
  db: Db,
  symbolId: number,
  repositoryId: number,
  scope: PackagePublicScope,
): PublicSurfaceTarget | undefined {
  const row = db.prepare(`SELECT source_file sourceFile,kind,
    qualified_name qualifiedName,start_offset startOffset,
    end_offset endOffset,evidence_json evidenceJson FROM symbols
    WHERE id=? AND repo_id=?`).get(symbolId, repositoryId);
  if (!row) return undefined;
  return scope.targets.find((target) =>
    target.bodyEligibility.eligible
    && target.sourceFile === row.sourceFile && target.kind === row.kind
    && target.qualifiedName === row.qualifiedName
    && target.startOffset === row.startOffset && target.endOffset === row.endOffset
    && symbolExposureValid(row.evidenceJson, target, scope));
}

function symbolExposureValid(
  evidenceJson: unknown,
  target: PublicSurfaceTarget,
  scope: PackagePublicScope,
): boolean {
  const evidence = parseRecord(evidenceJson);
  if (!evidence) return false;
  const surface = record(evidence.packagePublicSurface);
  if (!surface) return false;
  const body = record(surface.bodyEligibility);
  if (!body) return false;
  const exposures = surface.exposures;
  if (!Array.isArray(exposures)) return false;
  if (!symbolExposureMetadataValid(
    surface, body, target, exposures.length,
  )) return false;
  return exposures.some((value) => exposureMatches(value, scope));
}

function symbolExposureMetadataValid(
  surface: Record<string, unknown>,
  body: Record<string, unknown>,
  target: PublicSurfaceTarget,
  exposureCount: number,
): boolean {
  return all([
    surface.schema === 'service-flow/package-public-surface@1',
    body.eligible === true,
    body.reason === target.bodyEligibility.reason,
    surface.recordCap === 256,
    surface.exposureTotal === exposureCount,
    surface.shownExposureCount === exposureCount,
    surface.omittedExposureCount === 0,
  ]);
}

function exposureMatches(
  value: unknown,
  scope: PackagePublicScope,
): boolean {
  const exposure = record(value);
  return all([
    exposure?.entry === scope.entry,
    exposure?.modulePath === scope.modulePath,
    exposure?.publicName === scope.publicName,
  ]);
}

function resolvedCountsValid(
  evidence: Record<string, unknown>,
  scope: PackagePublicScope,
  repositoryId: number,
): boolean {
  return evidence.resolvedModulePath === scope.modulePath
    && evidence.resolvedTargetRepositoryId === repositoryId
    && integerField(evidence, 'candidateCount') === scope.candidateCount
    && integerField(evidence, 'eligibleCandidateCount')
      === scope.eligibleCandidateCount
    && integerField(evidence, 'selectedCandidateCount') === 1
    && evidence.candidateSetComplete === true
    && integerField(evidence, 'targetRepositoryCandidateCount') === 1;
}

function resolvedProofValid(
  db: Db,
  row: PackageCallRow,
  binding: SymbolImportReference,
): boolean {
  if (row.calleeSymbolId === null) return false;
  const repositories = targetRepositories(db, row.workspaceId, binding);
  if (repositories.length !== 1 || !repositories[0]) return false;
  const repository = repositories[0];
  const scope = exactPublicScope(repository.surface, binding);
  if (!scope || scope.eligibleCandidateCount !== 1) return false;
  return Boolean(selectedTarget(
    db, row.calleeSymbolId, repository.id, scope,
  )) && resolvedCountsValid(row.evidence, scope, repository.id);
}

function publicSurfaceMatches(
  evidence: Record<string, unknown>,
  expected: PackageCallResolution,
): boolean {
  const actual = record(evidence.publicSurface);
  if (!expected.publicSurface) return actual === undefined;
  return actual?.total === expected.publicSurface.total
    && actual.shown === expected.publicSurface.shown
    && actual.omitted === expected.publicSurface.omitted;
}

function repositoryCandidatesMatch(
  evidence: Record<string, unknown>,
  expected: PackageCallResolution,
): boolean {
  const shown = expected.repositoryCandidateIds.slice(0, 5);
  const actual = evidence.targetRepositoryCandidates;
  return evidence.targetRepositoryCandidateCount
      === expected.repositoryCandidateIds.length
    && evidence.shownTargetRepositoryCandidateCount === shown.length
    && evidence.omittedTargetRepositoryCandidateCount
      === expected.repositoryCandidateIds.length - shown.length
    && Array.isArray(actual)
    && actual.length === shown.length
    && shown.every((id, index) =>
      actual[index] === id);
}

function expectedResolutionMatches(
  row: PackageCallRow,
  expected: PackageCallResolution,
): boolean {
  const evidence = row.evidence;
  return all([
    row.status === expected.status,
    row.calleeSymbolId === expected.id,
    row.unresolvedReason === expected.reason,
    evidence.candidateStrategy === expected.strategy,
    integerField(evidence, 'candidateCount') === expected.candidateCount,
    integerField(evidence, 'eligibleCandidateCount')
      === expected.eligibleCandidateCount,
    integerField(evidence, 'selectedCandidateCount')
      === expected.selectedCandidateCount,
    evidence.candidateSetComplete === expected.candidateSetComplete,
    evidence.unresolvedReason === expected.reason,
    evidence.resolvedModulePath === expected.resolvedModulePath,
    evidence.resolvedTargetRepositoryId === expected.targetRepoId,
    repositoryCandidatesMatch(evidence, expected),
    publicSurfaceMatches(evidence, expected),
  ]);
}

function expectedByCall(
  db: Db,
  rows: readonly PackageCallRow[],
  bindings: ReadonlyMap<number, SymbolImportReference>,
): Map<number, PackageCallResolution> {
  const result = new Map<number, PackageCallResolution>();
  const workspaces = new Set(rows.map((row) => row.workspaceId));
  for (const workspaceId of workspaces) {
    const inputs = rows.filter((row) => row.workspaceId === workspaceId)
      .flatMap((row) => {
        const binding = bindings.get(row.id);
        return binding ? [{ callId: row.id, binding }] : [];
      });
    for (const expected of expectedPackageImportResolutions(
      db, workspaceId, inputs,
    )) result.set(expected.callId, expected);
  }
  return result;
}

function invalidPackageCallCount(
  db: Db,
  workspaceId: number | undefined,
  phase: PackageFactPhase,
): number {
  const rows = packageCallRows(db, workspaceId);
  const bindings = new Map(rows.flatMap((row) => {
    const binding = parsePackageImportReference(row.evidence.importBinding);
    return binding ? [[row.id, binding] as const] : [];
  }));
  const expected = expectedByCall(db, rows, bindings);
  return rows.filter((row) => packageCallInvalid(
    db, row, bindings.get(row.id), expected.get(row.id), phase,
  )).length;
}

function packageCallInvalid(
  db: Db,
  row: PackageCallRow,
  binding: SymbolImportReference | undefined,
  expected: PackageCallResolution | undefined,
  phase: PackageFactPhase,
): boolean {
  if (row.evidence.candidateStrategy === 'package_import_provenance_missing')
    return !provenanceMissingRowValid(row, row.evidence);
  if (!binding || !packageProvenanceValid(row, binding)) return true;
  if (row.evidence.candidateStrategy === 'package_import_pending')
    return phase === 'terminal' || !pendingValid(row);
  if (!terminalMatrixValid(row) || !expected) return true;
  if (!expectedResolutionMatches(row, expected)) return true;
  return row.status === 'resolved' && !resolvedProofValid(db, row, binding);
}

function packageProvenanceValid(
  row: PackageCallRow,
  binding: SymbolImportReference,
): boolean {
  return all([
    row.evidence.relation === 'package_import',
    row.evidence.derivedImportBinding === undefined,
    row.importSource === binding.rawModuleSpecifier,
    row.evidence.targetName === binding.requestedPublicName,
  ]);
}

function derivedPackageInvalidCount(
  db: Db,
  workspaceId?: number,
): number {
  const rows = db.prepare(`SELECT sc.status,
    sc.unresolved_reason unresolvedReason,
    sc.callee_symbol_id calleeSymbolId,sc.import_source importSource,
    sc.evidence_json evidenceJson
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE ${currentPredicate('r')}
      AND (json_extract(sc.evidence_json,'$.relation')
          ='package_import_derived_member'
        OR json_extract(sc.evidence_json,
          '$.derivedImportBinding.moduleKind')='package')`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.filter(derivedPackageRowInvalid).length;
}

function derivedPackageRowInvalid(row: Record<string, unknown>): boolean {
  const evidence = parseRecord(row.evidenceJson);
  if (evidence?.candidateStrategy === 'package_import_provenance_missing')
    return !provenanceMissingRowValid(row, evidence);
  const binding = evidence
    ? parsePackageImportReference(evidence.derivedImportBinding)
    : undefined;
  if (!evidence || !binding) return true;
  return !all([
    row.importSource === binding.rawModuleSpecifier,
    evidence.relation === 'package_import_derived_member',
    row.status === 'unresolved',
    row.calleeSymbolId === null,
    row.unresolvedReason === 'package_derived_member_provenance_insufficient',
    evidence.candidateStrategy
      === 'package_import_derived_member_unsupported',
    integerField(evidence, 'candidateCount') === 0,
    integerField(evidence, 'eligibleCandidateCount') === 0,
    integerField(evidence, 'selectedCandidateCount') === 0,
    evidence.candidateSetComplete === true,
    evidence.unresolvedReason === row.unresolvedReason,
    evidence.importBinding === undefined,
    derivedPackageTargetValid(evidence, binding),
  ]);
}

function derivedPackageTargetValid(
  evidence: Record<string, unknown>,
  binding: SymbolImportReference,
): boolean {
  if (typeof binding.referencedMemberName !== 'string') return false;
  const proxy = typeof evidence.proxyVariableName === 'string';
  return evidence.targetName === (proxy
    ? binding.referencedMemberName
    : binding.requestedPublicName);
}

export function invalidPackageFactCategories(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): PackageFactCategoryCount[] {
  return [
    ...category(
      'repository_package_public_surface_invalid',
      repositorySurfaceInvalidCount(db, workspaceId),
    ),
    ...category(
      'symbol_package_public_surface_invalid',
      invalidPackageSymbolSurfaceCount(db, workspaceId),
    ),
    ...category(
      'package_import_fact_or_target_invalid',
      invalidPackageCallCount(db, workspaceId, phase),
    ),
    ...category(
      'package_derived_member_fact_invalid',
      derivedPackageInvalidCount(db, workspaceId),
    ),
    ...category(
      'package_import_provenance_marker_invalid',
      nonRelativeImportInvalidCount(db, workspaceId),
    ),
  ];
}
