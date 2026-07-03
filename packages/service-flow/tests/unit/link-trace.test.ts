import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import { discoverRepositories } from '../../src/discovery/discover-repositories.js';
import {
  upsertRepository,
  upsertWorkspace
} from '../../src/db/repositories.js';
import { parsePackageJson } from '../../src/parsers/package-json-parser.js';
import { classifyRepository } from '../../src/discovery/classify-repository.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace, trace } from '../../src/index.js';
const fixture = path.resolve('tests/fixtures/cap-workspace');
describe('linker and trace engine', () => {
  it('links cross repository calls and traces fixture flow', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'service-flow-'));
    const db = openDatabase(path.join(dir, 'graph.db'));
    const workspaceId = upsertWorkspace(
      db,
      fixture,
      path.join(dir, 'graph.db')
    );
    for (const repo of await discoverRepositories(fixture, [
      'node_modules',
      '.git'
    ])) {
      const pkg = await parsePackageJson(repo.absolutePath);
      upsertRepository(db, workspaceId, {
        ...repo,
        packageName: pkg.packageName,
        packageVersion: pkg.packageVersion,
        dependencies: pkg.dependencies,
        kind: await classifyRepository(repo.absolutePath, pkg)
      });
    }
    const indexed = await indexWorkspace(db, workspaceId, { force: true });
    expect(indexed.repoCount).toBe(5);
    const linked = linkWorkspace(db, workspaceId, {
      objectType: 'Thing',
      objectCode: 'xx'
    });
    expect(linked.edgeCount).toBeGreaterThan(0);
    const result = trace(
      db,
      { repo: 'facade-service', operation: 'doWork' },
      { depth: 20, includeDb: true, includeAsync: true, includeExternal: true }
    );
    expect(result.edges.map((e) => e.type)).toContain('remote_action');
    db.close();
  });
});
