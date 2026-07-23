import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase, openReadOnlyDatabase } from '../../src/db/connection.js';
import { factLifecycleDiagnostic } from '../../src/db/001-fact-lifecycle.js';
import { migrate, schemaVersion } from '../../src/db/migrations.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { traceAndCompact } from '../../src/trace/018-compact-trace.js';
import { trace } from '../../src/trace/trace-engine.js';
import { ANALYZER_VERSION } from '../../src/version.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function createExtensionWorkspace(root: string, operationName: string): Promise<void> {
  await writeFixtureFile(root, 'model-lib/.git-fixture');
  await writeFixtureFile(root, 'model-lib/package.json', JSON.stringify({ name: '@neutral/model-lib', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-lib/srv/base.cds', `service BaseService { action ${operationName}(); }`);
  await writeFixtureFile(root, 'variant-service/.git-fixture');
  await writeFixtureFile(root, 'variant-service/package.json', JSON.stringify({ name: '@neutral/variant-service', version: '1.0.0', dependencies: { '@neutral/model-lib': '1.0.0' } }));
  await writeFixtureFile(root, 'variant-service/srv/extension.cds', "using { BaseService } from '@neutral/model-lib/srv/base';\nextend BaseService @(path: '/variant-api') {}");
}

function operationNames(db: Awaited<ReturnType<typeof prepareWorkspace>>['db']): string[] {
  return (db.prepare('SELECT operation_name operationName FROM cds_operations ORDER BY operation_name').all() as Array<{ operationName: string }>).map((row) => row.operationName);
}

function searchOperations(db: Awaited<ReturnType<typeof prepareWorkspace>>['db']): Array<Record<string, unknown>> {
  return db.prepare("SELECT name,path,repo FROM search_index WHERE kind='operation' ORDER BY repo,name,path").all() as Array<Record<string, unknown>>;
}

function repositoryPublicationState(db: Awaited<ReturnType<typeof prepareWorkspace>>['db']): Array<Record<string, unknown>> {
  return db.prepare('SELECT name,fact_generation factGeneration,graph_generation graphGeneration,graph_stale_reason graphStaleReason,index_status indexStatus FROM repositories ORDER BY name').all() as Array<Record<string, unknown>>;
}

function indexRunCount(db: Awaited<ReturnType<typeof prepareWorkspace>>['db'], status?: string): number {
  const row = status
    ? db.prepare('SELECT COUNT(*) count FROM index_runs WHERE status=?').get(status)
    : db.prepare('SELECT COUNT(*) count FROM index_runs').get();
  return Number(row?.count ?? 0);
}

describe('incremental indexing publication atomicity', () => {
  it('rejects a future schema read-only before querying v12 tables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-future-schema-'));
    const dbPath = path.join(root, 'graph.db');
    const future = openDatabase(dbPath, { migrate: false });
    future.exec('PRAGMA user_version = 13');
    future.close();

    const reader = openReadOnlyDatabase(dbPath);
    expect(factLifecycleDiagnostic(reader)).toMatchObject({
      code: 'unsupported_future_schema', currentSchemaVersion: 13,
      supportedSchemaVersion: 12,
    });
    reader.close();
  });

  it('migrates legacy index runs without losing run history', () => {
    const root = path.join(os.tmpdir(), `service-flow-index-migration-${process.pid}-${Date.now()}`);
    const dbPath = path.join(root, 'graph.db');
    const legacy = openDatabase(dbPath, { migrate: false });
    legacy.exec('CREATE TABLE index_runs (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, repo_count INTEGER NOT NULL, file_count INTEGER NOT NULL, diagnostic_count INTEGER NOT NULL, error_message TEXT)');
    legacy.exec('PRAGMA user_version = 10');
    legacy.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count) VALUES(?,?,?,?,?,?)').run(1, new Date(0).toISOString(), 'success', 2, 4, 0);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const ownerColumn = migrated.prepare('PRAGMA table_info(index_runs)').all().find((column) => column.name === 'owner_pid');
    const preserved = migrated.prepare('SELECT status,repo_count repoCount,owner_pid ownerPid FROM index_runs').get();

    expect(schemaVersion(migrated)).toBe(12);
    expect(ownerColumn).toMatchObject({ name: 'owner_pid', type: 'INTEGER' });
    expect(preserved).toEqual({ status: 'success', repoCount: 2, ownerPid: null });
    migrated.close();
  });

  it('migrates v11 call facts without inventing spans or roles and blocks link before deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-v11-call-sites-'));
    const dbPath = path.join(root, 'graph.db');
    await writeFixtureFile(root, 'legacy-events/package.json', JSON.stringify({
      name: '@neutral/legacy-events', version: '1.0.0',
    }));
    await writeFixtureFile(root, 'legacy-events/src/events.ts', `
export function legacyHandler(): void {}
export function register(): void {
  messaging.on('LegacyEvent', legacyHandler);
}
`);
    const legacy = openDatabase(dbPath, { migrate: false });
    legacy.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY, root_path TEXT UNIQUE NOT NULL, db_path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE repositories (
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL,
        absolute_path TEXT NOT NULL, relative_path TEXT NOT NULL, package_name TEXT,
        package_version TEXT, dependencies_json TEXT DEFAULT '{}', kind TEXT NOT NULL,
        is_git_repo INTEGER NOT NULL, last_indexed_at TEXT, index_status TEXT DEFAULT 'pending',
        error_count INTEGER DEFAULT 0, fingerprint TEXT, fact_generation INTEGER NOT NULL DEFAULT 0,
        graph_generation INTEGER NOT NULL DEFAULT 0, graph_stale_reason TEXT,
        graph_stale_at TEXT, fact_analyzer_version TEXT,
        UNIQUE(workspace_id,absolute_path),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, file_id INTEGER,
        kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
        exported INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_offset INTEGER, end_offset INTEGER, source_file TEXT, exported_name TEXT,
        evidence_json TEXT,
        FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
      );
      CREATE TABLE outbound_calls (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, source_symbol_id INTEGER,
        call_type TEXT NOT NULL, service_binding_id INTEGER, method TEXT,
        operation_path_expr TEXT, query_entity TEXT, event_name_expr TEXT,
        payload_summary TEXT, source_file TEXT NOT NULL, source_line INTEGER NOT NULL,
        confidence REAL NOT NULL, unresolved_reason TEXT, local_service_name TEXT,
        local_service_lookup TEXT, alias_chain_json TEXT, evidence_json TEXT,
        external_target_kind TEXT, external_target_id TEXT, external_target_label TEXT,
        external_target_dynamic INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY(source_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
      );
      CREATE TABLE symbol_calls (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, caller_symbol_id INTEGER NOT NULL,
        callee_symbol_id INTEGER, callee_expression TEXT NOT NULL, import_source TEXT,
        source_file TEXT NOT NULL, source_line INTEGER NOT NULL, status TEXT NOT NULL,
        confidence REAL NOT NULL, evidence_json TEXT NOT NULL, unresolved_reason TEXT,
        FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY(caller_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
        FOREIGN KEY(callee_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
      );
      CREATE TABLE graph_edges (
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, edge_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unresolved', from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL,
        confidence REAL NOT NULL, evidence_json TEXT NOT NULL, is_dynamic INTEGER NOT NULL,
        unresolved_reason TEXT, generation INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 11;
    `);
    const now = new Date(0).toISOString();
    legacy.prepare('INSERT INTO workspaces(id,root_path,db_path,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(1, root, dbPath, now, now);
    legacy.prepare(`INSERT INTO repositories(
      id,workspace_id,name,absolute_path,relative_path,kind,is_git_repo,last_indexed_at,
      index_status,fingerprint,fact_generation,graph_generation,fact_analyzer_version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      1, 1, 'legacy-events', path.join(root, 'legacy-events'), 'legacy-events',
      'cap-service', 1, now, 'indexed', 'legacy-fingerprint', 4, 5, '0.1.65',
    );
    legacy.prepare(`INSERT INTO symbols(
      id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
      start_offset,end_offset,source_file,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      1, 1, 'function', 'register', 'register', 0, 1, 20, 0, 500,
      'src/events.ts', '{}',
    );
    legacy.prepare(`INSERT INTO outbound_calls(
      id,repo_id,source_symbol_id,call_type,event_name_expr,source_file,source_line,
      confidence,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      1, 1, 1, 'async_subscribe', 'LegacyEvent', 'src/events.ts', 8, 0.8,
      JSON.stringify({ parser: 'typescript_ast', startOffset: 100, endOffset: 140 }),
    );
    legacy.prepare(`INSERT INTO symbol_calls(
      id,repo_id,caller_symbol_id,callee_expression,source_file,source_line,
      status,confidence,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      1, 1, 1, 'legacyHandler', 'src/events.ts', 8, 'unresolved', 0.8,
      JSON.stringify({
        relation: 'relative_import', startOffset: 100, endOffset: 140,
        candidateStrategy: 'event_subscribe_handler_reference',
      }),
    );
    legacy.prepare(`INSERT INTO graph_edges(
      id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
      confidence,evidence_json,is_dynamic,generation
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      1, 1, 'REPO_IMPORTS_HELPER_PACKAGE', 'resolved', 'repo', '1', 'repo', '1',
      1, '{"legacyGraph":true}', 0, 5,
    );
    expect(factLifecycleDiagnostic(legacy, 1)).toMatchObject({
      code: 'schema_upgrade_required', currentSchemaVersion: 11,
      requiredSchemaVersion: 12,
    });
    legacy.close();

    const untouchedReader = openReadOnlyDatabase(dbPath);
    const untouchedTrace = trace(
      untouchedReader, { repo: 'legacy-events' }, { depth: 1, workspaceId: 1 },
    );
    const untouchedCompact = traceAndCompact(
      untouchedReader, { repo: 'legacy-events' }, { depth: 1, workspaceId: 1 },
    ).compact;
    const untouchedDoctor = doctorDiagnostics(
      untouchedReader, true, { workspaceId: 1 },
    );
    expect(untouchedTrace.diagnostics[0]).toMatchObject({
      code: 'schema_upgrade_required', currentSchemaVersion: 11,
    });
    expect(untouchedCompact.diagnostics[0]?.[2]).toBe('schema_upgrade_required');
    expect(untouchedDoctor[0]).toMatchObject({
      code: 'schema_upgrade_required', currentSchemaVersion: 11,
    });
    expect(JSON.stringify([
      untouchedTrace, untouchedCompact, untouchedDoctor,
    ]).toLowerCase()).not.toContain('no such column');
    untouchedReader.close();

    const migrated = openDatabase(dbPath);
    const outboundColumns = migrated.prepare('PRAGMA table_info(outbound_calls)').all();
    const symbolColumns = migrated.prepare('PRAGMA table_info(symbol_calls)').all();
    const roleColumn = symbolColumns.find((column) => column.name === 'call_role');
    const outboundIndexes = migrated.prepare('PRAGMA index_list(outbound_calls)').all();
    const symbolIndexes = migrated.prepare('PRAGMA index_list(symbol_calls)').all();
    expect(schemaVersion(migrated)).toBe(12);
    expect(outboundColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'call_site_start_offset', 'call_site_end_offset',
    ]));
    expect(symbolColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'call_site_start_offset', 'call_site_end_offset', 'call_role',
    ]));
    expect(roleColumn).toMatchObject({
      type: 'TEXT', notnull: 1, dflt_value: "'legacy_unknown'",
    });
    expect(outboundIndexes.map((index) => index.name))
      .toContain('idx_outbound_call_site');
    expect(symbolIndexes.map((index) => index.name))
      .toContain('idx_symbol_call_site_role');
    expect(migrated.prepare(`SELECT call_site_start_offset startOffset,
      call_site_end_offset endOffset FROM outbound_calls WHERE id=1`).get())
      .toEqual({ startOffset: null, endOffset: null });
    expect(migrated.prepare(`SELECT call_site_start_offset startOffset,
      call_site_end_offset endOffset,call_role callRole,evidence_json evidenceJson
      FROM symbol_calls WHERE id=1`).get()).toEqual({
      startOffset: null,
      endOffset: null,
      callRole: 'legacy_unknown',
      evidenceJson: JSON.stringify({
        relation: 'relative_import', startOffset: 100, endOffset: 140,
        candidateStrategy: 'event_subscribe_handler_reference',
      }),
    });
    expect(migrated.prepare(`SELECT graph_stale_reason reason,
      fact_analyzer_version analyzer FROM repositories WHERE id=1`).get()).toEqual({
      reason: 'schema_v12_call_sites_require_reindex', analyzer: '0.1.65',
    });
    expect(factLifecycleDiagnostic(migrated, 1)).toMatchObject({
      code: 'reindex_required', staleRepositoryCount: 1,
    });
    const graphBefore = migrated.prepare('SELECT * FROM graph_edges WHERE workspace_id=1').all();
    expect(() => linkWorkspace(migrated, 1)).toThrow(/reindex_required[\s\S]*index --workspace \/workspace --force[\s\S]*link --workspace \/workspace --force/);
    expect(migrated.prepare('SELECT * FROM graph_edges WHERE workspace_id=1').all())
      .toEqual(graphBefore);
    expect(migrated.prepare('SELECT graph_stale_reason reason FROM repositories WHERE id=1')
      .get()?.reason).toBe('schema_v12_call_sites_require_reindex');
    expect(migrated.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);

    migrate(migrated);
    expect(migrated.prepare(`SELECT call_role callRole,
      call_site_start_offset startOffset,call_site_end_offset endOffset
      FROM symbol_calls WHERE id=1`).get()).toEqual({
      callRole: 'legacy_unknown', startOffset: null, endOffset: null,
    });
    expect(migrated.prepare('PRAGMA index_list(outbound_calls)').all()
      .filter((index) => index.name === 'idx_outbound_call_site')).toHaveLength(1);
    expect(migrated.prepare('PRAGMA index_list(symbol_calls)').all()
      .filter((index) => index.name === 'idx_symbol_call_site_role')).toHaveLength(1);

    await expect(indexWorkspace(migrated, 1, { force: true })).resolves.toMatchObject({
      repoCount: 1, indexedCount: 1, skippedCount: 0,
    });
    expect(factLifecycleDiagnostic(migrated, 1)).toBeUndefined();
    const linked = linkWorkspace(migrated, 1);
    expect(linked).toMatchObject({
      subscriptionHandlerResolvedCount: 1,
      subscriptionHandlerAmbiguousCount: 0,
      subscriptionHandlerUnresolvedCount: 0,
      subscriptionHandlerMissingAssociationCount: 0,
    });
    expect(linked.edgeCount).toBe(Number(
      migrated.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=1')
        .get()?.count,
    ));
    expect(migrated.prepare(`SELECT fact_analyzer_version analyzer,
      graph_stale_reason staleReason FROM repositories WHERE id=1`).get()).toEqual({
      analyzer: ANALYZER_VERSION, staleReason: null,
    });
    expect(migrated.prepare(`SELECT call_role callRole,
      call_site_start_offset startOffset,call_site_end_offset endOffset,
      json_extract(evidence_json,'$.factOrigin') factOrigin
      FROM symbol_calls WHERE call_role='event_subscribe_handler'`).get())
      .toMatchObject({
        callRole: 'event_subscribe_handler',
        factOrigin: 'event_subscribe_handler_reference',
      });
    const currentHandler = migrated.prepare(`SELECT call_site_start_offset startOffset,
      call_site_end_offset endOffset FROM symbol_calls
      WHERE call_role='event_subscribe_handler'`).get();
    expect(typeof currentHandler?.startOffset).toBe('number');
    expect(Number(currentHandler?.endOffset)).toBeGreaterThan(
      Number(currentHandler?.startOffset),
    );
    expect(migrated.prepare(`SELECT edge_type edgeType,status,from_kind fromKind,
      from_id fromId,to_kind toKind FROM graph_edges
      WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'`).get()).toMatchObject({
      edgeType: 'EVENT_SUBSCRIPTION_HANDLED_BY', status: 'resolved',
      fromKind: 'event', fromId: 'LegacyEvent', toKind: 'symbol',
    });
    const lifecycleCodes = new Set([
      'schema_upgrade_required', 'reindex_required',
      'reindex_required_after_analyzer_upgrade',
    ]);
    expect(doctorDiagnostics(migrated, true, { workspaceId: 1 })
      .filter((diagnostic) => lifecycleCodes.has(String(diagnostic.code))))
      .toEqual([]);
    expect(migrated.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });

  it('adds legacy columns before creating indexes that depend on them', () => {
    const root = path.join(
      os.tmpdir(), `service-flow-index-column-migration-${process.pid}-${Date.now()}`,
    );
    const dbPath = path.join(root, 'graph.db');
    const legacy = openDatabase(dbPath, { migrate: false });
    legacy.exec(`CREATE TABLE cds_services (
      id INTEGER PRIMARY KEY,
      service_path TEXT NOT NULL,
      is_extend INTEGER NOT NULL
    )`);
    legacy.exec('PRAGMA user_version = 6');
    legacy.close();

    const migrated = openDatabase(dbPath);
    const columns = migrated.prepare('PRAGMA table_info(cds_services)').all()
      .map((column) => column.name);
    const indexes = migrated.prepare('PRAGMA index_list(cds_services)').all()
      .map((index) => index.name);

    expect(columns).toContain('extension_module_specifier');
    expect(columns).toContain('extension_imported_symbol');
    expect(indexes).toContain('idx_extension_import');
    expect(migrated.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });

  it('rolls back the full publication snapshot and recovers on a subsequent full index and link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-atomicity-'));
    await createExtensionWorkspace(root, 'stableAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    expect(operationNames(db)).toEqual(['stableAction', 'stableAction']);
    const publishedOperations = operationNames(db);
    const publishedSearch = searchOperations(db);
    const publishedRepositories = repositoryPublicationState(db);

    await writeFixtureFile(root, 'model-lib/srv/base.cds', 'service BaseService { action renamedAction(); }');
    await expect(indexWorkspace(db, workspaceId, {
      force: true,
      injectDerivedMaterializationFailure: true,
    })).rejects.toThrow('Injected derived materialization failure');

    expect(operationNames(db)).toEqual(publishedOperations);
    expect(searchOperations(db)).toEqual(publishedSearch);
    expect(repositoryPublicationState(db)).toEqual(publishedRepositories);
    expect(db.prepare("SELECT status,error_message errorMessage FROM index_runs ORDER BY id DESC LIMIT 1").get()).toMatchObject({
      status: 'failed',
      errorMessage: 'Injected derived materialization failure',
    });
    expect(db.prepare('SELECT status,COUNT(*) count FROM index_runs GROUP BY status ORDER BY status').all()).toEqual([
      { status: 'failed', count: 1 },
      { status: 'success', count: 1 },
    ]);

    await indexWorkspace(db, workspaceId, { force: true });
    expect(operationNames(db)).toEqual(['renamedAction', 'renamedAction']);
    expect(searchOperations(db).map((row) => row.name)).toEqual(['renamedAction', 'renamedAction']);
    const stale = repositoryPublicationState(db);
    expect(stale.every((row) => row.graphStaleReason !== null)).toBe(true);
    linkWorkspace(db, workspaceId);
    const recovered = repositoryPublicationState(db);
    expect(recovered.every((row) => row.graphStaleReason === null && row.indexStatus === 'indexed')).toBe(true);
    expect(recovered.every((row, index) =>
      Number(row.factGeneration) > Number(publishedRepositories[index]?.factGeneration)
      && Number(row.graphGeneration) > Number(publishedRepositories[index]?.graphGeneration))).toBe(true);
    expect(db.prepare("SELECT status,error_message errorMessage FROM index_runs ORDER BY id DESC LIMIT 1").get()).toMatchObject({
      status: 'success',
      errorMessage: null,
    });
    db.close();
  });

  it('keeps a successfully published run successful when indexing records warnings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-warning-'));
    await writeFixtureFile(root, 'warning-service/.git-fixture');
    await writeFixtureFile(root, 'warning-service/package.json', JSON.stringify({
      name: '@neutral/warning-service',
      version: '1.0.0',
    }));
    await writeFixtureFile(root, 'warning-service/srv/WarningHandler.ts', [
      "import { Handler } from 'cds-routing-handlers';",
      '@Handler()',
      'export class WarningHandler {',
      '  @CustomRoute()',
      '  async customRoute(): Promise<void> {}',
      '}',
    ].join('\n'));

    const { db } = await prepareWorkspace(root);
    const latestRun = db.prepare('SELECT status,diagnostic_count diagnosticCount,error_message errorMessage FROM index_runs ORDER BY id DESC LIMIT 1').get();

    expect(latestRun).toEqual({ status: 'success', diagnosticCount: 1, errorMessage: null });
    expect(db.prepare("SELECT COUNT(*) count FROM diagnostics WHERE code='handler_methods_not_indexed'").get()).toEqual({ count: 1 });
    db.close();
  });

  it('claims a workspace writer before preparation and rejects a concurrent connection without a second run row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-writer-'));
    await createExtensionWorkspace(root, 'coordinatedAction');
    const { db: firstDb, workspaceId } = await prepareWorkspace(root);
    const secondDb = openDatabase(firstDb.path);
    const previousRunCount = indexRunCount(firstDb);

    const firstIndex = indexWorkspace(firstDb, workspaceId, { force: true });
    const secondIndex = indexWorkspace(secondDb, workspaceId, { force: true });
    const reader = openReadOnlyDatabase(firstDb.path);
    const runningDuringPreparation = indexRunCount(firstDb, 'running');
    const rowsDuringPreparation = indexRunCount(firstDb);
    const readableRepositoryCount = reader.prepare('SELECT COUNT(*) count FROM repositories').get()?.count;
    const outcomes = await Promise.allSettled([firstIndex, secondIndex]);
    const finalRunningCount = indexRunCount(firstDb, 'running');
    const integrity = firstDb.pragma('integrity_check');
    const foreignKeyViolations = firstDb.pragma('foreign_key_check');
    firstDb.close();
    secondDb.close();
    reader.close();

    expect(runningDuringPreparation).toBe(1);
    expect(rowsDuringPreparation).toBe(previousRunCount + 1);
    expect(readableRepositoryCount).toBe(2);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    if (outcomes[1].status === 'rejected') {
      const reason: unknown = outcomes[1].reason;
      expect(reason).toBeInstanceOf(Error);
      if (reason instanceof Error) expect(reason.message).toContain('index_writer_active');
    }
    expect(finalRunningCount).toBe(0);
    expect(integrity).toEqual([{ integrity_check: 'ok' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('reconciles a running row owned by a dead process before starting a new index run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-dead-owner-'));
    await createExtensionWorkspace(root, 'recoveredAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    const deadOwnerPid = 2_147_483_647;
    const staleRun = db.prepare("INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid) VALUES(?,?,?,?,?,?,?) RETURNING id").get(
      workspaceId, new Date(0).toISOString(), 'running', 2, 0, 0, deadOwnerPid,
    );

    await expect(indexWorkspace(db, workspaceId, { force: true })).resolves.toMatchObject({ repoCount: 2 });
    const reconciled = db.prepare('SELECT status,finished_at finishedAt,error_message errorMessage,owner_pid ownerPid FROM index_runs WHERE id=?').get(staleRun?.id);
    const latest = db.prepare('SELECT status,owner_pid ownerPid FROM index_runs ORDER BY id DESC LIMIT 1').get();

    expect(reconciled).toMatchObject({ status: 'failed', ownerPid: deadOwnerPid });
    expect(reconciled?.finishedAt).toEqual(expect.any(String));
    expect(String(reconciled?.errorMessage)).toMatch(/owner|process|stale|dead/i);
    expect(latest).toMatchObject({ status: 'success', ownerPid: process.pid });
    db.close();
  });

  it('recovers an old ownerless run while preserving a recent ownerless claim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-legacy-owner-'));
    await createExtensionWorkspace(root, 'legacyOwnerAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    const staleRun = db.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count) VALUES(?,?,?,?,?,?) RETURNING id').get(
      workspaceId, new Date(0).toISOString(), 'running', 2, 0, 0,
    );

    await expect(indexWorkspace(db, workspaceId, { force: true })).resolves.toMatchObject({ indexedCount: 2 });
    const recovered = db.prepare('SELECT status,error_message errorMessage FROM index_runs WHERE id=?').get(staleRun?.id);
    expect(recovered).toMatchObject({ status: 'failed' });
    expect(String(recovered?.errorMessage)).toMatch(/legacy|owner|stale/i);

    db.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count) VALUES(?,?,?,?,?,?)').run(
      workspaceId, new Date().toISOString(), 'running', 2, 0, 0,
    );
    await expect(indexWorkspace(db, workspaceId, { force: true })).rejects.toThrow(/index_writer_active/);
    expect(indexRunCount(db, 'running')).toBe(1);
    db.close();
  });

  it('rejects indexing while a running row is owned by the live process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-live-owner-'));
    await createExtensionWorkspace(root, 'blockedAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    const activeRun = db.prepare("INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid) VALUES(?,?,?,?,?,?,?) RETURNING id").get(
      workspaceId, new Date().toISOString(), 'running', 2, 0, 0, process.pid,
    );
    const runCountBefore = indexRunCount(db);

    await expect(indexWorkspace(db, workspaceId, { force: true })).rejects.toThrow(/index_writer_active/);

    expect(indexRunCount(db)).toBe(runCountBefore);
    expect(db.prepare('SELECT status,finished_at finishedAt FROM index_runs WHERE id=?').get(activeRun?.id)).toEqual({
      status: 'running',
      finishedAt: null,
    });
    db.close();
  });

  it('coordinates writers across workspaces that share one database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-shared-db-'));
    await createExtensionWorkspace(root, 'sharedDatabaseAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    const now = new Date().toISOString();
    const otherWorkspace = db.prepare('INSERT INTO workspaces(root_path,db_path,created_at,updated_at) VALUES(?,?,?,?) RETURNING id').get(
      path.join(root, 'other-workspace'), db.path, now, now,
    );
    db.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid) VALUES(?,?,?,?,?,?,?)').run(
      otherWorkspace?.id, now, 'running', 0, 0, 0, process.pid,
    );
    const runCountBefore = indexRunCount(db);

    await expect(indexWorkspace(db, workspaceId, { force: true })).rejects.toThrow(/index_writer_active/);

    expect(indexRunCount(db)).toBe(runCountBefore);
    expect(indexRunCount(db, 'running')).toBe(1);
    db.close();
  });

  it('prepares only repositories owned by the selected workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-scope-'));
    await createExtensionWorkspace(root, 'scopedAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    const now = new Date().toISOString();
    const otherWorkspace = db.prepare(`INSERT INTO workspaces(
      root_path,db_path,created_at,updated_at
    ) VALUES(?,?,?,?) RETURNING id`).get(
      path.join(root, 'other-workspace'), db.path, now, now,
    );
    db.prepare(`INSERT INTO repositories(
      workspace_id,name,absolute_path,relative_path,kind,is_git_repo
    ) VALUES(?,?,?,?,?,?)`).run(
      otherWorkspace?.id,
      'unrelated-service',
      path.join(root, 'missing-unrelated-service'),
      'unrelated-service',
      'unknown',
      0,
    );

    await expect(indexWorkspace(db, workspaceId, { force: true }))
      .resolves.toMatchObject({ repoCount: 2, indexedCount: 2 });
    expect(db.prepare(`SELECT index_status indexStatus FROM repositories
      WHERE name='unrelated-service'`).get()).toEqual({ indexStatus: 'pending' });
    db.close();
  });

  it('fails closed when the owner process liveness cannot be determined', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-unknown-owner-'));
    await createExtensionWorkspace(root, 'unknownOwnerAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    db.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid) VALUES(?,?,?,?,?,?,?)').run(
      workspaceId, new Date().toISOString(), 'running', 2, 0, 0, process.pid,
    );
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('process liveness unavailable');
    });

    try {
      await expect(indexWorkspace(db, workspaceId, { force: true })).rejects.toThrow(/index_writer_active/);
      expect(indexRunCount(db, 'running')).toBe(1);
    } finally {
      processKill.mockRestore();
      db.close();
    }
  });

  it('does not retain nested-transaction state when BEGIN IMMEDIATE fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-transaction-lock-'));
    const dbPath = path.join(root, 'graph.db');
    const lockHolder = openDatabase(dbPath);
    const contender = openDatabase(dbPath);
    lockHolder.exec('CREATE TABLE transaction_probe(value TEXT NOT NULL)');
    contender.pragma('busy_timeout = 0');
    lockHolder.exec('BEGIN IMMEDIATE');
    let blockedCallbackEntered = false;

    expect(() => contender.transaction(() => { blockedCallbackEntered = true; })).toThrow(/locked/i);
    expect(blockedCallbackEntered).toBe(false);
    lockHolder.exec('ROLLBACK');
    expect(() => contender.transaction(() => {
      contender.prepare('INSERT INTO transaction_probe(value) VALUES(?)').run('must-roll-back');
      throw new Error('transaction_probe_failure');
    })).toThrow('transaction_probe_failure');

    expect(contender.prepare('SELECT COUNT(*) count FROM transaction_probe').get()).toEqual({ count: 0 });
    lockHolder.close();
    contender.close();
  });

  it('reports an actionable diagnostic when the writer claim stays locked', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-claim-lock-'));
    const dbPath = path.join(root, 'graph.db');
    const lockHolder = openDatabase(dbPath);
    const contender = openDatabase(dbPath);
    const now = new Date().toISOString();
    const workspace = lockHolder.prepare(`INSERT INTO workspaces(
      root_path,db_path,created_at,updated_at
    ) VALUES(?,?,?,?) RETURNING id`).get(root, dbPath, now, now);
    contender.pragma('busy_timeout = 0');
    lockHolder.exec('BEGIN IMMEDIATE');

    await expect(indexWorkspace(
      contender, Number(workspace?.id), { force: true },
    )).rejects.toThrow('index_writer_coordination_failed');

    lockHolder.exec('ROLLBACK');
    expect(contender.prepare('SELECT COUNT(*) count FROM index_runs').get())
      .toEqual({ count: 0 });
    lockHolder.close();
    contender.close();
  });
});
