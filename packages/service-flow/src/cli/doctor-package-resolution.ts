import type { Db } from '../db/connection.js';

type Diagnostic = Record<string, unknown>;

function pendingPredicate(alias: string): string {
  return `${alias}.status='unresolved'
    AND ${alias}.callee_symbol_id IS NULL
    AND ${alias}.unresolved_reason='package_resolution_pending'
    AND json_extract(${alias}.evidence_json,'$.relation')='package_import'
    AND json_extract(${alias}.evidence_json,
      '$.importBinding.moduleKind')='package'
    AND json_extract(${alias}.evidence_json,
      '$.candidateStrategy')='package_import_pending'
    AND json_extract(${alias}.evidence_json,'$.candidateCount')=0
    AND json_extract(${alias}.evidence_json,'$.eligibleCandidateCount')=0
    AND json_extract(${alias}.evidence_json,'$.selectedCandidateCount')=0
    AND json_extract(${alias}.evidence_json,'$.candidateSetComplete')=0`;
}

function count(db: Db, sql: string): number {
  return Number(db.prepare(sql).get()?.count ?? 0);
}

export function packagePendingDiagnostics(db: Db): Diagnostic[] {
  const pending = count(db, `SELECT COUNT(*) count FROM symbol_calls sc
    WHERE ${pendingPredicate('sc')}`);
  if (pending === 0) return [];
  const stale = count(db, `SELECT COUNT(*) count FROM repositories
    WHERE graph_stale_reason IS NOT NULL`);
  return [{
    severity: 'warning',
    code: 'package_import_resolution_pending',
    message: 'Package-import facts await workspace linking; terminal package-resolution quality is deferred.',
    packageResolutionState: 'pre_link_pending',
    pendingPackageImportCount: pending,
    graphState: 'stale',
    staleRepositoryCount: stale,
    requiredAction: 'relink',
    remediation: 'service-flow link --workspace /workspace --force',
  }];
}

export function symbolCallQuality(db: Db): Diagnostic {
  const terminal = `NOT (${pendingPredicate('sc')})`;
  const row = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN sc.status='resolved' THEN 1 ELSE 0 END) resolved,
    SUM(CASE WHEN sc.status='unresolved' THEN 1 ELSE 0 END) unresolved
    FROM symbol_calls sc WHERE ${terminal}`).get();
  const top = db.prepare(`SELECT sc.callee_expression calleeExpression,
    COUNT(*) count FROM symbol_calls sc
    WHERE sc.status='unresolved' AND ${terminal}
    GROUP BY sc.callee_expression
    ORDER BY count DESC,sc.callee_expression COLLATE BINARY LIMIT 5`).all();
  const total = Number(row?.total ?? 0);
  const unresolved = Number(row?.unresolved ?? 0);
  const ratio = total === 0 ? 0 : Number((unresolved / total).toFixed(4));
  return {
    severity: ratio > 0.05 ? 'warning' : 'info',
    code: 'strict_symbol_call_quality',
    message: 'Terminal symbol-call quality aggregate',
    total,
    resolved: Number(row?.resolved ?? 0),
    unresolved,
    unresolvedRatio: ratio,
    unresolvedRatioThreshold: 0.05,
    topUnresolvedCallees: top,
  };
}
