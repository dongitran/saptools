import type { Db } from '../db/connection.js';
export interface OperationTarget {
  operationId: number;
  repoName: string;
  servicePath: string;
  operationPath: string;
  operationName: string;
  sourceFile: string;
  sourceLine: number;
  score: number;
  reasons: string[];
}
export interface OperationResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'dynamic';
  target?: OperationTarget;
  candidates: OperationTarget[];
  reasons: string[];
}
function rows(
  db: Db,
  operationPath: string,
  workspaceId?: number,
): OperationTarget[] {
  return db
    .prepare(
      `SELECT o.id operationId,r.name repoName,s.service_path servicePath,o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,o.source_line sourceLine,0 score,'' reasons
       FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
       WHERE (? IS NULL OR r.workspace_id=?) AND (o.operation_path=? OR o.operation_name=?) ORDER BY r.name,s.service_path,o.operation_name`,
    )
    .all(
      workspaceId,
      workspaceId,
      operationPath,
      operationPath.replace(/^\//, ''),
    ) as unknown as OperationTarget[];
}
export function resolveOperation(
  db: Db,
  signals: {
    servicePath?: string;
    alias?: string;
    destination?: string;
    operationPath?: string;
    hasExplicitOverride?: boolean;
    isDynamic?: boolean;
  },
  workspaceId?: number,
): OperationResolution {
  const missing = [signals.servicePath, signals.alias, signals.destination, signals.operationPath].flatMap((value) => [...(value ?? '').matchAll(/\$\{\s*(\w+)\s*\}/g)].map((match) => match[1] ?? '')).filter(Boolean);
  if (missing.length > 0)
    return {
      status: 'dynamic',
      candidates: signals.operationPath ? rows(db, signals.operationPath, workspaceId) : [],
      reasons: [...new Set(missing)].map((name) => `missing_variable:${name}`),
    };
  if (!signals.operationPath)
    return {
      status: 'unresolved',
      candidates: [],
      reasons: ['missing_operation_path'],
    };
  const candidates = rows(db, signals.operationPath, workspaceId).map((c) => ({
    ...c,
    score: 0.2,
    reasons: ['operation_path_match'],
  }));
  if (candidates.length === 0)
    return {
      status: 'unresolved',
      candidates: [],
      reasons: ['no_operation_candidates'],
    };
  const hasStrongSignal = Boolean(
    signals.servicePath ||
    signals.alias ||
    signals.destination ||
    signals.hasExplicitOverride,
  );
  for (const c of candidates) {
    if (signals.servicePath && c.servicePath === signals.servicePath) {
      c.score += 0.75;
      c.reasons.push('exact_service_path');
    }
    if (signals.servicePath && c.servicePath !== signals.servicePath) {
      c.score -= 0.1;
      c.reasons.push('service_path_mismatch');
    }
    if (signals.hasExplicitOverride) {
      c.score += 0.2;
      c.reasons.push('explicit_dynamic_override');
    }
  }
  for (const c of candidates) c.score = Math.max(0, Math.min(1, c.score));
  candidates.sort(
    (a, b) => b.score - a.score || a.repoName.localeCompare(b.repoName),
  );
  const best = candidates[0];
  const second = candidates[1];
  if (signals.isDynamic && !signals.hasExplicitOverride && !signals.servicePath)
    return {
      status: 'dynamic',
      candidates,
      reasons: ['dynamic_target_without_override'],
    };
  if (!hasStrongSignal)
    return {
      status: candidates.length > 1 ? 'ambiguous' : 'unresolved',
      candidates,
      reasons: ['operation_path_only_has_no_strong_target_signal'],
    };
  if (
    best &&
    best.score >= 0.9 &&
    best.servicePath === signals.servicePath &&
    (best.operationPath === signals.operationPath || best.operationName === signals.operationPath.replace(/^\//, '')) &&
    (!second || best.score - second.score >= 0.25)
  )
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
export function findOperation(
  db: Db,
  servicePath: string | undefined,
  operationPath: string | undefined,
  workspaceId?: number,
): OperationTarget | undefined {
  return resolveOperation(db, { servicePath, operationPath }, workspaceId)
    .target;
}
