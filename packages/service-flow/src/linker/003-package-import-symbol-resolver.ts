import type { Db } from '../db/connection.js';

export interface PackageSymbolLinkSummary {
  resolved: number;
  ambiguous: number;
  unresolved: number;
}

interface RepoExports {
  publicName: Map<string, number[]>;
  qualified: Map<string, number[]>;
  fileById: Map<number, string>;
}

interface PackageCallRow {
  id: number;
  callerRepoId: number;
  calleeExpression: string;
  importSource: string;
  evidence: Record<string, unknown>;
}

interface PackageCallResolution {
  id: number | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason: string | null;
  strategy: 'package_import_workspace_resolved' | 'package_import_ambiguous' | 'package_import_unresolved';
  candidateCount: number;
  resolvedModulePath?: string;
}

const unresolvedRepositoryReason = 'Package import target resolution requires a post-publication workspace pass';
const unresolvedSymbolReason = 'Sibling package indexed but no matching exported symbol; the target may be a re-export, barrel, type-only export, or unindexed Receiver.member';
const ambiguousSymbolReason = 'Multiple exported sibling-package symbol targets matched exactly';
const stripExt = (value: string): string => value.replace(/\.(ts|tsx|js|jsx|cds)$/, '');

function push(map: Map<string, number[]>, key: string, id: number): void {
  const existing = map.get(key);
  if (existing) existing.push(id);
  else map.set(key, [id]);
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function evidenceObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function repoByPackageName(db: Db, workspaceId: number): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const rows = db.prepare(`SELECT id,package_name packageName FROM repositories
    WHERE workspace_id=? AND package_name IS NOT NULL ORDER BY package_name,id`).all(workspaceId);
  for (const row of rows) {
    const packageName = nullableString(row.packageName);
    if (!packageName || typeof row.id !== 'number') continue;
    result.set(packageName, result.has(packageName) ? null : row.id);
  }
  return result;
}

function packagePrefix(importSource: string): string {
  const parts = importSource.split('/');
  if (importSource.startsWith('@')) return parts.length >= 2 ? parts.slice(0, 2).join('/') : importSource;
  return parts[0] ?? importSource;
}

function packageRepoId(repos: Map<string, number | null>, importSource: string): number | null {
  const packageName = repos.has(importSource) ? importSource : packagePrefix(importSource);
  return repos.get(packageName) ?? null;
}

function emptyRepoExports(): RepoExports {
  return { publicName: new Map(), qualified: new Map(), fileById: new Map() };
}

function exportsByRepo(db: Db, workspaceId: number): Map<number, RepoExports> {
  const result = new Map<number, RepoExports>();
  const rows = db.prepare(`SELECT s.id,s.repo_id repoId,s.name,s.exported_name exportedName,
      s.qualified_name qualifiedName,s.source_file sourceFile
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE r.workspace_id=? AND s.exported=1 ORDER BY s.repo_id,s.id`).all(workspaceId);
  for (const row of rows) addExportRow(result, row);
  return result;
}

function addExportRow(result: Map<number, RepoExports>, row: Record<string, unknown>): void {
  if (typeof row.id !== 'number' || typeof row.repoId !== 'number') return;
  const exports = result.get(row.repoId) ?? emptyRepoExports();
  result.set(row.repoId, exports);
  const publicName = nullableString(row.exportedName) ?? nullableString(row.name);
  const qualifiedName = nullableString(row.qualifiedName);
  const sourceFile = nullableString(row.sourceFile);
  if (publicName) push(exports.publicName, publicName, row.id);
  if (qualifiedName) push(exports.qualified, qualifiedName, row.id);
  if (sourceFile) exports.fileById.set(row.id, stripExt(sourceFile));
}

function packageCallRows(db: Db, workspaceId: number): PackageCallRow[] {
  const rows = db.prepare(`SELECT sc.id,sc.repo_id callerRepoId,
      sc.callee_expression calleeExpression,sc.import_source importSource,
      sc.evidence_json evidenceJson
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE r.workspace_id=? AND sc.import_source IS NOT NULL
      AND sc.import_source NOT LIKE './%' AND sc.import_source NOT LIKE '../%'
      AND json_extract(sc.evidence_json,'$.relation')='package_import'
      AND json_extract(sc.evidence_json,'$.candidateStrategy') IN
        ('package_import_unresolved','package_import_workspace_resolved','package_import_ambiguous')
    ORDER BY sc.id`).all(workspaceId);
  return rows.flatMap((row) => packageCallRow(row));
}

function packageCallRow(row: Record<string, unknown>): PackageCallRow[] {
  const calleeExpression = nullableString(row.calleeExpression);
  const importSource = nullableString(row.importSource);
  if (typeof row.id !== 'number' || typeof row.callerRepoId !== 'number'
    || !calleeExpression || !importSource) return [];
  return [{
    id: row.id,
    callerRepoId: row.callerRepoId,
    calleeExpression,
    importSource,
    evidence: evidenceObject(row.evidenceJson),
  }];
}

function candidatesForCall(call: PackageCallRow, exports: RepoExports | undefined): number[] {
  if (!exports) return [];
  const dotCount = [...call.calleeExpression].filter((character) => character === '.').length;
  if (dotCount === 0) {
    const targetName = nullableString(call.evidence.targetName);
    return targetName ? exports.publicName.get(targetName) ?? [] : [];
  }
  return dotCount === 1 ? exports.qualified.get(call.calleeExpression) ?? [] : [];
}

function resolvePackageCall(
  call: PackageCallRow,
  repos: Map<string, number | null>,
  exports: Map<number, RepoExports>,
): PackageCallResolution {
  const targetRepoId = packageRepoId(repos, call.importSource);
  if (targetRepoId === null || targetRepoId === call.callerRepoId) return unresolvedResolution(unresolvedRepositoryReason);
  const repoExports = exports.get(targetRepoId);
  const candidates = candidatesForCall(call, repoExports);
  const [id] = candidates;
  if (candidates.length === 1 && id !== undefined) {
    return {
      id, status: 'resolved', reason: null, strategy: 'package_import_workspace_resolved',
      candidateCount: 1, resolvedModulePath: repoExports?.fileById.get(id),
    };
  }
  if (candidates.length > 1) {
    return { id: null, status: 'ambiguous', reason: ambiguousSymbolReason, strategy: 'package_import_ambiguous', candidateCount: candidates.length };
  }
  return unresolvedResolution(unresolvedSymbolReason);
}

function unresolvedResolution(reason: string): PackageCallResolution {
  return { id: null, status: 'unresolved', reason, strategy: 'package_import_unresolved', candidateCount: 0 };
}

function resolutionEvidence(call: PackageCallRow, resolution: PackageCallResolution): string {
  const evidence: Record<string, unknown> = {
    ...call.evidence,
    candidateStrategy: resolution.strategy,
    candidateCount: resolution.candidateCount,
  };
  if (resolution.resolvedModulePath) evidence.resolvedModulePath = resolution.resolvedModulePath;
  else delete evidence.resolvedModulePath;
  return JSON.stringify(evidence);
}

export function linkPackageImportSymbolCalls(db: Db, workspaceId: number): PackageSymbolLinkSummary {
  const repos = repoByPackageName(db, workspaceId);
  const exports = exportsByRepo(db, workspaceId);
  const update = db.prepare(`UPDATE symbol_calls SET callee_symbol_id=?,status=?,
    unresolved_reason=?,evidence_json=? WHERE id=?`);
  const summary: PackageSymbolLinkSummary = { resolved: 0, ambiguous: 0, unresolved: 0 };
  for (const call of packageCallRows(db, workspaceId)) {
    const resolution = resolvePackageCall(call, repos, exports);
    update.run(resolution.id, resolution.status, resolution.reason, resolutionEvidence(call, resolution), call.id);
    summary[resolution.status] += 1;
  }
  return summary;
}
