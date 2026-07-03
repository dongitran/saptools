import type { Db } from './connection.js';
import { schemaSql } from './schema.js';
const CURRENT_SCHEMA_VERSION = 2;
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((row) => row.name === column);
}
function userVersion(db: Db): number {
  const row = db.pragma('user_version')[0] as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}
export function migrate(db: Db): void {
  db.transaction(() => {
    db.exec(schemaSql);
    if (!hasColumn(db, 'service_bindings', 'helper_chain_json')) db.prepare('ALTER TABLE service_bindings ADD COLUMN helper_chain_json TEXT').run();
    if (!hasColumn(db, 'service_bindings', 'alias_expr')) db.prepare('ALTER TABLE service_bindings ADD COLUMN alias_expr TEXT').run();
    if (!hasColumn(db, 'repositories', 'fingerprint')) db.prepare('ALTER TABLE repositories ADD COLUMN fingerprint TEXT').run();
    if (!hasColumn(db, 'graph_edges', 'status')) db.prepare("ALTER TABLE graph_edges ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved'").run();
    db.prepare("UPDATE graph_edges SET status=CASE WHEN edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' THEN 'resolved' WHEN edge_type IN ('HANDLER_RUNS_DB_QUERY','HANDLER_CALLS_EXTERNAL_HTTP','HANDLER_EMITS_EVENT','EVENT_CONSUMED_BY_HANDLER') THEN 'terminal' WHEN edge_type='DYNAMIC_EDGE_CANDIDATE' THEN 'dynamic' ELSE status END").run();
    db.pragma(`user_version = ${Math.max(userVersion(db), CURRENT_SCHEMA_VERSION)}`);
  });
}
export function schemaVersion(db: Db): number {
  return userVersion(db);
}
export function foreignKeyViolations(db: Db): Array<Record<string, unknown>> {
  return db.pragma('foreign_key_check');
}
