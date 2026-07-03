import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import { discoverRepositories } from '../../src/discovery/discover-repositories.js';
import {
  upsertRepository,
  upsertWorkspace,
} from '../../src/db/repositories.js';
import { parsePackageJson } from '../../src/parsers/package-json-parser.js';
import { classifyRepository } from '../../src/discovery/classify-repository.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace, trace } from '../../src/index.js';
const fixture = path.resolve('tests/fixtures/cap-workspace');

async function writeFixtureFile(root: string, relative: string, content = ''): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function prepareWorkspace(root: string): Promise<{ db: ReturnType<typeof openDatabase>; workspaceId: number }> {
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
async function createCrossPackageFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model/.git-fixture');
  await writeFixtureFile(root, 'model/package.json', JSON.stringify({ name: '@neutral/model', version: '1.0.0' }));
  await writeFixtureFile(root, 'model/db/service.cds', 'service PublicService { action ping(); }');
  await writeFixtureFile(root, 'handler/.git-fixture');
  await writeFixtureFile(root, 'handler/package.json', JSON.stringify({ name: '@neutral/handler', version: '1.0.0' }));
  await writeFixtureFile(root, 'handler/src/PingHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class PingHandler {\n  @Action('ping')\n  ping(): void {}\n}\n");
  await writeFixtureFile(root, 'app/.git-fixture');
  await writeFixtureFile(root, 'app/package.json', JSON.stringify({ name: '@neutral/app', version: '1.0.0', dependencies: { '@neutral/model': '1.0.0', '@neutral/handler': '1.0.0' } }));
  await writeFixtureFile(root, 'app/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { PingHandler } from '@neutral/handler';\nexport function register(): void {\n  createCombinedHandler({ handler: [PingHandler] });\n}\n");
}
async function createDuplicateServiceFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'service-a/.git-fixture');
  await writeFixtureFile(root, 'service-a/package.json', JSON.stringify({ name: '@neutral/service-a', version: '1.0.0' }));
  await writeFixtureFile(root, 'service-a/srv/service-a.cds', 'service AService { action ping(); }');
  await writeFixtureFile(root, 'service-a/src/AHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class AHandler {\n  @Action('ping')\n  ping(): void {}\n}\n");
  await writeFixtureFile(root, 'service-a/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { AHandler } from './AHandler.js';\ncreateCombinedHandler({ handler: [AHandler] });\n");
  await writeFixtureFile(root, 'service-b/.git-fixture');
  await writeFixtureFile(root, 'service-b/package.json', JSON.stringify({ name: '@neutral/service-b', version: '1.0.0' }));
  await writeFixtureFile(root, 'service-b/srv/service-b.cds', 'service BService { action ping(); }');
  await writeFixtureFile(root, 'service-b/src/BHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class BHandler {\n  @Action('ping')\n  ping(): void {}\n}\n");
  await writeFixtureFile(root, 'service-b/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { BHandler } from './BHandler.js';\ncreateCombinedHandler({ handler: [BHandler] });\n");
}

async function createModelOnlyHelperFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model-core/.git-fixture');
  await writeFixtureFile(root, 'model-core/package.json', JSON.stringify({ name: '@neutral/model-core', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-core/db/catalog.cds', 'service CatalogService { action refresh(); }');
  await writeFixtureFile(root, 'helper-catalog/.git-fixture');
  await writeFixtureFile(root, 'helper-catalog/package.json', JSON.stringify({ name: '@neutral/helper-catalog', version: '1.0.0' }));
  await writeFixtureFile(root, 'helper-catalog/src/RefreshCatalogHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class RefreshCatalogHandler {\n  @Action('refresh')\n  refresh(): void {}\n}\n");
  await writeFixtureFile(root, 'helper-catalog/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { RefreshCatalogHandler } from './RefreshCatalogHandler.js';\ncreateCombinedHandler({ handler: [RefreshCatalogHandler] });\n");
}
async function createMultipleHelperFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model-core/.git-fixture');
  await writeFixtureFile(root, 'model-core/package.json', JSON.stringify({ name: '@neutral/model-core', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-core/db/catalog.cds', 'service CatalogService { action refresh(); }');
  for (const name of ['one', 'two']) {
    const cls = name === 'one' ? 'RefreshOneHandler' : 'RefreshTwoHandler';
    await writeFixtureFile(root, `helper-${name}/.git-fixture`);
    await writeFixtureFile(root, `helper-${name}/package.json`, JSON.stringify({ name: `@neutral/helper-${name}`, version: '1.0.0' }));
    await writeFixtureFile(root, `helper-${name}/src/${cls}.ts`, `import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class ${cls} {\n  @Action('refresh')\n  refresh(): void {}\n}\n`);
    await writeFixtureFile(root, `helper-${name}/src/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';\nimport { ${cls} } from './${cls}.js';\ncreateCombinedHandler({ handler: [${cls}] });\n`);
  }
}
async function createContradictionFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model-core/.git-fixture');
  await writeFixtureFile(root, 'model-core/package.json', JSON.stringify({ name: '@neutral/model-core', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-core/db/catalog.cds', 'service CatalogService { action refresh(); }');
  await writeFixtureFile(root, 'app-local/.git-fixture');
  await writeFixtureFile(root, 'app-local/package.json', JSON.stringify({ name: '@neutral/app-local', version: '1.0.0' }));
  await writeFixtureFile(root, 'app-local/srv/different.cds', 'service DifferentService { action refresh(); }');
  await writeFixtureFile(root, 'app-local/src/RefreshHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class RefreshHandler {\n  @Action('refresh')\n  refresh(): void {}\n}\n");
  await writeFixtureFile(root, 'app-local/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { RefreshHandler } from './RefreshHandler.js';\ncreateCombinedHandler({ handler: [RefreshHandler] });\n");
}

describe('linker and trace engine', () => {

  it('links cross-package application registrations with string graph ids and dependency evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-cross-'));
    await createCrossPackageFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationResolvedCount).toBe(1);
    expect(linked.implementationAmbiguousCount).toBe(0);
    const edge = db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'").get() as { status: string; evidence_json: string };
    expect(edge.status).toBe('resolved');
    const evidence = JSON.parse(edge.evidence_json) as { candidates: Array<{ className: string; signals: { appDependsOnModel: boolean; appDependsOnHandler: boolean }; acceptedReasons: string[]; applicationPackage: { packageName: string }; handlerPackage: { packageName: string }; modelPackage: { packageName: string } }> };
    expect(evidence.candidates).toHaveLength(1);
    expect(evidence.candidates[0]?.className).toBe('PingHandler');
    expect(evidence.candidates[0]?.signals.appDependsOnModel).toBe(true);
    expect(evidence.candidates[0]?.signals.appDependsOnHandler).toBe(true);
    expect(evidence.candidates[0]?.acceptedReasons).toContain('registration package depends on model package');
    expect(evidence.candidates[0]?.applicationPackage.packageName).toBe('@neutral/app');
    expect(evidence.candidates[0]?.handlerPackage.packageName).toBe('@neutral/handler');
    expect(evidence.candidates[0]?.modelPackage.packageName).toBe('@neutral/model');
    db.close();
  });

  it('uses service ownership context for duplicate operation names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-duplicate-'));
    await createDuplicateServiceFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationResolvedCount).toBe(2);
    expect(linked.implementationAmbiguousCount).toBe(0);
    const edges = db.prepare(`SELECT s.service_path servicePath,hc.class_name className,e.status status,e.evidence_json evidenceJson
      FROM graph_edges e
      JOIN cds_operations o ON o.id=CAST(e.from_id AS INTEGER)
      JOIN cds_services s ON s.id=o.service_id
      JOIN handler_methods hm ON hm.id=CAST(e.to_id AS INTEGER)
      JOIN handler_classes hc ON hc.id=hm.handler_class_id
      WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'
      ORDER BY s.service_path`).all() as Array<{ servicePath: string; className: string; status: string; evidenceJson: string }>;
    expect(edges).toEqual([
      expect.objectContaining({ servicePath: '/AService', className: 'AHandler', status: 'resolved' }),
      expect.objectContaining({ servicePath: '/BService', className: 'BHandler', status: 'resolved' }),
    ]);
    for (const edge of edges) {
      const evidence = JSON.parse(edge.evidenceJson) as { servicePath: string; candidates: Array<{ signals: { localServicePathMatch: boolean }; acceptedReasons: string[] }> };
      expect(evidence.servicePath).toBe(edge.servicePath);
      expect(evidence.candidates[0]?.signals.localServicePathMatch).toBe(true);
      expect(evidence.candidates[0]?.acceptedReasons).toContain('registration package contains exact local service path');
    }
    db.close();
  });


  it('resolves a unique model-only helper implementation and traces the terminal handler', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-helper-'));
    await createModelOnlyHelperFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationResolvedCount).toBe(1);
    expect(linked.implementationUnresolvedCount).toBe(0);
    const edge = db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'").get() as { status: string; evidence_json: string };
    expect(edge.status).toBe('resolved');
    const evidence = JSON.parse(edge.evidence_json) as { candidates: Array<{ acceptedReasons: string[]; className: string }> };
    expect(evidence.candidates[0]?.className).toBe('RefreshCatalogHandler');
    expect(evidence.candidates[0]?.acceptedReasons).toContain('unique registered helper implementation for model-only operation');
    const result = trace(db, { servicePath: '/CatalogService', operation: 'refresh' }, { depth: 5 });
    expect(result.edges.map((edge) => edge.type)).toContain('operation_implemented_by_handler');
    expect(result.nodes.some((node) => node.kind === 'handler_method' && node.className === 'RefreshCatalogHandler')).toBe(true);
    db.close();
  });

  it('keeps multiple helper implementations ambiguous', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-helpers-'));
    await createMultipleHelperFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationResolvedCount).toBe(0);
    expect(linked.implementationAmbiguousCount).toBe(1);
    const edge = db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'").get() as { status: string; unresolved_reason: string; evidence_json: string };
    expect(edge.status).toBe('ambiguous');
    expect(edge.unresolved_reason).toContain('Ambiguous');
    const evidence = JSON.parse(edge.evidence_json) as { candidates: unknown[] };
    expect(evidence.candidates).toHaveLength(2);
    db.close();
  });

  it('persists unresolved evidence for local service-path contradictions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-contradiction-'));
    await createContradictionFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationUnresolvedCount).toBe(1);
    const edge = db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status='unresolved'").get() as { unresolved_reason: string; evidence_json: string };
    expect(edge.unresolved_reason).toBe('No implementation candidate passed policy');
    const evidence = JSON.parse(edge.evidence_json) as { candidates: Array<{ rejectedReasons: string[] }> };
    expect(evidence.candidates[0]?.rejectedReasons.join(' ')).toContain('local services but none match /CatalogService');
    db.close();
  });

  it('links cross repository calls and traces fixture flow', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'service-flow-'));
    const db = openDatabase(path.join(dir, 'graph.db'));
    const workspaceId = upsertWorkspace(
      db,
      fixture,
      path.join(dir, 'graph.db'),
    );
    for (const repo of await discoverRepositories(fixture, [
      'node_modules',
      '.git',
    ])) {
      const pkg = await parsePackageJson(repo.absolutePath);
      upsertRepository(db, workspaceId, {
        ...repo,
        packageName: pkg.packageName,
        packageVersion: pkg.packageVersion,
        dependencies: pkg.dependencies,
        kind: await classifyRepository(repo.absolutePath, pkg),
      });
    }
    const indexed = await indexWorkspace(db, workspaceId, { force: true });
    expect(indexed.repoCount).toBe(5);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.edgeCount).toBeGreaterThan(0);
    expect(linked.edgeCount).toBe(
      linked.resolvedCount +
        linked.unresolvedCount +
        linked.ambiguousCount +
        linked.dynamicCount +
        linked.terminalCount +
        linked.dependencyResolvedCount +
        linked.dependencyAmbiguousCount +
        linked.implementationResolvedCount +
        linked.implementationAmbiguousCount +
        linked.implementationUnresolvedCount,
    );
    expect(linked.dependencyResolvedCount).toBeGreaterThan(0);
    const edgeTypes = db
      .prepare('SELECT edge_type edgeType FROM graph_edges ORDER BY id')
      .all() as Array<{ edgeType: string }>;
    expect(edgeTypes.map((edge) => edge.edgeType)).toContain(
      'EVENT_CONSUMED_BY_HANDLER',
    );
    const result = trace(
      db,
      { repo: 'facade-service', operation: 'doWork' },
      { depth: 20, includeDb: true, includeAsync: true, includeExternal: true },
    );
    expect(result.edges.map((e) => e.type)).toContain('remote_action');
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.some((e) => e.from.includes('EntryHandler.ts'))).toBe(
      true,
    );

    const handlerResult = trace(
      db,
      { repo: 'rules-service', operation: 'checkPayload' },
      {
        depth: 20,
        vars: { objectType: 'Thing', objectCode: 'xx' },
        includeDb: true,
        includeAsync: true,
        includeExternal: true,
      },
    );
    expect(
      handlerResult.edges.some((e) => e.from.includes('RulesHandler.ts')),
    ).toBe(true);
    expect(handlerResult.edges.map((e) => e.to)).toContain(
      '/ThingProcessService/getPaths',
    );

    const serviceOnlyResult = trace(
      db,
      { servicePath: '/RulesService' },
      { depth: 20, includeAsync: true },
    );
    expect(serviceOnlyResult.edges).toHaveLength(0);
    expect(serviceOnlyResult.diagnostics[0]?.code).toBe('trace_start_not_found');
    expect(String(serviceOnlyResult.diagnostics[0]?.message)).toContain('Service-only trace requires');

    const missingOperationResult = trace(
      db,
      { repo: 'rules-service', operation: 'notRegistered' },
      { depth: 20, includeAsync: true },
    );
    expect(missingOperationResult.edges).toHaveLength(0);
    expect(missingOperationResult.diagnostics[0]?.code).toBe(
      'trace_start_not_found',
    );
    db.close();
  });
});
