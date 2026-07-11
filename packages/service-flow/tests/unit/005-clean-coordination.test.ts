import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanWorkspaceState } from '../../src/cli/000-clean.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function prepareCleanWorkspace(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-clean-'));
  await writeFixtureFile(root, 'clean-service/.git-fixture');
  await writeFixtureFile(root, 'clean-service/package.json', JSON.stringify({
    name: '@neutral/clean-service',
    version: '1.0.0',
  }));
  return prepareWorkspace(root);
}

describe('clean writer coordination', () => {
  it('refuses to remove a database while an index writer is active', async () => {
    const { db, workspaceId } = await prepareCleanWorkspace();
    const workspace = db.prepare('SELECT root_path rootPath FROM workspaces WHERE id=?')
      .get(workspaceId);
    db.prepare(`INSERT INTO index_runs(
      workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid
    ) VALUES(?,?,?,?,?,?,?)`).run(
      workspaceId, new Date().toISOString(), 'running', 1, 0, 0, process.pid,
    );

    await expect(cleanWorkspaceState({
      dbPath: db.path,
      rootPath: String(workspace?.rootPath),
    }, true)).rejects.toThrow('index_writer_active');

    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.prepare("SELECT COUNT(*) count FROM index_runs WHERE status='running'")
      .get()).toEqual({ count: 1 });
    await expect(stat(db.path)).resolves.toBeDefined();
    db.close();
  });

  it('removes only the coordinated database files in db-only mode', async () => {
    const { db, workspaceId } = await prepareCleanWorkspace();
    const dbPath = db.path;
    const workspace = db.prepare('SELECT root_path rootPath FROM workspaces WHERE id=?')
      .get(workspaceId);
    const rootPath = String(workspace?.rootPath);
    db.close();

    await cleanWorkspaceState({ dbPath, rootPath }, true);

    await expect(stat(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(rootPath)).resolves.toBeDefined();
  });
});
