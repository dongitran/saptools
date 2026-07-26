import type { Db } from '../db/connection.js';
import { extractPlaceholderKeys } from '../utils/placeholders.js';
import { canonicalImplementationEvidence } from './implementation-candidates.js';
export interface OperationTarget {
  operationId: number;
  repoName: string;
  serviceName: string;
  qualifiedName: string;
  servicePath: string;
  operationPath: string;
  operationName: string;
  sourceFile: string;
  sourceLine: number;
  repoId?: number;
  packageName?: string | null;
  score: number;
  reasons: string[];
}
export interface OperationResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'dynamic';
  target?: OperationTarget;
  candidates: OperationTarget[];
  reasons: string[];
}
interface OperationSignals {
  servicePath?: string;
  alias?: string;
  destination?: string;
  operationPath?: string;
  serviceName?: string;
  repoId?: number;
  hasExplicitOverride?: boolean;
  isDynamic?: boolean;
  localServiceLookup?: string;
}
function rows(
  db: Db,
  operationPath: string,
  workspaceId?: number,
): OperationTarget[] {
  const names = operationLookupNames(operationPath);
  const result = db
    .prepare(
      `SELECT o.id operationId,r.id repoId,r.name repoName,r.package_name packageName,s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,o.source_line sourceLine,0 score
       FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
       WHERE (? IS NULL OR r.workspace_id=?) AND (o.operation_path IN (?,?) OR o.operation_name IN (?,?)) ORDER BY r.name,s.service_path,o.operation_name`,
    )
    .all(
      workspaceId,
      workspaceId,
      names.path,
      names.simplePath,
      names.name,
      names.simpleName,
    ) as Array<Omit<OperationTarget, 'reasons'>>;
  return result.map((row) => ({
    ...row,
    score: Number(row.score ?? 0),
    reasons: [],
  }));
}
function operationLookupNames(operationPath: string): { path: string; simplePath: string; name: string; simpleName: string } {
  const name = operationPath.replace(/^\//, '');
  const simpleName = name.split('.').at(-1) ?? name;
  return { path: operationPath, simplePath: `/${simpleName}`, name, simpleName };
}
function operationMatches(candidate: OperationTarget, operationPath: string | undefined): boolean {
  if (!operationPath) return false;
  const names = operationLookupNames(operationPath);
  return candidate.operationPath === names.path || candidate.operationPath === names.simplePath || candidate.operationName === names.name || candidate.operationName === names.simpleName;
}
export function resolveOperation(
  db: Db,
  signals: OperationSignals,
  workspaceId?: number,
): OperationResolution {
  const early = earlyOperationResolution(db, signals, workspaceId);
  if (early) return early;
  const selected = selectOperationCandidates(db, signals, workspaceId);
  if (!Array.isArray(selected)) return selected;
  const candidates = scoreOperationCandidates(selected, signals);
  return finalOperationResolution(candidates, signals);
}

function earlyOperationResolution(
  db: Db,
  signals: OperationSignals,
  workspaceId: number | undefined,
): OperationResolution | undefined {
  const missing = [signals.servicePath, signals.alias, signals.destination, signals.operationPath]
    .flatMap(extractPlaceholderKeys);
  if (missing.length > 0)
    return {
      status: 'dynamic',
      candidates: dynamicOperationCandidates(
        db, signals.operationPath, workspaceId,
      ),
      reasons: [...new Set(missing)].map((name) => `missing_variable:${name}`),
    };
  if (!signals.operationPath)
    return {
      status: 'unresolved',
      candidates: [],
      reasons: ['missing_operation_path'],
    };
  return undefined;
}

function dynamicOperationCandidates(
  db: Db,
  operationPath: string | undefined,
  workspaceId: number | undefined,
): OperationTarget[] {
  if (!operationPath || extractPlaceholderKeys(operationPath).length > 0)
    return [];
  return rows(db, operationPath, workspaceId).map((candidate) => ({
    ...candidate,
    score: 0.2,
    reasons: ['operation_path_match'],
  }));
}

function selectOperationCandidates(
  db: Db,
  signals: OperationSignals,
  workspaceId?: number,
): OperationTarget[] | OperationResolution {
  const operationPath = signals.operationPath ?? '';
  const allCandidates = rows(db, operationPath, workspaceId).map((c) => ({
    ...c,
    score: 0.2,
    reasons: ['operation_path_match'],
  }));
  let candidates = allCandidates.filter((c) => matchesLocalRepo(db, c.operationId, signals.repoId));
  if (candidates.length === 0 && signals.repoId !== undefined
    && signals.serviceName)
    candidates = implementationContextCandidates(
      db, allCandidates, signals.repoId, signals.serviceName,
    );
  if (candidates.length === 0 && signals.repoId !== undefined
    && signals.serviceName)
    return missingOwnedCandidate(allCandidates, signals.serviceName);
  if (candidates.length === 0)
    return {
      status: 'unresolved',
      candidates: [],
      reasons: ['no_operation_candidates'],
    };
  return candidates;
}

function missingOwnedCandidate(
  candidates: OperationTarget[],
  serviceName: string,
): OperationResolution {
  const matching = candidates.filter((candidate) =>
    serviceMatches(candidate, serviceName));
  return {
    status: 'unresolved',
    candidates: matching,
    reasons: matching.length > 0
      ? ['local_service_candidate_without_caller_ownership']
      : ['no_operation_candidates'],
  };
}

function scoreOperationCandidates(
  candidates: OperationTarget[],
  signals: OperationSignals,
): OperationTarget[] {
  for (const c of candidates) {
    applyServicePathScore(c, signals.servicePath);
    applyServiceNameScore(c, signals.serviceName, candidates);
    applyOverrideScore(c, signals);
    applyUniquePathRecovery(c, candidates, signals);
    c.score = Math.max(0, Math.min(1, c.score));
  }
  candidates.sort(
    (a, b) => b.score - a.score || compareBinary(a.repoName, b.repoName),
  );
  return candidates;
}

function applyServicePathScore(
  candidate: OperationTarget,
  servicePath: string | undefined,
): void {
  if (!servicePath) return;
  const exact = candidate.servicePath === servicePath;
  candidate.score += exact ? 0.75 : -0.1;
  candidate.reasons.push(exact ? 'exact_service_path' : 'service_path_mismatch');
}

function serviceNameScore(
  candidate: OperationTarget,
  serviceName: string,
  candidates: readonly OperationTarget[],
): { score: number; reason: string } {
  const simple = serviceName.split('.').at(-1) ?? serviceName;
  if (candidate.qualifiedName === serviceName)
    return { score: 0.8, reason: 'exact_local_qualified_service_name' };
  if (candidate.serviceName === serviceName || candidate.serviceName === simple)
    return { score: 0.75, reason: 'exact_local_simple_service_name' };
  if ([serviceName, `/${serviceName}`, `/${simple}`]
    .includes(candidate.servicePath))
    return { score: 0.7, reason: 'exact_local_service_path' };
  if (candidate.servicePath.endsWith(`/${simple}`)) return {
    score: candidates.filter((item) =>
      item.servicePath.endsWith(`/${simple}`)).length === 1 ? 0.65 : 0.2,
    reason: 'suffix_local_service_path',
  };
  return { score: 0, reason: 'local_service_name_mismatch' };
}

function applyServiceNameScore(
  candidate: OperationTarget,
  serviceName: string | undefined,
  candidates: readonly OperationTarget[],
): void {
  if (!serviceName) return;
  const signal = serviceNameScore(candidate, serviceName, candidates);
  candidate.score += signal.score;
  candidate.reasons.push(signal.reason);
}

function applyOverrideScore(
  candidate: OperationTarget,
  signals: OperationSignals,
): void {
  if (!signals.hasExplicitOverride) return;
  candidate.score += 0.2;
  candidate.reasons.push(signals.repoId !== undefined
    ? 'explicit_local_service_call' : 'explicit_dynamic_override');
}

function applyUniquePathRecovery(
  candidate: OperationTarget,
  candidates: readonly OperationTarget[],
  signals: OperationSignals,
): void {
  if (signals.repoId === undefined || candidates.length !== 1
    || !signals.serviceName
    || !candidate.reasons.includes('local_service_name_mismatch')
    || !operationMatches(candidate, signals.operationPath)) return;
  candidate.score = Math.max(candidate.score, 0.9);
  candidate.reasons.push(
    'same_repo_unique_operation_path_with_lookup_mismatch',
  );
}

function strongSignal(signals: OperationSignals): boolean {
  return Boolean(signals.servicePath || signals.serviceName || signals.alias
    || signals.destination || signals.hasExplicitOverride);
}

function targetSignalMatches(
  candidate: OperationTarget,
  signals: OperationSignals,
): boolean {
  if (candidate.servicePath === signals.servicePath) return true;
  if (!signals.serviceName) return false;
  return !candidate.reasons.includes('local_service_name_mismatch')
    || candidate.reasons.includes(
      'same_repo_unique_operation_path_with_lookup_mismatch',
    );
}

function bestCandidateResolves(
  best: OperationTarget | undefined,
  second: OperationTarget | undefined,
  signals: OperationSignals,
): best is OperationTarget {
  if (!best) return false;
  return best.score >= 0.9
    && targetSignalMatches(best, signals)
    && operationMatches(best, signals.operationPath)
    && (!second || best.score - second.score >= 0.25);
}

function finalOperationResolution(
  candidates: OperationTarget[],
  signals: OperationSignals,
): OperationResolution {
  const best = candidates[0];
  const second = candidates[1];
  if (signals.isDynamic && !signals.hasExplicitOverride && !signals.servicePath)
    return {
      status: 'dynamic',
      candidates,
      reasons: ['dynamic_target_without_override'],
    };
  if (!strongSignal(signals))
    return {
      status: candidates.length > 1 ? 'ambiguous' : 'unresolved',
      candidates,
      reasons: ['operation_path_only_has_no_strong_target_signal'],
    };
  if (bestCandidateResolves(best, second, signals))
    return {
      status: 'resolved',
      target: best,
      candidates,
      reasons: best.reasons,
    };
  return {
    status: candidates.length > 1 ? 'ambiguous' : 'unresolved',
    candidates,
    reasons: ['candidate_score_below_resolution_threshold'],
  };
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function serviceMatches(candidate: OperationTarget, serviceName: string | undefined): boolean {
  if (!serviceName) return false;
  const simple = serviceName.split('.').at(-1) ?? serviceName;
  return candidate.qualifiedName === serviceName || candidate.serviceName === serviceName || candidate.serviceName === simple || candidate.servicePath === serviceName || candidate.servicePath === `/${serviceName}` || candidate.servicePath === `/${simple}` || candidate.servicePath.endsWith(`/${simple}`);
}
function implementationContextCandidates(db: Db, candidates: OperationTarget[], callerRepoId: number, serviceName: string): OperationTarget[] {
  const matching = candidates.filter((candidate) => serviceMatches(candidate, serviceName));
  const owned = matching.map((candidate) => ownershipReason(db, candidate, callerRepoId)).filter((item): item is { candidate: OperationTarget; reason: string } => Boolean(item));
  if (owned.length === 0) return [];
  const direct = owned.filter((item) => item.reason !== 'caller_depends_on_model_package');
  const chosen = direct.length > 0 ? direct : owned.length === 1 ? owned : [];
  return chosen.map((item) => ({ ...item.candidate, score: 0.95, reasons: [...item.candidate.reasons, 'implementation_context_caller_ownership', item.reason] }));
}
function ownershipReason(db: Db, candidate: OperationTarget, callerRepoId: number): { candidate: OperationTarget; reason: string } | undefined {
  const edge = db.prepare("SELECT status,evidence_json,to_id FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND from_kind='operation' AND from_id=? ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END LIMIT 1").get(String(candidate.operationId)) as { status?: string; evidence_json?: string; to_id?: string } | undefined;
  if (edge?.status === 'resolved') {
    const row = db.prepare('SELECT hc.repo_id repoId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id WHERE hm.id=?').get(edge.to_id) as { repoId?: number } | undefined;
    if (row?.repoId === callerRepoId) return { candidate, reason: 'resolved_implementation_handler_repo_matches_caller' };
  }
  if (edge?.evidence_json) {
    const stored = parsedRecord(edge.evidence_json);
    const evidence = canonicalImplementationEvidence(db, candidate.operationId) ?? stored;
    const hit = implementationEvidenceCandidates(evidence).find((item) =>
      item.accepted && (item.handlerRepoId === callerRepoId
        || item.applicationRepoId === callerRepoId));
    if (hit) return { candidate, reason: edge.status === 'ambiguous' ? 'ambiguous_implementation_candidate_repo_matches_caller' : 'registration_package_matches_caller' };
  }
  const dep = db.prepare("SELECT 1 FROM graph_edges WHERE edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND status='resolved' AND from_kind='repo' AND from_id=? AND to_id=?").get(String(callerRepoId), String(candidate.repoId));
  if (dep) return { candidate, reason: 'caller_depends_on_model_package' };
  return undefined;
}

function implementationEvidenceCandidates(
  evidence: Record<string, unknown>,
): Array<{ accepted: boolean; handlerRepoId?: number; applicationRepoId?: number }> {
  const candidates = evidence.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const row = candidate;
    const handler = recordValue(row.handlerPackage);
    const application = recordValue(row.applicationPackage);
    return [{
      accepted: row.accepted === true,
      handlerRepoId: numberValue(handler.id),
      applicationRepoId: numberValue(application.id),
    }];
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parsedRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function matchesLocalRepo(db: Db, operationId: number, repoId: number | undefined): boolean {
  if (repoId === undefined) return true;
  const row = db.prepare('SELECT s.repo_id repoId FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?').get(operationId) as { repoId?: number } | undefined;
  return row?.repoId === repoId;
}
export function findOperation(
  db: Db,
  servicePath: string | undefined,
  operationPath: string | undefined,
  workspaceId?: number,
): OperationTarget | undefined {
  return resolveOperation(db, { servicePath, operationPath }, workspaceId)
    .target;
}
