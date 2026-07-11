import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase, openReadOnlyDatabase } from '../../src/db/connection.js';
import { schemaVersion } from '../../src/db/migrations.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
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

    expect(schemaVersion(migrated)).toBe(11);
    expect(ownerColumn).toMatchObject({ name: 'owner_pid', type: 'INTEGER' });
    expect(preserved).toEqual({ status: 'success', repoCount: 2, ownerPid: null });
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
