import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/fact-lifecycle.js';
import {
  LINK_FACT_JSON_INVENTORY,
  type FactJsonShape,
} from '../../src/db/fact-json-inventory.js';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { migrate, schemaVersion } from '../../src/db/migrations.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const indexedAt = '2026-01-01T00:00:00.000Z';
const sourceFile = 'src/run.ts';
const surface = JSON.stringify({
  schema: 'service-flow/package-public-surface@1',
  status: 'not_applicable',
  reason: null,
  recordCap: 256,
  total: 0,
  shown: 0,
  omitted: 0,
  packageName: null,
  exportsPresent: false,
  exportsAuthoritative: false,
  main: null,
  module: null,
  entries: [],
  scopes: [],
});

interface JsonTarget {
  table: string;
  column: string;
  shape: FactJsonShape;
}

const jsonTargets: JsonTarget[] = [
  { table: 'repositories', column: 'dependencies_json', shape: 'object' },
  {
    table: 'repositories',
    column: 'package_public_surface_json',
    shape: 'object',
  },
  {
    table: 'repositories',
    column: 'environment_declarations_json',
    shape: 'object',
  },
  {
    table: 'handler_methods',
    column: 'decorator_resolution_json',
    shape: 'object',
  },
  { table: 'symbols', column: 'evidence_json', shape: 'object' },
  { table: 'symbol_calls', column: 'evidence_json', shape: 'object' },
  { table: 'outbound_calls', column: 'evidence_json', shape: 'object' },
  { table: 'outbound_calls', column: 'alias_chain_json', shape: 'array' },
  {
    table: 'outbound_calls',
    column: 'event_skeleton_json',
    shape: 'object',
  },
  { table: 'service_bindings', column: 'placeholders_json', shape: 'array' },
  { table: 'service_bindings', column: 'helper_chain_json', shape: 'array' },
  { table: 'cds_requires', column: 'raw_json', shape: 'object' },
];
const jsonTargetCases = jsonTargets.map((target) =>
  [`${target.table}.${target.column}`, target] as const);

function database(label: string): Db {
  const root = mkdtempSync(path.join(os.tmpdir(), `sf-${label}-`));
  return openDatabase(path.join(root, 'graph.db'));
}

function insertRepository(db: Db): void {
  const root = path.dirname(db.path);
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(1, root, db.path, indexedAt, indexedAt);
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,dependencies_json,
    package_public_surface_json,kind,is_git_repo,last_indexed_at,
    index_status,fact_generation,graph_generation,fact_analyzer_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'neutral', path.join(root, 'neutral'), 'neutral', '{}', surface,
    'cap-service', 1, indexedAt, 'indexed', 3, 2, ANALYZER_VERSION,
  );
}

function insertSymbolsAndHandler(db: Db): void {
  const body = JSON.stringify({
    executableBodyEligibility: { eligible: true, reason: 'body_present' },
  });
  const statement = db.prepare(`INSERT INTO symbols(
    id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  statement.run(
    1, 1, 'function', 'run', 'run', 0, 1, 20, 0, 500, sourceFile, body,
  );
  statement.run(
    2, 1, 'function', 'target', 'target', 0, 21, 25, 600, 700,
    sourceFile, body,
  );
  db.prepare(`INSERT INTO handler_classes(
    id,repo_id,symbol_id,class_name,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(1, 1, 1, 'NeutralHandler', sourceFile, 1);
  db.prepare(`INSERT INTO handler_methods(
    id,handler_class_id,method_name,decorator_kind,decorator_value,
    decorator_raw_expression,decorator_resolution_json,source_file,
    source_line
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'run', 'Action', 'run', "'run'",
    '{"resolutionKind":"literal","handlerKind":"action","executable":true}',
    sourceFile, 2,
  );
}

function bindingReference(): Record<string, unknown> {
  return {
    status: 'resolved_exact',
    variableName: 'remote',
    bindingSourceFile: sourceFile,
    bindingSiteStartOffset: 10,
    bindingSiteEndOffset: 20,
    resolutionStrategy: 'lexical_declaration',
    lexicalScopeChain: [
      { kind: 'source_file', startOffset: 0, endOffset: 1_000 },
      { kind: 'function', startOffset: 0, endOffset: 500 },
    ],
    bindingScopeIndex: 1,
    scopeChainTotal: 2,
    scopeChainShown: 2,
    scopeChainOmitted: 0,
  };
}

function insertBindingAndCall(db: Db): void {
  db.prepare(`INSERT INTO service_bindings(
    id,repo_id,symbol_id,variable_name,alias,is_dynamic,placeholders_json,
    source_file,source_line,binding_site_start_offset,
    binding_site_end_offset,owner_resolution,helper_chain_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'remote', 'remote_api', 0, '[]', sourceFile, 2,
    10, 20, 'owned_exact', '[]',
  );
  const evidence = JSON.stringify({
    sourceOwnerResolution: 'owned_exact',
    serviceBindingReference: bindingReference(),
    serviceBindingResolution: {
      status: 'selected_exact',
      selectedBindingId: 1,
      candidateCount: 1,
    },
  });
  db.prepare(`INSERT INTO outbound_calls(
    id,repo_id,source_symbol_id,call_type,service_binding_id,method,
    operation_path_expr,source_file,source_line,call_site_start_offset,
    call_site_end_offset,confidence,alias_chain_json,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'remote_action', 1, 'POST', '/run', sourceFile, 3,
    50, 60, 1, '[]', evidence,
  );
}

function insertSymbolCallAndRequire(db: Db): void {
  const evidence = JSON.stringify({
    relation: 'indexed_local_symbol',
    caller: 'run',
    targetName: 'target',
    candidateStrategy: 'same_file_exact',
    candidateCount: 1,
    eligibleCandidateCount: 1,
    selectedCandidateCount: 1,
    candidateSetComplete: true,
    unresolvedReason: null,
  });
  db.prepare(`INSERT INTO symbol_calls(
    id,repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 2, 'target', sourceFile, 4, 70, 80,
    'ordinary_call', 'resolved', 1, evidence,
  );
  db.prepare(`INSERT INTO cds_requires(
    id,repo_id,alias,kind,service_path,raw_json
  ) VALUES(?,?,?,?,?,?)`).run(
    1, 1, 'remote_api', 'odata-v4', '/RemoteService', '{}',
  );
  db.prepare(`INSERT INTO graph_edges(
    id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'CALLS_SYMBOL', 'resolved', 'symbol', 'prior',
    'symbol', 'prior-target', 1, '{"lastGood":true}', 0, 2,
  );
}

function currentFixture(): Db {
  const db = database('json-inventory');
  insertRepository(db);
  insertSymbolsAndHandler(db);
  insertBindingAndCall(db);
  insertSymbolCallAndRequire(db);
  return db;
}

function categories(diagnostic: FactLifecycleDiagnostic): string[] {
  const values = diagnostic.invalidFactCategories;
  if (!Array.isArray(values)) return [];
  return (values as unknown[]).flatMap(categoryValue);
}

function categoryValue(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('category' in value)) return [];
  return typeof value.category === 'string' ? [value.category] : [];
}

function graphSnapshot(db: Db): string {
  return JSON.stringify({
    edges: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
    repositories: db.prepare(`SELECT id,graph_generation graphGeneration,
      graph_stale_reason graphStaleReason FROM repositories ORDER BY id`).all(),
  });
}

function updateJson(db: Db, target: JsonTarget, value: string): void {
  db.prepare(`UPDATE ${target.table} SET ${target.column}=? WHERE id=1`)
    .run(value);
}

function assertBoundedConsumers(
  db: Db,
  expectedCategory: string,
  graphBefore: string,
): void {
  const diagnostic = factLifecycleDiagnostic(db, 1);
  expect(diagnostic).toMatchObject({
    code: 'reindex_required',
    staleRepositoryCount: 0,
  });
  if (!diagnostic) throw new Error('Expected lifecycle diagnostic');
  expect(categories(diagnostic)).toContain(expectedCategory);
  expect(JSON.stringify(diagnostic)).not.toContain(sourceFile);

  const traced = trace(
    db, { repo: 'neutral', handler: 'run' }, { depth: 2, workspaceId: 1 },
  );
  expect(traced.edges).toEqual([]);
  expect(traced.diagnostics).toEqual([
    expect.objectContaining({ code: 'reindex_required' }),
  ]);
  const doctor = doctorDiagnostics(db, true, {
    detail: true, workspaceId: 1,
  });
  expect(doctor[0]).toMatchObject({ code: 'reindex_required' });
  expect(doctor).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'workspace_json_checks_deferred' }),
  ]));
  expect(doctor.length).toBeGreaterThan(1);
  expect(() => linkWorkspace(db, 1)).toThrow(/reindex_required/);
  expect(graphSnapshot(db)).toBe(graphBefore);
}

function downgradeToV12(db: Db): void {
  db.exec(`
    DROP INDEX idx_outbound_event_skeleton;
    DROP INDEX idx_generated_constant_name;
    DROP INDEX uq_generated_constant_site;
    DROP TABLE generated_constants;
    ALTER TABLE outbound_calls DROP COLUMN event_skeleton_signature;
    ALTER TABLE outbound_calls DROP COLUMN event_skeleton_json;
    ALTER TABLE repositories DROP COLUMN environment_declarations_json;
    DROP INDEX idx_service_binding_site;
    DROP INDEX uq_service_binding_exact_site;
    ALTER TABLE service_bindings DROP COLUMN binding_site_start_offset;
    ALTER TABLE service_bindings DROP COLUMN binding_site_end_offset;
    ALTER TABLE service_bindings DROP COLUMN owner_resolution;
    ALTER TABLE repositories DROP COLUMN package_public_surface_json;
    PRAGMA user_version = 12;
  `);
}

function migrationSnapshot(db: Db): string {
  return JSON.stringify({
    version: schemaVersion(db),
    repository: db.prepare('SELECT * FROM repositories ORDER BY id').all(),
    graph: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
    bindingColumns: db.prepare("PRAGMA table_info('service_bindings')").all(),
    repositoryColumns: db.prepare("PRAGMA table_info('repositories')").all(),
    outboundColumns: db.prepare("PRAGMA table_info('outbound_calls')").all(),
    generatedConstantTable: db.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='generated_constants'`).get(),
    bindingIndexes: db.prepare(
      "PRAGMA index_list('service_bindings')",
    ).all(),
  });
}

function failureInjectingMigrationDb(db: Db): Db {
  return {
    ...db,
    pragma: (sql) => {
      if (sql.trim() === 'foreign_key_check')
        throw new Error('injected_migration_failure');
      return db.pragma(sql);
    },
  };
}

describe('schema migration transaction and JSON inventory preflight', () => {
  it('rolls back every v13 migration mutation after a terminal check fails', () => {
    const db = database('migration-rollback');
    insertRepository(db);
    insertSymbolsAndHandler(db);
    insertBindingAndCall(db);
    insertSymbolCallAndRequire(db);
    downgradeToV12(db);
    const before = migrationSnapshot(db);

    expect(() => migrate(failureInjectingMigrationDb(db)))
      .toThrow('injected_migration_failure');
    expect(migrationSnapshot(db)).toBe(before);
    expect(schemaVersion(db)).toBe(12);
    expect(db.prepare(`SELECT graph_stale_reason staleReason
      FROM repositories WHERE id=1`).get()?.staleReason).toBeNull();
    db.close();
  });

  it('keeps the declarative inventory synchronized with exercised columns', () => {
    expect(LINK_FACT_JSON_INVENTORY.map((item) => ({
      table: item.table,
      column: item.column,
      shape: item.shape,
    }))).toEqual(jsonTargets);
  });
});

describe('JSON inventory reader short-circuit', () => {
  it.each(jsonTargetCases)('bounds malformed %s before readers', (
    _label,
    target,
  ) => {
    const db = currentFixture();
    expect(factLifecycleDiagnostic(db, 1)).toBeUndefined();
    const graphBefore = graphSnapshot(db);
    updateJson(db, target, '{');
    assertBoundedConsumers(
      db, `json_${target.table}_${target.column}_invalid`, graphBefore,
    );
    db.close();
  });

  it.each(jsonTargetCases)('rejects wrong-shape %s before readers', (
    _label,
    target,
  ) => {
    const db = currentFixture();
    expect(factLifecycleDiagnostic(db, 1)).toBeUndefined();
    const graphBefore = graphSnapshot(db);
    updateJson(db, target, target.shape === 'object' ? '[]' : '{}');
    assertBoundedConsumers(
      db, `json_${target.table}_${target.column}_wrong_shape`, graphBefore,
    );
    db.close();
  });
});
