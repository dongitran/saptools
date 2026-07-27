import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openDatabase,
  openReadOnlyDatabase,
  type Db,
} from '../../src/db/connection.js';
import {
  factLifecycleDiagnostic,
} from '../../src/db/fact-lifecycle.js';
import {
  migrate,
  schemaVersion,
} from '../../src/db/migrations.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { trace } from '../../src/trace/trace-engine.js';

const preEventAnalyzer = '0.1.66-facts.1';
const indexedAt = '2026-01-01T00:00:00.000Z';

async function databasePath(label: string): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `service-flow-${label}-`),
  );
  return path.join(root, 'graph.db');
}

function seedLegacySnapshot(db: Db, dbPath: string): void {
  const root = path.dirname(dbPath);
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(1, root, dbPath, indexedAt, indexedAt);
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,package_name,
    package_version,dependencies_json,package_public_surface_json,kind,
    is_git_repo,last_indexed_at,index_status,fingerprint,fact_generation,
    graph_generation,fact_analyzer_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'neutral-service', path.join(root, 'neutral-service'),
    'neutral-service', '@neutral/service', '1.0.0', '{}',
    '{"schema":"neutral-public-surface"}', 'cap-service', 1, indexedAt,
    'indexed', 'legacy-fingerprint', 6, 5, preEventAnalyzer,
  );
  db.prepare(`INSERT INTO symbols(
    id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'function', 'run', 'run', 1, 1, 10, 0, 100,
    'src/run.ts', '{}',
  );
  seedLegacyCallFacts(db);
  db.prepare(`INSERT INTO graph_edges(
    id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'REPO_IMPORTS_HELPER_PACKAGE', 'resolved',
    'repo', '1', 'repo', '1', 1, '{"legacyGraph":true}', 0, 5,
  );
}

function seedLegacyCallFacts(db: Db): void {
  db.prepare(`INSERT INTO service_bindings(
    id,repo_id,symbol_id,variable_name,is_dynamic,placeholders_json,
    source_file,source_line,binding_site_start_offset,
    binding_site_end_offset,owner_resolution
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'remote', 0, '[]', 'src/run.ts', 2, 10, 20,
    'owned_exact',
  );
  db.prepare(`INSERT INTO outbound_calls(
    id,repo_id,source_symbol_id,call_type,service_binding_id,method,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'remote_call', 1, 'POST', 'src/run.ts', 3, 30, 40,
    1, '{}',
  );
  db.prepare(`INSERT INTO symbol_calls(
    id,repo_id,caller_symbol_id,callee_expression,source_file,source_line,
    call_site_start_offset,call_site_end_offset,call_role,status,
    confidence,evidence_json,unresolved_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'target', 'src/run.ts', 4, 50, 60, 'ordinary_call',
    'unresolved', 1, '{"candidateStrategy":"legacy"}', 'legacy_target',
  );
}

function downgradeFromV14ToV13(db: Db): void {
  db.exec(`
    DROP INDEX idx_outbound_event_skeleton;
    DROP INDEX idx_generated_constant_name;
    DROP INDEX uq_generated_constant_site;
    DROP TABLE generated_constants;
    ALTER TABLE outbound_calls DROP COLUMN event_skeleton_signature;
    ALTER TABLE outbound_calls DROP COLUMN event_skeleton_json;
    ALTER TABLE repositories DROP COLUMN environment_declarations_json;
    PRAGMA user_version = 13;
  `);
}

function downgradeFromV13ToV12(db: Db): void {
  db.exec(`
    DROP INDEX idx_service_binding_site;
    DROP INDEX uq_service_binding_exact_site;
    ALTER TABLE service_bindings DROP COLUMN binding_site_start_offset;
    ALTER TABLE service_bindings DROP COLUMN binding_site_end_offset;
    ALTER TABLE service_bindings DROP COLUMN owner_resolution;
    ALTER TABLE repositories DROP COLUMN package_public_surface_json;
    PRAGMA user_version = 12;
  `);
}

function downgradeFromV12(db: Db): void {
  db.exec(`
    DROP INDEX idx_outbound_call_site;
    DROP INDEX idx_symbol_call_site_role;
    ALTER TABLE outbound_calls DROP COLUMN call_site_start_offset;
    ALTER TABLE outbound_calls DROP COLUMN call_site_end_offset;
    ALTER TABLE symbol_calls DROP COLUMN call_site_start_offset;
    ALTER TABLE symbol_calls DROP COLUMN call_site_end_offset;
    ALTER TABLE symbol_calls DROP COLUMN call_role;
    PRAGMA user_version = 11;
  `);
}

async function createLegacyDatabase(version: 11 | 12 | 13): Promise<string> {
  const dbPath = await databasePath(`schema-v${version}`);
  const db = openDatabase(dbPath);
  seedLegacySnapshot(db, dbPath);
  downgradeFromV14ToV13(db);
  if (version < 13) downgradeFromV13ToV12(db);
  if (version < 12) downgradeFromV12(db);
  db.close();
  return dbPath;
}

async function fileHash(dbPath: string): Promise<string> {
  const bytes = await readFile(dbPath);
  return createHash('sha256').update(bytes).digest('hex');
}

function column(
  db: Db,
  table: string,
  name: string,
): Record<string, unknown> | undefined {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .find((item) => item.name === name);
}

function graphSnapshot(db: Db): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT * FROM graph_edges ORDER BY id',
  ).all();
}

async function verifyReadOnlyV12(): Promise<void> {
  const dbPath = await createLegacyDatabase(12);
  const hashBefore = await fileHash(dbPath);
  const reader = openReadOnlyDatabase(dbPath);
  expect(factLifecycleDiagnostic(reader)).toMatchObject({
    code: 'schema_upgrade_required',
    currentSchemaVersion: 12,
    requiredSchemaVersion: 14,
  });
  expect(doctorDiagnostics(reader, true, { workspaceId: 1 })[0])
    .toMatchObject({ code: 'schema_upgrade_required' });
  expect(trace(reader, { repo: 'neutral-service' }, {
    depth: 1,
    workspaceId: 1,
  }).diagnostics[0]).toMatchObject({ code: 'schema_upgrade_required' });
  expect(schemaVersion(reader)).toBe(12);
  expect(column(reader, 'repositories', 'package_public_surface_json'))
    .toBeUndefined();
  expect(column(reader, 'service_bindings', 'binding_site_start_offset'))
    .toBeUndefined();
  reader.close();
  expect(await fileHash(dbPath)).toBe(hashBefore);
}

async function verifyReadOnlyV13(): Promise<void> {
  const dbPath = await createLegacyDatabase(13);
  const hashBefore = await fileHash(dbPath);
  const reader = openReadOnlyDatabase(dbPath);
  expect(factLifecycleDiagnostic(reader)).toMatchObject({
    code: 'schema_upgrade_required',
    currentSchemaVersion: 13,
    requiredSchemaVersion: 14,
  });
  expect(schemaVersion(reader)).toBe(13);
  expect(column(reader, 'repositories', 'environment_declarations_json'))
    .toBeUndefined();
  expect(column(reader, 'outbound_calls', 'event_skeleton_signature'))
    .toBeUndefined();
  expect(column(reader, 'generated_constants', 'id')).toBeUndefined();
  reader.close();
  expect(await fileHash(dbPath)).toBe(hashBefore);
}

async function verifyV13Migration(): Promise<void> {
  const dbPath = await createLegacyDatabase(13);
  const before = openReadOnlyDatabase(dbPath);
  const graphBefore = graphSnapshot(before);
  before.close();
  const migrated = openDatabase(dbPath);
  const fresh = openDatabase(await databasePath('fresh-v14-default'));
  expect(schemaVersion(migrated)).toBe(14);
  expect(column(migrated, 'repositories', 'environment_declarations_json'))
    .toMatchObject({
      name: 'environment_declarations_json',
      type: 'TEXT',
      dflt_value: column(
        fresh, 'repositories', 'environment_declarations_json',
      )?.dflt_value,
    });
  fresh.close();
  expect(column(migrated, 'outbound_calls', 'event_skeleton_signature'))
    .toMatchObject({ name: 'event_skeleton_signature', type: 'TEXT' });
  expect(column(migrated, 'generated_constants', 'resolution_status'))
    .toMatchObject({ name: 'resolution_status', type: 'TEXT' });
  expect(migrated.prepare(`SELECT environment_declarations_json environment,
    graph_stale_reason staleReason FROM repositories WHERE id=1`).get())
    .toEqual({
      environment: null,
      staleReason: 'schema_v14_event_surface_requires_reindex',
    });
  expect(migrated.prepare(`SELECT event_skeleton_signature signature,
    event_skeleton_json skeleton FROM outbound_calls WHERE id=1`).get())
    .toEqual({ signature: null, skeleton: null });
  expect(migrated.prepare(
    'SELECT COUNT(*) count FROM generated_constants',
  ).get()?.count).toBe(0);
  expect(graphSnapshot(migrated)).toEqual(graphBefore);
  expect(migrated.pragma('integrity_check'))
    .toEqual([{ integrity_check: 'ok' }]);
  expect(migrated.pragma('foreign_key_check')).toEqual([]);
  migrated.close();
}

async function verifyV12Migration(): Promise<void> {
  const dbPath = await createLegacyDatabase(12);
  const before = openReadOnlyDatabase(dbPath);
  const graphBefore = graphSnapshot(before);
  before.close();
  const migrated = openDatabase(dbPath);
  expect(schemaVersion(migrated)).toBe(14);
  expect(column(migrated, 'repositories', 'package_public_surface_json'))
    .toMatchObject({ name: 'package_public_surface_json', type: 'TEXT' });
  expect(column(migrated, 'service_bindings', 'owner_resolution'))
    .toMatchObject({
      name: 'owner_resolution',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'legacy_unknown'",
    });
  expect(migrated.prepare(`SELECT binding_site_start_offset siteStart,
    binding_site_end_offset siteEnd,owner_resolution ownerResolution
    FROM service_bindings WHERE id=1`).get()).toEqual({
    siteStart: null, siteEnd: null, ownerResolution: 'legacy_unknown',
  });
  expect(migrated.prepare(`SELECT package_public_surface_json surface,
    environment_declarations_json environment,
    graph_stale_reason staleReason FROM repositories WHERE id=1`).get())
    .toEqual({
      surface: null,
      environment: null,
      staleReason: 'schema_v14_event_surface_requires_reindex',
    });
  expect(graphSnapshot(migrated)).toEqual(graphBefore);
  expect(factLifecycleDiagnostic(migrated, 1)).toMatchObject({
    code: 'reindex_required', staleRepositoryCount: 1,
  });
  expect(migrated.pragma('integrity_check'))
    .toEqual([{ integrity_check: 'ok' }]);
  expect(migrated.pragma('foreign_key_check')).toEqual([]);
  migrated.close();
}

function migrationState(db: Db): Record<string, unknown> {
  return {
    repository: db.prepare('SELECT * FROM repositories WHERE id=1').get(),
    binding: db.prepare('SELECT * FROM service_bindings WHERE id=1').get(),
    graph: graphSnapshot(db),
  };
}

function verifyExactSiteIndex(db: Db): void {
  const index = db.prepare(
    "PRAGMA index_list('service_bindings')",
  ).all().find((item) => item.name === 'uq_service_binding_exact_site');
  expect(index).toMatchObject({ unique: 1, partial: 1 });
  expect(db.prepare(
    'PRAGMA index_info(uq_service_binding_exact_site)',
  ).all().map((item) => item.name)).toEqual([
    'repo_id',
    'source_file',
    'variable_name',
    'binding_site_start_offset',
    'binding_site_end_offset',
  ]);
}

async function verifyIdempotentIndexMigration(): Promise<void> {
  const dbPath = await createLegacyDatabase(12);
  const migrated = openDatabase(dbPath);
  const stateBefore = migrationState(migrated);
  verifyExactSiteIndex(migrated);
  migrate(migrated);
  expect(schemaVersion(migrated)).toBe(14);
  expect(migrated.prepare(
    "PRAGMA index_list('service_bindings')",
  ).all().filter(
    (item) => item.name === 'uq_service_binding_exact_site',
  )).toHaveLength(1);
  expect(migrationState(migrated)).toEqual(stateBefore);
  migrated.close();
}

async function verifyV11Migration(): Promise<void> {
  const dbPath = await createLegacyDatabase(11);
  const migrated = openDatabase(dbPath);
  expect(schemaVersion(migrated)).toBe(14);
  expect(migrated.prepare(`SELECT call_site_start_offset siteStart,
    call_site_end_offset siteEnd FROM outbound_calls WHERE id=1`).get())
    .toEqual({ siteStart: null, siteEnd: null });
  expect(migrated.prepare(`SELECT call_site_start_offset siteStart,
    call_site_end_offset siteEnd,call_role role
    FROM symbol_calls WHERE id=1`).get()).toEqual({
    siteStart: null, siteEnd: null, role: 'legacy_unknown',
  });
  expect(migrated.prepare(`SELECT binding_site_start_offset siteStart,
    binding_site_end_offset siteEnd,owner_resolution ownerResolution
    FROM service_bindings WHERE id=1`).get()).toEqual({
    siteStart: null, siteEnd: null, ownerResolution: 'legacy_unknown',
  });
  expect(migrated.prepare(`SELECT package_public_surface_json surface,
    environment_declarations_json environment,
    graph_stale_reason staleReason FROM repositories WHERE id=1`).get())
    .toEqual({
      surface: null,
      environment: null,
      staleReason: 'schema_v14_event_surface_requires_reindex',
    });
  expect(graphSnapshot(migrated)).toHaveLength(1);
  expect(factLifecycleDiagnostic(migrated, 1)).toMatchObject({
    code: 'reindex_required', staleRepositoryCount: 1,
  });
  migrated.close();
}

interface MalformedSchemaCase {
  label: string;
  mutate: (db: Db) => void;
  category: string;
}

const malformedSchemaCases: MalformedSchemaCase[] = [
  {
    label: 'table',
    mutate: (db): void => db.exec('DROP TABLE diagnostics'),
    category: 'schema_required_table_missing',
  },
  {
    label: 'column',
    mutate: (db): void => db.exec(
      'ALTER TABLE repositories DROP COLUMN package_public_surface_json',
    ),
    category: 'schema_required_column_missing',
  },
  {
    label: 'index',
    mutate: (db): void => db.exec('DROP INDEX uq_service_binding_exact_site'),
    category: 'schema_binding_exact_site_index_invalid',
  },
  {
    label: 'lookup index',
    mutate: (db): void => db.exec('DROP INDEX idx_service_binding_site'),
    category: 'schema_binding_exact_site_index_invalid',
  },
  {
    label: 'event skeleton lookup index',
    mutate: (db): void => db.exec('DROP INDEX idx_outbound_event_skeleton'),
    category: 'schema_event_surface_index_invalid',
  },
  {
    label: 'generated constant unique index',
    mutate: (db): void => db.exec('DROP INDEX uq_generated_constant_site'),
    category: 'schema_event_surface_index_invalid',
  },
  {
    label: 'partial-index predicate',
    mutate: (db): void => db.exec(`
      DROP INDEX uq_service_binding_exact_site;
      CREATE UNIQUE INDEX uq_service_binding_exact_site
      ON service_bindings(
        repo_id,source_file,variable_name,
        binding_site_start_offset,binding_site_end_offset
      ) WHERE binding_site_start_offset IS NOT NULL
    `),
    category: 'schema_binding_exact_site_index_invalid',
  },
];

async function verifyMalformedSchema({
  mutate,
  category,
}: MalformedSchemaCase): Promise<void> {
  const dbPath = await databasePath(`malformed-${category}`);
  const malformed = openDatabase(dbPath);
  mutate(malformed);
  expect(() => factLifecycleDiagnostic(malformed)).not.toThrow();
  expect(factLifecycleDiagnostic(malformed)).toMatchObject({
    code: 'reindex_required',
    staleRepositoryCount: 0,
    invalidFactCategories: [{ category, count: 1 }],
  });
  malformed.close();
}

async function verifyFutureSchema(): Promise<void> {
  const dbPath = await databasePath('future-v15');
  const future = openDatabase(dbPath, { migrate: false });
  future.exec('PRAGMA user_version = 15');
  expect(factLifecycleDiagnostic(future)).toMatchObject({
    code: 'unsupported_future_schema',
    currentSchemaVersion: 15,
    supportedSchemaVersion: 14,
  });
  expect(() => migrate(future))
    .toThrow('Unsupported future service-flow schema version 15');
  expect(schemaVersion(future)).toBe(15);
  future.close();
}

describe('schema 14 event-surface lifecycle and provenance migration', () => {
  it('reports schema-v13 read-only without changing bytes or columns', verifyReadOnlyV13);
  it('reports schema-v12 read-only without changing bytes or columns', verifyReadOnlyV12);
  it('migrates v13 event facts without inventing provenance or replacing the graph', verifyV13Migration);
  it('migrates v12 facts without inventing provenance or replacing the graph', verifyV12Migration);
  it('creates one exact-site partial unique index and remains idempotent', verifyIdempotentIndexMigration);
  it('migrates v11 through both fact migrations without fabricating identity', verifyV11Migration);
  it.each(malformedSchemaCases)(
    'bounds malformed current schema with a missing $label',
    verifyMalformedSchema,
  );
  it('rejects schema version 15 before current-table inspection or migration', verifyFutureSchema);
});
