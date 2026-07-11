import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function writeScopedRepository(root: string): Promise<void> {
  await writeFixtureFile(root, 'shared-service/.git-fixture');
  await writeFixtureFile(root, 'shared-service/package.json', JSON.stringify({
    name: '@neutral/shared-service',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, 'shared-service/srv/ScopedHandler.ts', [
    "import { Handler, OnUpdate } from 'cds-routing-handlers';",
    '@Handler()',
    'export class ScopedHandler {',
    '  @OnUpdate()',
    '  async updateRecord(): Promise<void> {',
    "    await fetch('https://example.invalid/scoped');",
    '  }',
    '}',
  ].join('\n'));
}

describe('workspace-scoped trace selectors', () => {
  it('ignores repository selectors owned by another workspace in a shared database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-selector-scope-'));
    await writeScopedRepository(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const now = new Date().toISOString();
    const otherWorkspace = db.prepare(`INSERT INTO workspaces(
      root_path,db_path,created_at,updated_at
    ) VALUES(?,?,?,?) RETURNING id`).get(
      path.join(root, 'other-workspace'), db.path, now, now,
    );
    db.prepare(`INSERT INTO repositories(
      workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
    ) VALUES(?,?,?,?,?,?,?)`).run(
      otherWorkspace?.id,
      'shared-service',
      path.join(root, 'other-workspace/shared-service'),
      'shared-service',
      '@neutral/shared-service',
      'cap-service',
      0,
    );
    db.prepare(`INSERT INTO repositories(
      workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
    ) VALUES(?,?,?,?,?,?,?)`).run(
      otherWorkspace?.id,
      'foreign-service',
      path.join(root, 'other-workspace/foreign-service'),
      'foreign-service',
      '@neutral/foreign-service',
      'cap-service',
      0,
    );

    const scoped = trace(db, {
      repo: 'shared-service',
      handler: 'ScopedHandler',
    }, {
      depth: 4,
      includeExternal: true,
      workspaceId,
    });
    expect(scoped.diagnostics.some((item) =>
      item.code === 'selector_repo_ambiguous')).toBe(false);
    expect(scoped.edges.some((edge) => edge.type === 'external_http')).toBe(true);

    const foreign = trace(db, {
      repo: 'foreign-service',
      handler: 'ScopedHandler',
    }, { depth: 4, workspaceId });
    expect(foreign.nodes).toEqual([]);
    expect(foreign.edges).toEqual([]);
    expect(foreign.diagnostics).toContainEqual(expect.objectContaining({
      code: 'selector_repo_not_found',
      requestedRepository: 'foreign-service',
    }));
    db.close();
  });
});
