import { mkdtemp, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoByName, type RepoRow } from '../../src/db/repositories.js';
import {
  indexRepository,
  prepareRepositoryIndex,
} from '../../src/indexer/repository-indexer.js';
import type { SourceContextInstrumentation } from '../../src/parsers/ts-project.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function writeReuseRepository(root: string, name: string): Promise<string> {
  const repositoryPath = path.join(root, name);
  await writeFixtureFile(root, `${name}/package.json`, JSON.stringify({
    name: `@neutral/${name}`,
    version: '1.0.0',
  }));
  await writeFixtureFile(
    root,
    `${name}/srv/model.cds`,
    "@path: '/flow' service FlowService { action collect(); }",
  );
  await writeFixtureFile(root, `${name}/src/helper.ts`, [
    'export async function connectWorker() {',
    "  return cds.connect.to('worker');",
    '}',
  ].join('\n'));
  await writeFixtureFile(root, `${name}/src/wrapper.ts`, [
    'export async function invoke(client, path) {',
    "  return client.send({ method: 'POST', path });",
    '}',
  ].join('\n'));
  await writeFixtureFile(root, `${name}/src/FlowHandler.ts`, [
    "import { connectWorker } from './helper.js';",
    "import { invoke } from './wrapper.js';",
    '@Handler()',
    'export class FlowHandler {',
    "  @On('collect')",
    '  async collect() {',
    '    const client = await connectWorker();',
    "    await invoke(client, '/collect');",
    '  }',
    '}',
    'createCombinedHandler({ handler: [FlowHandler] });',
  ].join('\n'));
  return repositoryPath;
}

function repositoryRow(absolutePath: string, id: number): RepoRow {
  return {
    id,
    name: path.basename(absolutePath),
    absolute_path: absolutePath,
    relative_path: path.basename(absolutePath),
    package_name: null,
    package_version: null,
    dependencies_json: '{}',
    kind: 'unknown',
  };
}

describe('repository-scoped source parsing context', () => {
  it('reads each source once and creates at most one shared TypeScript AST per repository preparation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-source-context-'));
    const firstPath = await writeReuseRepository(root, 'first-service');
    const secondPath = await writeReuseRepository(root, 'second-service');
    const sourceReads: string[] = [];
    const astCreations: string[] = [];
    const instrumentation: SourceContextInstrumentation = {
      onSourceRead: (repoPath, filePath) => {
        sourceReads.push(`${path.basename(repoPath)}:${filePath}`);
      },
      onAstCreated: (repoPath, filePath) => {
        astCreations.push(`${path.basename(repoPath)}:${filePath}`);
      },
    };

    const first = await prepareRepositoryIndex(
      repositoryRow(firstPath, 1),
      true,
      instrumentation,
    );
    const second = await prepareRepositoryIndex(
      repositoryRow(secondPath, 2),
      true,
      instrumentation,
    );
    const expectedSources = ['srv/model.cds', 'src/FlowHandler.ts', 'src/helper.ts', 'src/wrapper.ts']
      .flatMap((filePath) => [
        `first-service:${filePath}`,
        `second-service:${filePath}`,
      ])
      .sort();

    expect(sourceReads.sort()).toEqual(expectedSources);
    expect(astCreations.sort()).toEqual(
      expectedSources.filter((entry) => entry.endsWith('.ts')),
    );
    expect(first.parsed?.bindings.some((binding) => binding.variableName === 'client')).toBe(true);
    expect(first.parsed?.calls.some((call) => call.operationPathExpr === '/collect')).toBe(true);
    expect(second.parsed?.registrations.some((registration) =>
      registration.className === 'FlowHandler')).toBe(true);
  });

  it('preserves last-good facts when a source snapshot cannot be completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-source-failure-'));
    await writeFixtureFile(root, 'stable-service/.git-fixture');
    await writeFixtureFile(root, 'stable-service/package.json', JSON.stringify({
      name: '@neutral/stable-service',
      version: '1.0.0',
    }));
    await writeFixtureFile(
      root,
      'stable-service/src/a.ts',
      'export function stableHelper(): string { return "stable"; }',
    );
    await writeFixtureFile(
      root,
      'stable-service/src/z.ts',
      'export function retainedHelper(): string { return "retained"; }',
    );
    const { db } = await prepareWorkspace(root);
    const repo = repoByName(db, 'stable-service');
    expect(repo).toBeDefined();
    if (!repo) throw new Error('Expected stable-service repository fixture');
    const symbolNames = (): string[] => db
      .prepare('SELECT name localName FROM symbols WHERE repo_id=? ORDER BY name')
      .all(repo.id)
      .map((row) => String(row.localName));
    const publishedNames = symbolNames();
    await writeFixtureFile(
      root,
      'stable-service/src/a.ts',
      'export function renamedHelper(): string { return "renamed"; }',
    );
    let removedLaterSource = false;
    const instrumentation: SourceContextInstrumentation = {
      onSourceRead: async (_repoPath, filePath) => {
        if (filePath !== 'src/a.ts' || removedLaterSource) return;
        removedLaterSource = true;
        await unlink(path.join(repo.absolute_path, 'src/z.ts'));
      },
    };

    const result = await indexRepository(db, repo, true, instrumentation);

    expect(result).toMatchObject({ diagnosticCount: 1, skipped: false });
    expect(symbolNames()).toEqual(publishedNames);
    expect(db.prepare(
      "SELECT code FROM diagnostics WHERE repo_id=? AND code='source_read_failed'",
    ).get(repo.id)).toEqual({ code: 'source_read_failed' });
    db.close();
  });

  it('does not publish an empty snapshot when repository discovery fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-source-root-failure-'));
    await writeFixtureFile(root, 'stable-service/.git-fixture');
    await writeFixtureFile(root, 'stable-service/package.json', JSON.stringify({
      name: '@neutral/stable-service',
      version: '1.0.0',
    }));
    await writeFixtureFile(
      root,
      'stable-service/src/stable.ts',
      'export function stableHelper(): string { return "stable"; }',
    );
    const { db } = await prepareWorkspace(root);
    const repo = repoByName(db, 'stable-service');
    expect(repo).toBeDefined();
    if (!repo) throw new Error('Expected stable-service repository fixture');
    const before = db.prepare(`SELECT name FROM symbols
      WHERE repo_id=? ORDER BY name`).all(repo.id);
    await rename(repo.absolute_path, `${repo.absolute_path}-unavailable`);

    const result = await indexRepository(db, repo, true);

    expect(result).toMatchObject({ diagnosticCount: 1, skipped: false });
    expect(db.prepare(`SELECT name FROM symbols
      WHERE repo_id=? ORDER BY name`).all(repo.id)).toEqual(before);
    expect(db.prepare(`SELECT code FROM diagnostics
      WHERE repo_id=? AND code='source_read_failed'`).get(repo.id))
      .toEqual({ code: 'source_read_failed' });
    db.close();
  });

  it('preserves package-derived facts when package metadata becomes invalid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-package-failure-'));
    await writeFixtureFile(root, 'stable-service/.git-fixture');
    await writeFixtureFile(root, 'stable-service/package.json', JSON.stringify({
      name: '@neutral/stable-service',
      version: '1.0.0',
      cds: { requires: {
        worker: { credentials: { path: '/WorkerService' } },
      } },
    }));
    await writeFixtureFile(
      root,
      'stable-service/src/stable.ts',
      'export function stableHelper(): string { return "stable"; }',
    );
    const { db } = await prepareWorkspace(root);
    const repo = repoByName(db, 'stable-service');
    expect(repo).toBeDefined();
    if (!repo) throw new Error('Expected stable-service repository fixture');
    const before = db.prepare(`SELECT alias,service_path servicePath
      FROM cds_requires WHERE repo_id=? ORDER BY alias`).all(repo.id);
    await writeFixtureFile(root, 'stable-service/package.json', '{ invalid json');

    const result = await indexRepository(db, repo, true);

    expect(result).toMatchObject({ diagnosticCount: 1, skipped: false });
    expect(db.prepare(`SELECT alias,service_path servicePath
      FROM cds_requires WHERE repo_id=? ORDER BY alias`).all(repo.id)).toEqual(before);
    expect(db.prepare(`SELECT code FROM diagnostics
      WHERE repo_id=? AND code='source_read_failed'`).get(repo.id))
      .toEqual({ code: 'source_read_failed' });
    db.close();
  });

  it('hashes and parses one immutable package metadata snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-package-snapshot-'));
    await writeFixtureFile(root, 'stable-service/.git-fixture');
    const packageFile = 'stable-service/package.json';
    const packageJson = (servicePath: string): string => JSON.stringify({
      name: '@neutral/stable-service',
      version: '1.0.0',
      cds: { requires: {
        worker: { credentials: { path: servicePath } },
      } },
    });
    await writeFixtureFile(root, packageFile, packageJson('/InitialService'));
    await writeFixtureFile(
      root,
      'stable-service/src/stable.ts',
      'export function stableHelper(): string { return "stable"; }',
    );
    const { db } = await prepareWorkspace(root);
    const initial = repoByName(db, 'stable-service');
    expect(initial).toBeDefined();
    if (!initial) throw new Error('Expected stable-service repository fixture');
    let changed = false;
    await indexRepository(db, initial, true, {
      onSourceRead: async () => {
        if (changed) return;
        changed = true;
        await writeFixtureFile(root, packageFile, packageJson('/ChangedService'));
      },
    });
    const afterFirst = repoByName(db, 'stable-service');
    expect(afterFirst).toBeDefined();
    if (!afterFirst) throw new Error('Expected refreshed repository row');

    const second = await indexRepository(db, afterFirst, false);

    expect(second.skipped).toBe(false);
    expect(db.prepare(`SELECT service_path servicePath FROM cds_requires
      WHERE repo_id=? AND alias='worker'`).get(initial.id))
      .toEqual({ servicePath: '/ChangedService' });
    db.close();
  });
});
