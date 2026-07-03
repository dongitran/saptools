import type { Db } from './connection.js';
import { schemaSql } from './schema.js';
const CURRENT_SCHEMA_VERSION = 5;
const columns: Record<string, Array<{ name: string; ddl: string }>> = {
  service_bindings: [
    { name: 'helper_chain_json', ddl: 'ALTER TABLE service_bindings ADD COLUMN helper_chain_json TEXT' },
    { name: 'alias_expr', ddl: 'ALTER TABLE service_bindings ADD COLUMN alias_expr TEXT' },
  ],
  repositories: [
    { name: 'fingerprint', ddl: 'ALTER TABLE repositories ADD COLUMN fingerprint TEXT' },
    { name: 'fact_generation', ddl: 'ALTER TABLE repositories ADD COLUMN fact_generation INTEGER NOT NULL DEFAULT 0' },
    { name: 'graph_generation', ddl: 'ALTER TABLE repositories ADD COLUMN graph_generation INTEGER NOT NULL DEFAULT 0' },
    { name: 'graph_stale_reason', ddl: 'ALTER TABLE repositories ADD COLUMN graph_stale_reason TEXT' },
    { name: 'graph_stale_at', ddl: 'ALTER TABLE repositories ADD COLUMN graph_stale_at TEXT' },
  ],
  graph_edges: [
    { name: 'status', ddl: "ALTER TABLE graph_edges ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved'" },
    { name: 'generation', ddl: 'ALTER TABLE graph_edges ADD COLUMN generation INTEGER NOT NULL DEFAULT 0' },
  ],
  handler_registrations: [
    { name: 'class_name', ddl: 'ALTER TABLE handler_registrations ADD COLUMN class_name TEXT' },
    { name: 'import_source', ddl: 'ALTER TABLE handler_registrations ADD COLUMN import_source TEXT' },
  ],
  symbols: [
    { name: 'start_offset', ddl: 'ALTER TABLE symbols ADD COLUMN start_offset INTEGER' },
    { name: 'end_offset', ddl: 'ALTER TABLE symbols ADD COLUMN end_offset INTEGER' },
    { name: 'source_file', ddl: 'ALTER TABLE symbols ADD COLUMN source_file TEXT' },
    { name: 'exported_name', ddl: 'ALTER TABLE symbols ADD COLUMN exported_name TEXT' },
    { name: 'evidence_json', ddl: 'ALTER TABLE symbols ADD COLUMN evidence_json TEXT' },
  ],
  outbound_calls: [
    { name: 'local_service_name', ddl: 'ALTER TABLE outbound_calls ADD COLUMN local_service_name TEXT' },
    { name: 'local_service_lookup', ddl: 'ALTER TABLE outbound_calls ADD COLUMN local_service_lookup TEXT' },
    { name: 'alias_chain_json', ddl: 'ALTER TABLE outbound_calls ADD COLUMN alias_chain_json TEXT' },
    { name: 'evidence_json', ddl: 'ALTER TABLE outbound_calls ADD COLUMN evidence_json TEXT' },
  ],
  index_runs: [
    { name: 'error_message', ddl: 'ALTER TABLE index_runs ADD COLUMN error_message TEXT' },
  ],
};
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((row) => row.name === column);
}
function userVersion(db: Db): number {
  const row = db.pragma('user_version')[0] as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}
function addMissingColumns(db: Db): void {
  for (const [table, tableColumns] of Object.entries(columns)) {
    for (const column of tableColumns) {
      if (!hasColumn(db, table, column.name)) db.prepare(column.ddl).run();
    }
  }
}
function normalizeLegacyStatus(db: Db): void {
  db.prepare("UPDATE graph_edges SET status=CASE WHEN edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' THEN 'resolved' WHEN edge_type IN ('HANDLER_RUNS_DB_QUERY','HANDLER_CALLS_EXTERNAL_HTTP','HANDLER_EMITS_EVENT','EVENT_CONSUMED_BY_HANDLER') THEN 'terminal' WHEN edge_type='DYNAMIC_EDGE_CANDIDATE' THEN 'dynamic' WHEN status='ambiguous' THEN 'ambiguous' ELSE status END").run();
  db.prepare("UPDATE repositories SET graph_stale_reason='schema_migration_requires_relink', graph_stale_at=COALESCE(graph_stale_at, datetime('now')) WHERE EXISTS (SELECT 1 FROM graph_edges WHERE graph_edges.workspace_id=repositories.workspace_id) AND graph_generation=0").run();
}
export function migrate(db: Db): void {
  db.transaction(() => {
    const version = userVersion(db);
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported future service-flow schema version ${version}`);
    db.exec(schemaSql);
    addMissingColumns(db);
    normalizeLegacyStatus(db);
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) throw new Error('SQLite foreign_key_check failed during migration');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
}
export function schemaVersion(db: Db): number {
  return userVersion(db);
}
export function foreignKeyViolations(db: Db): Array<Record<string, unknown>> {
  return db.pragma('foreign_key_check');
}
