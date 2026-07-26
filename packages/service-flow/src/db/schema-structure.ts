import type { Db } from './connection.js';

export interface SchemaStructureCategoryCount {
  category: string;
  count: number;
}

const requiredColumns = {
  workspaces: [
    'id', 'root_path', 'db_path', 'created_at', 'updated_at',
  ],
  repositories: [
    'id', 'workspace_id', 'name', 'absolute_path', 'relative_path',
    'package_name', 'package_version', 'dependencies_json',
    'package_public_surface_json', 'environment_declarations_json',
    'kind', 'is_git_repo', 'last_indexed_at',
    'index_status', 'error_count', 'fingerprint', 'fact_generation',
    'graph_generation', 'graph_stale_reason', 'graph_stale_at',
    'fact_analyzer_version',
  ],
  files: [
    'id', 'repo_id', 'relative_path', 'extension', 'sha256', 'size_bytes',
    'last_indexed_at',
  ],
  cds_requires: [
    'id', 'repo_id', 'alias', 'kind', 'model', 'destination',
    'service_path', 'request_timeout', 'raw_json',
  ],
  cds_services: [
    'id', 'repo_id', 'namespace', 'service_name', 'qualified_name',
    'service_path', 'is_extend', 'source_file', 'source_line',
    'extension_local_ref', 'extension_imported_symbol',
    'extension_local_alias', 'extension_module_specifier',
    'extension_import_kind', 'extension_base_service_id',
    'extension_base_status',
  ],
  cds_operations: [
    'id', 'service_id', 'operation_type', 'operation_name', 'operation_path',
    'params_json', 'return_type', 'source_file', 'source_line', 'provenance',
    'base_operation_id',
  ],
  symbols: [
    'id', 'repo_id', 'file_id', 'kind', 'name', 'qualified_name',
    'exported', 'start_line', 'end_line', 'start_offset', 'end_offset',
    'source_file', 'exported_name', 'evidence_json',
  ],
  handler_classes: [
    'id', 'repo_id', 'symbol_id', 'class_name', 'source_file', 'source_line',
  ],
  handler_methods: [
    'id', 'handler_class_id', 'method_name', 'decorator_kind',
    'decorator_value', 'decorator_raw_expression',
    'decorator_resolution_json', 'source_file', 'source_line',
  ],
  handler_registrations: [
    'id', 'repo_id', 'handler_class_id', 'class_name', 'import_source',
    'registration_file', 'registration_line', 'registration_kind',
    'confidence',
  ],
  service_bindings: [
    'id', 'repo_id', 'symbol_id', 'variable_name', 'alias', 'alias_expr',
    'destination_expr', 'service_path_expr', 'is_dynamic',
    'placeholders_json', 'source_file', 'source_line',
    'binding_site_start_offset', 'binding_site_end_offset',
    'owner_resolution', 'helper_chain_json',
  ],
  outbound_calls: [
    'id', 'repo_id', 'source_symbol_id', 'service_binding_id', 'call_type',
    'method', 'operation_path_expr', 'query_entity', 'event_name_expr',
    'event_skeleton_signature', 'event_skeleton_json',
    'payload_summary', 'source_file', 'source_line',
    'call_site_start_offset', 'call_site_end_offset', 'evidence_json',
    'confidence', 'unresolved_reason', 'local_service_name',
    'local_service_lookup', 'alias_chain_json', 'external_target_kind',
    'external_target_id', 'external_target_label', 'external_target_dynamic',
  ],
  symbol_calls: [
    'id', 'repo_id', 'caller_symbol_id', 'callee_symbol_id',
    'callee_expression', 'import_source', 'source_file', 'source_line',
    'call_site_start_offset',
    'call_site_end_offset', 'call_role', 'status', 'evidence_json',
    'confidence', 'unresolved_reason',
  ],
  generated_constants: [
    'id', 'repo_id', 'source_file', 'source_line', 'name',
    'container_name', 'member_name', 'value', 'constant_kind', 'exported',
    'stable', 'resolution_status', 'unresolved_reason',
    'declaration_start_offset', 'declaration_end_offset',
    'value_start_offset', 'value_end_offset',
  ],
  graph_edges: [
    'id', 'workspace_id', 'edge_type', 'status', 'from_kind', 'from_id',
    'to_kind', 'to_id', 'confidence', 'evidence_json', 'is_dynamic',
    'unresolved_reason', 'generation',
  ],
  index_runs: [
    'id', 'workspace_id', 'started_at', 'finished_at', 'status',
    'repo_count', 'file_count', 'diagnostic_count', 'error_message',
    'owner_pid',
  ],
  diagnostics: [
    'id', 'repo_id', 'file_id', 'severity', 'code', 'message',
    'source_file', 'source_line',
  ],
  search_index: ['kind', 'name', 'path', 'repo'],
} as const;

type RequiredTable = keyof typeof requiredColumns;

function tableNames(db: Db): Set<string> {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'",
  ).all();
  return new Set(rows.flatMap((row) =>
    typeof row.name === 'string' ? [row.name] : []));
}

function columnNames(db: Db, table: RequiredTable): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.flatMap((row) =>
    typeof row.name === 'string' ? [row.name] : []));
}

function missingTableCount(db: Db): number {
  const actual = tableNames(db);
  return Object.keys(requiredColumns).filter((table) =>
    !actual.has(table)).length;
}

function missingColumnCount(db: Db): number {
  const actualTables = tableNames(db);
  return Object.entries(requiredColumns).reduce(
    (total, [table, columns]) => {
      if (!actualTables.has(table)) return total;
      const actual = columnNames(db, table as RequiredTable);
      return total + columns.filter((column) => !actual.has(column)).length;
    },
    0,
  );
}

const bindingSiteColumns = [
  'repo_id', 'source_file', 'variable_name',
  'binding_site_start_offset', 'binding_site_end_offset',
];
const exactSitePredicate =
  'where binding_site_start_offset is not null and '
  + 'binding_site_end_offset is not null';

function indexColumns(db: Db, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all().flatMap((item) =>
    typeof item.name === 'string' ? [item.name] : []);
}

function indexMetadata(
  db: Db,
  name: string,
): Record<string, unknown> | undefined {
  return db.prepare("PRAGMA index_list('service_bindings')")
    .all().find((item) => item.name === name);
}

function normalizedSql(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function bindingIndexInvalid(
  db: Db,
  name: string,
  unique: number,
  partial: number,
): number {
  const metadata = indexMetadata(db, name);
  const columns = indexColumns(db, name);
  return columns.join('\0') === bindingSiteColumns.join('\0')
    && metadata?.unique === unique && metadata.partial === partial ? 0 : 1;
}

function tableIndexInvalid(
  db: Db,
  table: string,
  name: string,
  columns: readonly string[],
  unique: number,
): number {
  const metadata = db.prepare(`PRAGMA index_list(${table})`)
    .all().find((item) => item.name === name);
  return metadata?.unique === unique
    && indexColumns(db, name).join('\0') === columns.join('\0') ? 0 : 1;
}

function eventSurfaceIndexesInvalid(db: Db): number {
  return tableIndexInvalid(
    db, 'outbound_calls', 'idx_outbound_event_skeleton',
    ['event_skeleton_signature', 'call_type', 'repo_id'], 0,
  ) + tableIndexInvalid(
    db, 'generated_constants', 'idx_generated_constant_name',
    ['repo_id', 'source_file', 'name'], 0,
  ) + tableIndexInvalid(
    db, 'generated_constants', 'uq_generated_constant_site',
    ['repo_id', 'source_file', 'name', 'declaration_start_offset',
      'declaration_end_offset'], 1,
  );
}

function exactBindingIndexInvalid(db: Db): number {
  const row = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='index' AND name='uq_service_binding_exact_site'`).get();
  if (typeof row?.sql !== 'string'
    || !normalizedSql(row.sql).endsWith(exactSitePredicate)) return 1;
  return bindingIndexInvalid(
    db, 'uq_service_binding_exact_site', 1, 1,
  );
}

function category(
  name: string,
  count: number,
): SchemaStructureCategoryCount[] {
  return count > 0 ? [{ category: name, count }] : [];
}

export function invalidSchemaStructureCategories(
  db: Db,
): SchemaStructureCategoryCount[] {
  const missingTables = missingTableCount(db);
  if (missingTables > 0)
    return category('schema_required_table_missing', missingTables);
  return [
    ...category('schema_required_column_missing', missingColumnCount(db)),
    ...category(
      'schema_binding_exact_site_index_invalid',
      exactBindingIndexInvalid(db)
        + bindingIndexInvalid(db, 'idx_service_binding_site', 0, 0),
    ),
    ...category(
      'schema_event_surface_index_invalid',
      eventSurfaceIndexesInvalid(db),
    ),
  ];
}
