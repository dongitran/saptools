import type { Db } from '../db/connection.js';
import { factLifecycleDiagnostic } from '../db/001-fact-lifecycle.js';
import { ANALYZER_VERSION } from '../version.js';

type Diagnostic = Record<string, unknown>;

export function linkUpgradeWarnings(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  const lifecycle = factLifecycleDiagnostic(db, workspaceId);
  if (lifecycle) return [lifecycle];
  return [
    ...schemaDriftDiagnostics(db, true, workspaceId),
    ...analyzerVersionDiagnostics(db, true, workspaceId),
  ].filter((item) => [
    'schema_legacy_columns_present',
    'external_target_columns_missing_data',
    'reindex_required_after_upgrade',
    'reindex_required_after_analyzer_upgrade',
  ].includes(String(item.code)));
}

export function schemaDriftDiagnostics(
  db: Db,
  strict: boolean,
  workspaceId?: number,
): Diagnostic[] {
  if (!strict) return [];
  const columns = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name?: string }>;
  const legacy = columns.filter((row) => [
    'external_target_kind', 'external_target_id', 'external_target_label',
    'external_target_dynamic',
  ].includes(String(row.name))).map((row) => row.name);
  const missing = db.prepare(`SELECT c.id id,c.source_file sourceFile,
    c.source_line sourceLine FROM outbound_calls c
    JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type='external_http'
      AND (? IS NULL OR r.workspace_id=?)
      AND (c.external_target_id IS NULL OR c.external_target_label IS NULL
        OR c.external_target_kind IS NULL) LIMIT 20`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
  const out: Diagnostic[] = [];
  if (legacy.length > 0) out.push({ severity: 'warning', code: 'schema_legacy_columns_present', message: 'Legacy external-target columns are present on symbols; run service-flow clean --db-only, then init/index/link to rebuild with the current schema.', scope: 'workspace', affectedColumns: legacy, remediation: 'service-flow clean --db-only && service-flow init <workspace> && service-flow index && service-flow link' });
  if (missing.length > 0) out.push({ severity: 'warning', code: 'external_target_columns_missing_data', message: 'External HTTP calls are missing queryable external target metadata; reindex is required after upgrade.', scope: 'workspace', affectedRows: missing, remediation: 'service-flow index --force && service-flow link' });
  if (legacy.length > 0 || missing.length > 0) out.push({ severity: 'warning', code: 'reindex_required_after_upgrade', message: 'This database cannot be made equivalent to a fresh index by relink alone.', scope: 'workspace', remediation: 'Rebuild or force reindex the workspace, then run service-flow doctor --strict.' });
  return out;
}

export function analyzerVersionDiagnostics(
  db: Db,
  strict: boolean,
  workspaceId?: number,
): Diagnostic[] {
  if (!strict) return [];
  const rows = db.prepare(`SELECT name,
    COALESCE(fact_analyzer_version,'legacy') factAnalyzerVersion
    FROM repositories WHERE index_status='indexed'
      AND (? IS NULL OR workspace_id=?)
      AND COALESCE(fact_analyzer_version,'legacy')<>?`).all(
    workspaceId, workspaceId, ANALYZER_VERSION,
  ) as Diagnostic[];
  if (rows.length === 0) return [];
  return [{ severity: 'warning', code: 'reindex_required_after_analyzer_upgrade', message: 'Repository facts were produced by an older or unknown analyzer; run service-flow index --force before relink to apply current parser semantics.', scope: 'workspace', affectedRepositoryCount: rows.length, currentAnalyzerVersion: ANALYZER_VERSION, repositories: rows, remediation: 'service-flow index --force && service-flow link' }];
}
