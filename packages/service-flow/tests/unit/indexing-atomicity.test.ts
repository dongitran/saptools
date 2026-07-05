import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
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

describe('incremental indexing publication atomicity', () => {
  it('rolls back direct and derived fact publication when derived materialization fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-index-atomicity-'));
    await createExtensionWorkspace(root, 'stableAction');
    const { db, workspaceId } = await prepareWorkspace(root);
    expect(operationNames(db)).toEqual(['stableAction', 'stableAction']);

    await writeFixtureFile(root, 'model-lib/srv/base.cds', 'service BaseService { action renamedAction(); }');
    await expect(indexWorkspace(db, workspaceId, {
      force: true,
      injectDerivedMaterializationFailure: true,
    })).rejects.toThrow('Injected derived materialization failure');

    expect(operationNames(db)).toEqual(['stableAction', 'stableAction']);
    expect(db.prepare("SELECT status,error_message errorMessage FROM index_runs ORDER BY id DESC LIMIT 1").get()).toMatchObject({
      status: 'failed',
      errorMessage: 'Injected derived materialization failure',
    });
    db.close();
  });
});
