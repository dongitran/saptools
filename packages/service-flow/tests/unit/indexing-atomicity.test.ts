import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
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

describe('incremental indexing publication atomicity', () => {
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
});
