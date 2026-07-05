import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import { upsertRepository, upsertWorkspace } from '../../src/db/repositories.js';
import { discoverRepositories } from '../../src/discovery/discover-repositories.js';
import { classifyRepository } from '../../src/discovery/classify-repository.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { parsePackageJson } from '../../src/parsers/package-json-parser.js';

export async function writeFixtureFile(root: string, relative: string, content = ''): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function prepareWorkspace(root: string): Promise<{ db: ReturnType<typeof openDatabase>; workspaceId: number }> {
  const dbPath = path.join(root, 'graph.db');
  const db = openDatabase(dbPath);
  const workspaceId = upsertWorkspace(db, root, dbPath);
  for (const repo of await discoverRepositories(root, ['node_modules', '.git'])) {
    const pkg = await parsePackageJson(repo.absolutePath);
    upsertRepository(db, workspaceId, {
      ...repo,
      packageName: pkg.packageName,
      packageVersion: pkg.packageVersion,
      dependencies: pkg.dependencies,
      kind: await classifyRepository(repo.absolutePath, pkg),
    });
  }
  await indexWorkspace(db, workspaceId, { force: true });
  return { db, workspaceId };
}
