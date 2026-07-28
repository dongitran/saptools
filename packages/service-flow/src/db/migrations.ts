import type { Db } from './connection.js';
import {
  repositoriesTableSql,
  schemaIndexesSql,
  schemaTablesSql,
} from './schema.js';
export const CURRENT_SCHEMA_VERSION = 15;
const columns: Record<string, Array<{ name: string; ddl: string }>> = {
  handler_methods: [
    { name: 'decorator_resolution_json', ddl: "ALTER TABLE handler_methods ADD COLUMN decorator_resolution_json TEXT NOT NULL DEFAULT '{}'" },
  ],
  service_bindings: [
    { name: 'helper_chain_json', ddl: 'ALTER TABLE service_bindings ADD COLUMN helper_chain_json TEXT' },
    { name: 'alias_expr', ddl: 'ALTER TABLE service_bindings ADD COLUMN alias_expr TEXT' },
    { name: 'binding_site_start_offset', ddl: 'ALTER TABLE service_bindings ADD COLUMN binding_site_start_offset INTEGER' },
    { name: 'binding_site_end_offset', ddl: 'ALTER TABLE service_bindings ADD COLUMN binding_site_end_offset INTEGER' },
    { name: 'owner_resolution', ddl: "ALTER TABLE service_bindings ADD COLUMN owner_resolution TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK(owner_resolution IN ('owned_exact','ownerless_file_scope','legacy_unknown'))" },
  ],
  repositories: [
    { name: 'fingerprint', ddl: 'ALTER TABLE repositories ADD COLUMN fingerprint TEXT' },
    { name: 'fact_generation', ddl: 'ALTER TABLE repositories ADD COLUMN fact_generation INTEGER NOT NULL DEFAULT 0' },
    { name: 'graph_generation', ddl: 'ALTER TABLE repositories ADD COLUMN graph_generation INTEGER NOT NULL DEFAULT 0' },
    { name: 'graph_stale_reason', ddl: 'ALTER TABLE repositories ADD COLUMN graph_stale_reason TEXT' },
    { name: 'graph_stale_at', ddl: 'ALTER TABLE repositories ADD COLUMN graph_stale_at TEXT' },
    { name: 'fact_analyzer_version', ddl: "ALTER TABLE repositories ADD COLUMN fact_analyzer_version TEXT DEFAULT 'legacy'" },
    { name: 'package_public_surface_json', ddl: 'ALTER TABLE repositories ADD COLUMN package_public_surface_json TEXT' },
    { name: 'environment_declarations_json', ddl: `ALTER TABLE repositories ADD COLUMN environment_declarations_json TEXT DEFAULT '{"schema":"service-flow/environment-declarations@1","allowedKeys":["SHARD_CODE"],"status":"not_applicable","reason":null,"recordCap":32,"total":0,"shown":0,"omitted":0,"declarations":[]}'` },
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
  cds_services: [
    { name: 'extension_local_ref', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_local_ref TEXT' },
    { name: 'extension_imported_symbol', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_imported_symbol TEXT' },
    { name: 'extension_local_alias', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_local_alias TEXT' },
    { name: 'extension_module_specifier', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_module_specifier TEXT' },
    { name: 'extension_import_kind', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_import_kind TEXT' },
    { name: 'extension_base_service_id', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_base_service_id INTEGER' },
    { name: 'extension_base_status', ddl: 'ALTER TABLE cds_services ADD COLUMN extension_base_status TEXT' },
  ],
  cds_operations: [
    { name: 'provenance', ddl: "ALTER TABLE cds_operations ADD COLUMN provenance TEXT NOT NULL DEFAULT 'direct'" },
    { name: 'base_operation_id', ddl: 'ALTER TABLE cds_operations ADD COLUMN base_operation_id INTEGER' },
  ],
  outbound_calls: [
    { name: 'local_service_name', ddl: 'ALTER TABLE outbound_calls ADD COLUMN local_service_name TEXT' },
    { name: 'local_service_lookup', ddl: 'ALTER TABLE outbound_calls ADD COLUMN local_service_lookup TEXT' },
    { name: 'alias_chain_json', ddl: 'ALTER TABLE outbound_calls ADD COLUMN alias_chain_json TEXT' },
    { name: 'evidence_json', ddl: 'ALTER TABLE outbound_calls ADD COLUMN evidence_json TEXT' },
    { name: 'external_target_kind', ddl: 'ALTER TABLE outbound_calls ADD COLUMN external_target_kind TEXT' },
    { name: 'external_target_id', ddl: 'ALTER TABLE outbound_calls ADD COLUMN external_target_id TEXT' },
    { name: 'external_target_label', ddl: 'ALTER TABLE outbound_calls ADD COLUMN external_target_label TEXT' },
    { name: 'external_target_dynamic', ddl: 'ALTER TABLE outbound_calls ADD COLUMN external_target_dynamic INTEGER NOT NULL DEFAULT 0' },
    { name: 'call_site_start_offset', ddl: 'ALTER TABLE outbound_calls ADD COLUMN call_site_start_offset INTEGER' },
    { name: 'call_site_end_offset', ddl: 'ALTER TABLE outbound_calls ADD COLUMN call_site_end_offset INTEGER' },
    { name: 'event_skeleton_signature', ddl: 'ALTER TABLE outbound_calls ADD COLUMN event_skeleton_signature TEXT' },
    { name: 'event_skeleton_json', ddl: 'ALTER TABLE outbound_calls ADD COLUMN event_skeleton_json TEXT' },
  ],
  symbol_calls: [
    { name: 'call_site_start_offset', ddl: 'ALTER TABLE symbol_calls ADD COLUMN call_site_start_offset INTEGER' },
    { name: 'call_site_end_offset', ddl: 'ALTER TABLE symbol_calls ADD COLUMN call_site_end_offset INTEGER' },
    { name: 'call_role', ddl: "ALTER TABLE symbol_calls ADD COLUMN call_role TEXT NOT NULL DEFAULT 'legacy_unknown'" },
  ],
  index_runs: [
    { name: 'error_message', ddl: 'ALTER TABLE index_runs ADD COLUMN error_message TEXT' },
    { name: 'owner_pid', ddl: 'ALTER TABLE index_runs ADD COLUMN owner_pid INTEGER' },
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
function normalizeLegacyStatus(db: Db, priorVersion: number): void {
  if (priorVersion >= 12) return;
  db.prepare("UPDATE graph_edges SET status=CASE WHEN edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' THEN 'resolved' WHEN edge_type IN ('HANDLER_RUNS_DB_QUERY','HANDLER_CALLS_EXTERNAL_HTTP','HANDLER_EMITS_EVENT','EVENT_CONSUMED_BY_HANDLER') THEN 'terminal' WHEN edge_type='DYNAMIC_EDGE_CANDIDATE' THEN 'dynamic' WHEN status='ambiguous' THEN 'ambiguous' ELSE status END").run();
  db.prepare("UPDATE repositories SET graph_stale_reason='schema_migration_requires_relink', graph_stale_at=COALESCE(graph_stale_at, datetime('now')) WHERE EXISTS (SELECT 1 FROM graph_edges WHERE graph_edges.workspace_id=repositories.workspace_id) AND graph_generation=0").run();
}
function markCallSiteMigrationStale(db: Db, priorVersion: number): void {
  if (priorVersion >= 12) return;
  db.prepare(`UPDATE repositories
    SET graph_stale_reason='schema_v12_call_sites_require_reindex',
      graph_stale_at=COALESCE(graph_stale_at,datetime('now'))
    WHERE index_status='indexed' OR last_indexed_at IS NOT NULL`).run();
}
function markFactProvenanceMigrationStale(db: Db, priorVersion: number): void {
  if (priorVersion >= 13) return;
  db.prepare(`UPDATE repositories
    SET graph_stale_reason='schema_v13_fact_provenance_requires_reindex',
      graph_stale_at=COALESCE(graph_stale_at,datetime('now'))
    WHERE index_status='indexed' OR last_indexed_at IS NOT NULL`).run();
}
function markEventSurfaceMigrationStale(db: Db, priorVersion: number): void {
  if (priorVersion >= 14) return;
  db.prepare(
    'UPDATE repositories SET environment_declarations_json=NULL',
  ).run();
  db.prepare(`UPDATE repositories
    SET graph_stale_reason='schema_v14_event_surface_requires_reindex',
      graph_stale_at=COALESCE(graph_stale_at,datetime('now'))
    WHERE index_status='indexed' OR last_indexed_at IS NOT NULL`).run();
}

const repositoryColumns = [
  'id', 'workspace_id', 'name', 'absolute_path', 'relative_path',
  'package_name', 'package_version', 'dependencies_json',
  'package_public_surface_json', 'environment_declarations_json', 'kind',
  'is_git_repo', 'last_indexed_at', 'index_status', 'error_count',
  'fingerprint', 'fact_generation', 'graph_generation',
  'graph_stale_reason', 'graph_stale_at', 'fact_analyzer_version',
].join(',');

const repositoryChildTables = [
  'files',
  'cds_requires',
  'cds_services',
  'symbols',
  'handler_classes',
  'handler_registrations',
  'service_bindings',
  'outbound_calls',
  'generated_constants',
  'symbol_calls',
  'diagnostics',
] as const;

function pragmaEnabled(db: Db, name: string): boolean {
  const row = db.pragma(name)[0];
  return Number(row?.[name] ?? 0) === 1;
}

function repositoryChildCounts(db: Db): Map<string, number> {
  return new Map(repositoryChildTables.map((table) => {
    const row = db.prepare(`SELECT COUNT(*) count FROM ${table}`).get();
    return [table, Number(row?.count ?? 0)];
  }));
}

function assertForeignKeysDisabled(db: Db): void {
  if (!pragmaEnabled(db, 'foreign_keys'))
    return;
  throw new Error(
    'schema_v15_repository_rebuild_requires_foreign_keys_off',
  );
}

function assertLegacyAlterTable(db: Db): void {
  if (pragmaEnabled(db, 'legacy_alter_table')) return;
  throw new Error(
    'schema_v15_repository_rebuild_requires_legacy_alter_table',
  );
}

function assertRepositoryChildrenPreserved(
  db: Db,
  before: Map<string, number>,
): void {
  const after = repositoryChildCounts(db);
  for (const [table, count] of before) {
    if (after.get(table) === count) continue;
    throw new Error(
      `schema_v15_repository_rebuild_changed_child_rows:${table}`,
    );
  }
}

function normalizeEnvironmentDefault(db: Db, priorVersion: number): void {
  if (priorVersion >= 15 || priorVersion === 0) return;
  assertForeignKeysDisabled(db);
  assertLegacyAlterTable(db);
  const childCounts = repositoryChildCounts(db);
  db.exec('ALTER TABLE repositories RENAME TO repositories_schema_v14');
  db.exec(repositoriesTableSql);
  db.exec(`INSERT INTO repositories(${repositoryColumns})
    SELECT ${repositoryColumns} FROM repositories_schema_v14`);
  db.exec('DROP TABLE repositories_schema_v14');
  assertRepositoryChildrenPreserved(db, childCounts);
}

export function migrate(db: Db): void {
  const version = userVersion(db);
  const rebuildRepositories = version > 0 && version < 15;
  if (rebuildRepositories) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
  }
  try {
    db.transaction(() => {
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Unsupported future service-flow schema version ${version}`);
    db.exec(schemaTablesSql);
    addMissingColumns(db);
    normalizeLegacyStatus(db, version);
    markCallSiteMigrationStale(db, version);
    markFactProvenanceMigrationStale(db, version);
    markEventSurfaceMigrationStale(db, version);
    normalizeEnvironmentDefault(db, version);
    db.exec(schemaIndexesSql);
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) throw new Error('SQLite foreign_key_check failed during migration');
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
  } finally {
    if (rebuildRepositories) {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
}
export function schemaVersion(db: Db): number {
  return userVersion(db);
}
export function foreignKeyViolations(db: Db): Array<Record<string, unknown>> {
  return db.pragma('foreign_key_check');
}
