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
import { renderTraceTable } from '../../src/output/table-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
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
      { repo: 'facade-service', handler: 'EntryHandler' },
      { depth: 20, includeDb: true, includeAsync: true, includeExternal: true },
    );
    expect(result.edges.map((e) => e.type)).toContain('remote_action');
    expect(result.nodes.length).toBeGreaterThan(0);

    const handlerResult = trace(
      db,
      { repo: 'rules-service', handler: 'RulesHandler' },
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

async function createLocalServiceTraceFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'runtime-service/.git-fixture');
  await writeFixtureFile(root, 'runtime-service/package.json', JSON.stringify({ name: '@neutral/runtime-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'runtime-service/srv/runtime-service.cds', 'namespace fixture.runtime; service RuntimeService { function getConfiguration() returns String; action rejectConfiguration(); }');
  await writeFixtureFile(root, 'runtime-service/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { FacadeEntryHandler } from './FacadeEntryHandler.js';\nimport { ActionHandlerA } from './ActionHandlerA.js';\nimport { ActionHandlerB } from './ActionHandlerB.js';\ncreateCombinedHandler({ handler: [FacadeEntryHandler, ActionHandlerA, ActionHandlerB] });\n");
  await writeFixtureFile(root, 'runtime-service/srv/helpers.ts', "import cds from '@sap/cds';\nconst loadTemplate = async (): Promise<void> => { await cds.run(SELECT.from(TemplateRules)); };\nconst cacheHelper = {\n  getConfiguration: async (): Promise<void> => { await cds.run(SELECT.from(ConfigurationRules)); },\n  getRules: async (): Promise<void> => { await cds.run(SELECT.from(ValidationRules)); }\n};\nexport { loadTemplate, cacheHelper };\n");
  await writeFixtureFile(root, 'runtime-service/srv/FacadeEntryHandler.ts', "import cds from '@sap/cds';\nimport { Handler, Action } from 'cds-routing-handlers';\nimport { loadTemplate, cacheHelper } from './helpers.js';\n@Handler()\nexport class FacadeEntryHandler {\n  @Action('start')\n  public async start(): Promise<void> {\n    const root = cds.services[\"fixture.runtime.RuntimeService\"];\n    const svc = root;\n    await svc.getConfiguration({});\n    await cds.services.RuntimeService.getConfiguration({});\n    cds.services.db.entities('Books');\n    await loadTemplate();\n    await cacheHelper.getConfiguration();\n  }\n}\n");
  await writeFixtureFile(root, 'runtime-service/srv/ActionHandlerA.ts', "import cds from '@sap/cds';\nimport { Handler, Func } from 'cds-routing-handlers';\n@Handler()\nexport class ActionHandlerA {\n  @Func(RuntimeService.FuncGetConfiguration.name)\n  public async getConfiguration(): Promise<void> { await cds.run(SELECT.from(ConfigurationRules)); }\n}\n");
  await writeFixtureFile(root, 'runtime-service/srv/ActionHandlerB.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class ActionHandlerB {\n  @Action(RuntimeService.ActionRejectConfiguration.name)\n  public async getConfiguration(): Promise<void> {}\n}\n");
  await writeFixtureFile(root, 'facade-service/.git-fixture');
  await writeFixtureFile(root, 'facade-service/package.json', JSON.stringify({ name: '@neutral/facade-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'facade-service/srv/facade-service.cds', 'service RuntimeService { function getConfiguration() returns String; }');
}

describe('0.1.12 local service and symbol trace regressions', () => {
  it('resolves local CAP service calls, decorator collisions, export-list helpers, and object helpers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-local-trace-'));
    await createLocalServiceTraceFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.resolvedCount).toBeGreaterThanOrEqual(2);
    const localEdges = db.prepare("SELECT e.* FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call'").all() as Array<{ status: string; to_id: string; evidence_json: string }>;
    expect(localEdges.length).toBeGreaterThanOrEqual(2);
    expect(localEdges.every((edge) => edge.status === 'resolved')).toBe(true);
    const localEvidence = localEdges.map((edge) => JSON.parse(edge.evidence_json) as { resolutionReasons?: string[] });
    expect(localEvidence.some((evidence) => evidence.resolutionReasons?.includes('explicit_local_service_call') === true)).toBe(true);
    const impl = db.prepare("SELECT e.* FROM graph_edges e JOIN cds_operations o ON o.id=CAST(e.from_id AS INTEGER) WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND o.operation_name='getConfiguration'").get() as { status: string; to_id: string; evidence_json: string };
    expect(impl.status).toBe('resolved');
    const implEvidence = JSON.parse(impl.evidence_json) as { candidates: Array<{ className: string; accepted: boolean; rejectedReasons: string[]; registrations: unknown[] }> };
    expect(implEvidence.candidates.find((candidate) => candidate.className === 'ActionHandlerA')?.accepted).toBe(true);
    expect(implEvidence.candidates.find((candidate) => candidate.className === 'ActionHandlerB')?.rejectedReasons).toContain('method_name_matches_but_decorator_targets_different_operation');
    const symbolCalls = db.prepare("SELECT status,callee_symbol_id calleeSymbolId,unresolved_reason unresolvedReason FROM symbol_calls WHERE callee_symbol_id IS NOT NULL").all() as Array<{ status: string; calleeSymbolId: number; unresolvedReason?: string | null }>;
    expect(symbolCalls.length).toBeGreaterThan(0);
    expect(symbolCalls.every((call) => call.status === 'resolved' && call.unresolvedReason === null)).toBe(true);
    const result = trace(db, { repo: 'runtime-service', handler: 'FacadeEntryHandler' }, { depth: 10, includeDb: true });
    expect(result.edges.some((edge) => edge.type === 'local_service_call' && !edge.unresolvedReason)).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'operation_implemented_by_handler' && String(edge.to).includes('ActionHandlerA.getConfiguration'))).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'local_db_query' && String(edge.to).includes('ConfigurationRules'))).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'local_db_query' && String(edge.to).includes('TemplateRules'))).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'symbol' && String(node.label).includes('cacheHelper.getConfiguration') && node.sourceFile === 'srv/helpers.ts')).toBe(true);
    expect(result.edges.filter((edge) => edge.type === 'local_symbol_call').every((edge) => !edge.unresolvedReason)).toBe(true);
    db.close();
  });
});

async function createLocalServiceModelFallbackFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'model-package/.git-fixture');
  await writeFixtureFile(root, 'model-package/package.json', JSON.stringify({ name: 'model-package', version: '1.0.0' }));
  await writeFixtureFile(root, 'model-package/db/business-process-service.cds', 'service BusinessProcessService { action loadRemoteData(id: String) returns String; action syncData(id: String) returns String; }');
  for (const suffix of ['a', 'b']) {
    const repo = `process-helper-${suffix}`;
    await writeFixtureFile(root, `${repo}/.git-fixture`);
    await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({ name: repo, version: '1.0.0' }));
    await writeFixtureFile(root, `${repo}/src/LoadRemoteDataHandler.ts`, `import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class LoadRemoteDataHandler {
  @Action('loadRemoteData')
  async loadRemoteData(): Promise<string> {
    return '${suffix}';
  }
}
`);
    await writeFixtureFile(root, `${repo}/src/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';
import { LoadRemoteDataHandler } from './LoadRemoteDataHandler.js';
createCombinedHandler({ handler: [LoadRemoteDataHandler] });
`);
  }
  await writeFixtureFile(root, 'process-helper-a/src/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(): Promise<void> {
    const service = cds.services.BusinessProcessService;
    await service.loadRemoteData('42');
  }
}
`);
}



  it('persists symbol-call evidence as objects and resolves exported static/proxy helper calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-symbol-evidence-'));
    await writeFixtureFile(root, 'app/.git-fixture');
    await writeFixtureFile(root, 'app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    await writeFixtureFile(root, 'app/srv/service.cds', 'service AppService { action runEntry(); }');
    await writeFixtureFile(root, 'app/srv/run-heavy-check.ts', `import cds from '@sap/cds';
export async function runHeavyCheck(): Promise<void> { await cds.run(SELECT.from(HeavyChecks)); }
`);
    await writeFixtureFile(root, 'app/srv/work-map.ts', `import { runHeavyCheck } from './run-heavy-check';
export const workerFunctions = { runHeavyCheck };
export class DomainWorker { static instance(): unknown { return DomainWorker.singleton.pool; } }
`);
    await writeFixtureFile(root, 'app/srv/EntryHandler.ts', `import { Handler, Action } from 'cds-routing-handlers';
import { DomainWorker } from './work-map';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(): Promise<void> {
    const worker = DomainWorker.instance();
    await worker.runHeavyCheck();
  }
}
`);
    await writeFixtureFile(root, 'app/srv/server.ts', `import { createCombinedHandler } from 'cds-routing-handlers';
import { EntryHandler } from './EntryHandler.js';
createCombinedHandler({ handler: [EntryHandler] });
`);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const nonObject = db.prepare("SELECT COUNT(*) count FROM symbol_calls WHERE json_type(evidence_json) != 'object'").get() as { count: number };
    expect(nonObject.count).toBe(0);
    const evidenceRows = db.prepare("SELECT callee_expression expression,status,evidence_json evidenceJson FROM symbol_calls ORDER BY callee_expression").all() as Array<{ expression: string; status: string; evidenceJson: string }>;
    expect(evidenceRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ expression: 'DomainWorker.instance', status: 'resolved' }),
      expect.objectContaining({ expression: 'worker.runHeavyCheck', status: 'resolved' }),
    ]));
    const proxyEvidence = JSON.parse(evidenceRows.find((row) => row.expression === 'worker.runHeavyCheck')?.evidenceJson ?? '{}') as { relation?: string; caller?: string; targetName?: string };
    expect(proxyEvidence).toMatchObject({ relation: 'relative_import_proxy_member', caller: 'EntryHandler.runEntry', targetName: 'runHeavyCheck', proxyVariableName: 'worker', factoryImportSource: './work-map' });
    const result = trace(db, { repo: 'app', handler: 'EntryHandler' }, { depth: 8, includeDb: true });
    expect(result.edges.some((edge) => edge.type === 'local_symbol_call' && String(edge.to).includes('DomainWorker.instance'))).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'local_symbol_call' && String(edge.to).includes('runHeavyCheck'))).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'local_db_query' && String(edge.to).includes('HeavyChecks'))).toBe(true);
    db.close();
  });

describe('local service model fallback', () => {
  it('resolves model-package local service calls using caller implementation context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-local-model-'));
    await createLocalServiceModelFallbackFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const indexedDiagnostics = db.prepare('SELECT * FROM diagnostics').all();
    expect(indexedDiagnostics).toHaveLength(0);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.ambiguousCount).toBe(0);
    const edge = db.prepare("SELECT e.* FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.edge_type='LOCAL_CALL_RESOLVES_TO_OPERATION' AND c.source_file='src/EntryHandler.ts'").get() as { status: string; evidence_json: string };
    expect(edge.status).toBe('resolved');
    const evidence = JSON.parse(edge.evidence_json) as { resolutionReasons: string[]; candidates: Array<{ repoName: string; operationName: string }> };
    expect(evidence.resolutionReasons).toEqual(expect.arrayContaining(['implementation_context_caller_ownership', 'ambiguous_implementation_candidate_repo_matches_caller']));
    expect(evidence.candidates[0]?.repoName).toBe('model-package');
    const result = trace(db, { repo: 'process-helper-a', handler: 'EntryHandler' }, { depth: 10, includeDb: true });
    expect(result.edges.some((item) => item.type === 'local_service_call' && item.to.includes('loadRemoteData'))).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'handler_method' && node.className === 'LoadRemoteDataHandler' && node.repoName === 'process-helper-a')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'handler_method' && node.className === 'LoadRemoteDataHandler' && node.repoName === 'process-helper-b')).toBe(false);
    db.close();
  });

  it('propagates outbound parser evidence into graph and trace evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-evidence-'));
    await writeFixtureFile(root, 'app-service/.git-fixture');
    await writeFixtureFile(root, 'app-service/package.json', JSON.stringify({ name: 'app-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'app-service/srv/service.cds', 'service AppService { action runEntry(); action refresh(); }');
    await writeFixtureFile(root, 'app-service/srv/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(): Promise<void> {
    const local = cds.services.AppService;
    await local.refresh();
    await cds.run(SELECT.from('Books'));
    await cds.emit('DomainEvent', {});
  }
}
`);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const rows = db.prepare("SELECT c.call_type callType,e.edge_type edgeType,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) ORDER BY c.call_type").all() as Array<{ callType: string; edgeType: string; evidenceJson: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const evidence = JSON.parse(row.evidenceJson) as { outboundEvidence?: { parser?: string; classifier?: string } };
      expect(evidence.outboundEvidence?.parser).toBe('typescript_ast');
    }
    expect(rows.find((row) => row.callType === 'local_service_call')?.evidenceJson).toContain('local_cap_service_call');
    const result = trace(db, { repo: 'app-service', handler: 'EntryHandler' }, { depth: 5, includeDb: true, includeAsync: true });
    expect(result.edges.some((edge) => edge.evidence.outboundEvidence && (edge.evidence.outboundEvidence as { parser?: string }).parser === 'typescript_ast')).toBe(true);
    db.close();
  });

  it('keeps terminal event edges from dynamic bindings graph-static while preserving binding evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-dynamic-event-'));
    await writeFixtureFile(root, 'app-service/.git-fixture');
    await writeFixtureFile(root, 'app-service/package.json', JSON.stringify({ name: 'app-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'app-service/srv/service.cds', 'service AppService { action runEntry(); }');
    await writeFixtureFile(root, 'app-service/srv/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(code: string): Promise<void> {
    const messaging = await cds.connect.to(\`bus_\${code}\`);
    await messaging.emit('DynamicEvent', {});
  }
}
`);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const edge = db.prepare("SELECT is_dynamic isDynamic,evidence_json evidenceJson FROM graph_edges WHERE edge_type='HANDLER_EMITS_EVENT'").get() as { isDynamic: number; evidenceJson: string };
    expect(edge.isDynamic).toBe(0);
    expect(JSON.parse(edge.evidenceJson)).toMatchObject({ bindingHasDynamicExpression: true });
    db.close();
  });

});

describe('0.1.14 audit regressions', () => {
  it('stores unknown DB query graph targets as semantic db entities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-db-semantic-'));
    await writeFixtureFile(root, 'app-service/.git-fixture');
    await writeFixtureFile(root, 'app-service/package.json', JSON.stringify({ name: 'app-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'app-service/srv/service.cds', 'service BusinessProcessService { action runEntry(); }');
    await writeFixtureFile(root, 'app-service/srv/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(entityName: string): Promise<void> {
    await cds.run(SELECT.from(this.model['Books']).where({ ID: 1 }));
    await cds.run(SELECT.from(this.model[entityName]).where({ ID: 2 }));
  }
}
`);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const edges = db.prepare("SELECT to_kind toKind,to_id toId,evidence_json evidenceJson FROM graph_edges WHERE edge_type='HANDLER_RUNS_DB_QUERY' ORDER BY id").all() as Array<{ toKind: string; toId: string; evidenceJson: string }>;
    expect(edges.map((edge) => `${edge.toKind}:${edge.toId}`)).toEqual(['db_entity:Books', 'db_entity:unknown']);
    expect(edges.every((edge) => !/^\d+$/.test(edge.toId))).toBe(true);
    const unknownEvidence = JSON.parse(edges[1]?.evidenceJson ?? '{}') as { callId?: number; parserWarning?: { message?: string } };
    expect(unknownEvidence.callId).toEqual(expect.any(Number));
    expect(unknownEvidence.parserWarning?.message).toBe('dynamic_entity_expression');
    const result = trace(db, { repo: 'app-service', handler: 'EntryHandler' }, { depth: 5, includeDb: true });
    expect(result.nodes.some((node) => node.kind === 'db_entity' && node.label === 'Entity: unknown')).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'local_db_query' && edge.to === 'Entity: unknown')).toBe(true);
    db.close();
  });

  it('terminalizes local service client transport methods without noisy unresolved operation edges', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-client-methods-'));
    await createLocalServiceModelFallbackFixture(root);
    await writeFixtureFile(root, 'process-helper-a/src/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class EntryHandler {
  @Action('runEntry')
  async runEntry(): Promise<void> {
    const client = cds.services.BusinessProcessService;
    await client.loadRemoteData('42');
    await client.send({ path: '/notify', method: 'POST' });
  }
}
`);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const rows = db.prepare("SELECT c.operation_path_expr path,e.edge_type edgeType,e.status status,e.unresolved_reason reason,e.evidence_json evidenceJson FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='local_service_call' ORDER BY c.operation_path_expr").all() as Array<{ path: string; edgeType: string; status: string; reason: string | null; evidenceJson: string }>;
    expect(rows.find((row) => row.path === '/loadRemoteData')?.status).toBe('resolved');
    const send = rows.find((row) => row.path === '/send');
    expect(send?.edgeType).toBe('HANDLER_CALLS_TRANSPORT_METHOD');
    expect(send?.status).toBe('terminal');
    expect(send?.reason).toBeNull();
    expect(JSON.parse(send?.evidenceJson ?? '{}')).toMatchObject({ classification: 'transport_client_method' });
    db.close();
  });

  it('propagates service binding context into helper class method parameters', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-class-context-'));
    await writeFixtureFile(root, 'facade-service/.git-fixture');
    await writeFixtureFile(root, 'facade-service/package.json', JSON.stringify({ name: '@neutral/facade-service', version: '1.0.0', dependencies: { '@neutral/model-service': '1.0.0' }, cds: { requires: { target_config_api: { kind: 'odata-v4', credentials: { destination: 'target-config-destination', path: '/TargetConfigService' } }, target_user_api: { kind: 'odata-v4', credentials: { destination: 'target-user-destination', path: '/TargetUserService' } } } } }));
    await writeFixtureFile(root, 'facade-service/srv/facade.cds', 'service FacadeService { action runFlow(); }');
    await writeFixtureFile(root, 'facade-service/srv/WorkflowHelper.ts', `
export class WorkflowHelper {
  async loadMetadata(configClient: { send(input: unknown): Promise<unknown> }, headers: Record<string, string>): Promise<void> {
    await configClient.send({ method: 'GET', path: '/loadMetadata', headers });
  }
  async checkPayload({ configClient, userClient, headers }: { configClient: { send(input: unknown): Promise<unknown> }; userClient: { send(input: unknown): Promise<unknown> }; headers: Record<string, string> }): Promise<void> {
    await configClient.send({ method: 'POST', path: '/checkPayload', headers });
    await userClient.send({ method: 'POST', path: '/checkAuthorization', headers });
  }
  async checkRenamed({ config: serviceClient }: { config: { send(input: unknown): Promise<unknown> } }): Promise<void> {
    await serviceClient.send({ method: 'POST', path: '/checkPayload' });
  }
}
`);
    await writeFixtureFile(root, 'facade-service/srv/FlowHandler.ts', `import { Handler, Action } from 'cds-routing-handlers';
import { WorkflowHelper } from './WorkflowHelper.js';
import { connectConfigClient, connectUserClient } from './connections.js';
@Handler()
export class FlowHandler {
  @Action('runFlow')
  public async runFlow(): Promise<void> {
    let configClient;
    let userClient;
    configClient = await connectConfigClient();
    userClient = await connectUserClient();
    const headers = { accept: 'application/json' };
    const helper = new WorkflowHelper();
    await helper.loadMetadata(configClient, headers);
    await helper.checkPayload({ configClient, userClient, headers });
    await helper.checkRenamed({ config: configClient });
  }
}
`);
    await writeFixtureFile(root, 'facade-service/srv/connections.ts', `import cds from '@sap/cds';
export async function connectConfigClient(): Promise<{ send(input: unknown): Promise<unknown> }> {
  return cds.connect.to('target_config_api');
}
export async function connectUserClient(): Promise<{ send(input: unknown): Promise<unknown> }> {
  return cds.connect.to('target_user_api');
}
`);
    await writeFixtureFile(root, 'facade-service/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { FlowHandler } from './FlowHandler.js';\ncreateCombinedHandler({ handler: [FlowHandler] });\n");
    await writeFixtureFile(root, 'model-service/.git-fixture');
    await writeFixtureFile(root, 'model-service/package.json', JSON.stringify({ name: '@neutral/model-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'model-service/srv/config.cds', `service TargetConfigService @(path: '/TargetConfigService') { action loadMetadata(); action checkPayload(); }
service TargetUserService @(path: '/TargetUserService') { action checkAuthorization(); }`);

    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'facade-service', servicePath: '/FacadeService', operation: 'runFlow' }, { depth: 10 });
    const contextualEdges = result.edges.filter((edge) => edge.evidence && typeof edge.evidence === 'object' && 'contextualServiceBindingSelected' in edge.evidence);
    expect(contextualEdges).toHaveLength(4);
    expect(contextualEdges.map((edge) => (edge.evidence as { contextualBinding?: { source?: string } }).contextualBinding?.source).sort()).toEqual([
      'local_symbol_argument',
      'local_symbol_destructured_object_argument',
      'local_symbol_destructured_object_argument',
      'local_symbol_destructured_object_argument',
    ]);
    for (const edge of contextualEdges) {
      expect(edge.evidence).toMatchObject({ contextualServiceBindingSelected: true, contextualServiceBindingAttempted: true });
    }
    expect(result.edges.some((edge) => String(edge.to).includes('/TargetConfigService/loadMetadata'))).toBe(true);
    expect(result.edges.some((edge) => String(edge.to).includes('/TargetConfigService/checkPayload'))).toBe(true);
    expect(result.edges.some((edge) => String(edge.to).includes('/TargetUserService/checkAuthorization'))).toBe(true);
    expect(renderTraceTable(result)).toContain('/TargetConfigService/loadMetadata');
    expect(renderMermaid(result)).toContain('/TargetUserService/checkAuthorization');
    db.close();
  });

  it('renders distinct unresolved operation candidate reasons', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-reasons-'));
    await writeFixtureFile(root, 'app-service/.git-fixture');
    await writeFixtureFile(root, 'app-service/package.json', JSON.stringify({ name: '@neutral/app-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'app-service/srv/app.cds', 'service AppService { action runFlow(); }');
    await writeFixtureFile(root, 'app-service/srv/FlowHandler.ts', `import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class FlowHandler {
  @Action('runFlow')
  public async runFlow(configClient: { send(input: unknown): Promise<unknown> }): Promise<void> {
    await configClient.send({ method: 'POST', path: '/missingOperation' });
    await configClient.send({ method: 'POST', path: '/sharedOperation' });
    await configClient.send({ method: 'POST', path: '/knownOperation' });
  }
}
`);
    await writeFixtureFile(root, 'model-a/.git-fixture');
    await writeFixtureFile(root, 'model-a/package.json', JSON.stringify({ name: '@neutral/model-a', version: '1.0.0' }));
    await writeFixtureFile(root, 'model-a/srv/a.cds', 'service AService { action sharedOperation(); action knownOperation(); }');
    await writeFixtureFile(root, 'model-b/.git-fixture');
    await writeFixtureFile(root, 'model-b/package.json', JSON.stringify({ name: '@neutral/model-b', version: '1.0.0' }));
    await writeFixtureFile(root, 'model-b/srv/b.cds', 'service BService { action sharedOperation(); }');
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const rows = db.prepare(`SELECT c.operation_path_expr operationPath,e.unresolved_reason unresolvedReason,e.evidence_json evidenceJson
      FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
      WHERE c.call_type='remote_action' ORDER BY c.operation_path_expr`).all() as Array<{ operationPath: string; unresolvedReason: string; evidenceJson: string }>;
    expect(rows.find((row) => row.operationPath === '/missingOperation')?.unresolvedReason).toBe('No indexed target operation matched');
    expect(rows.find((row) => row.operationPath === '/sharedOperation')?.unresolvedReason).toBe('Operation candidates found but no strong service signal is available');
    expect(rows.find((row) => row.operationPath === '/knownOperation')?.unresolvedReason).toBe('Operation candidates found but no strong service signal is available');
    for (const row of rows) expect(JSON.parse(row.evidenceJson)).toHaveProperty('candidateCount');
    db.close();
  });
});

describe('remote OData invocation and remote query semantics', () => {
  it('resolves normalized OData invocation paths and emits terminal remote query targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-remote-quality-'));
    await writeFixtureFile(root, 'facade-service/.git-fixture');
    await writeFixtureFile(root, 'facade-service/package.json', JSON.stringify({ name: '@neutral/facade-service', version: '1.0.0', dependencies: { '@neutral/model-service': '1.0.0', '@neutral/implementation-service': '1.0.0' } }));
    await writeFixtureFile(root, 'facade-service/srv/facade.cds', 'service FacadeService { action runFlow(); }');
    await writeFixtureFile(root, 'facade-service/srv/FlowHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class FlowHandler {
  @Action('runFlow')
  public async runFlow(id: string): Promise<void> {
    const remoteClient = await cds.connect.to('ConfigRemote', { path: '/ConfigService', destination: 'neutral-destination' });
    await remoteClient.send({ method: 'GET', path: "/readConfig(id='\${encodeURIComponent(id)}',version=0)" });
    await remoteClient.send({
      method: 'GET',
      path: \`/readConfig(id='\${encodeURIComponent(
        id
      )}',version=0)\`,
    });
    await remoteClient.send({
      method: 'GET',
      path: \`/readConfig(id='\${encodeURIComponent(id)}',version=\${
        id ? 1 : 0
      })\`,
    });
    await remoteClient.send({ method: 'GET', path: "/ConfigService.readConfig(id='123')" });
    await remoteClient.send({ method: 'GET', path: "/UserGroups?$select=id,name&$filter=contains(id,'A')" });
    await remoteClient.send({ method: 'GET', path: "/ProjectMappings?$filter=projectId eq '\${id}'&$skiptoken=\${id}" });
    await remoteClient.send({ method: 'GET', path: "/calculateScore(input='A')" });
    await remoteClient.send({ query: SELECT.one.from(RemoteEntity).where({ ID: id }) });
    await remoteClient.send({ method: 'POST', path: "/\${operationName}" });
  }
}
`);
    await writeFixtureFile(root, 'facade-service/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { FlowHandler } from './FlowHandler.js';\ncreateCombinedHandler({ handler: [FlowHandler] });\n");
    await writeFixtureFile(root, 'model-service/.git-fixture');
    await writeFixtureFile(root, 'model-service/package.json', JSON.stringify({ name: '@neutral/model-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'model-service/srv/config.cds', 'service ConfigService { function readConfig(id: String, version: Integer) returns String; function calculateScore(input: String) returns Integer; action dynamicOperation(); }');
    await writeFixtureFile(root, 'implementation-service/.git-fixture');
    await writeFixtureFile(root, 'implementation-service/package.json', JSON.stringify({ name: '@neutral/implementation-service', version: '1.0.0' }));
    await writeFixtureFile(root, 'implementation-service/src/ConfigHandler.ts', "import { Handler, Func } from 'cds-routing-handlers';\n@Handler()\nexport class ConfigHandler {\n  @Func('readConfig')\n  readConfig(): void {}\n}\n");
    await writeFixtureFile(root, 'implementation-service/src/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { ConfigHandler } from './ConfigHandler.js';\ncreateCombinedHandler({ handler: [ConfigHandler] });\n");

    const { db, workspaceId } = await prepareWorkspace(root);
    expect(db.prepare('SELECT COUNT(*) count FROM diagnostics').get()).toMatchObject({ count: 0 });
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.remoteResolvedCount).toBeGreaterThanOrEqual(1);
    expect(linked.terminalCount).toBeGreaterThanOrEqual(1);
    expect(linked.dynamicCount).toBeGreaterThanOrEqual(1);
    const remoteAction = db.prepare("SELECT e.evidence_json evidenceJson,e.status status FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.call_type='remote_action' AND c.operation_path_expr LIKE '/readConfig(%'").get() as { evidenceJson: string; status: string };
    expect(remoteAction.status).toBe('resolved');
    expect(JSON.parse(remoteAction.evidenceJson)).toMatchObject({ rawOperationPath: "/readConfig(id='${encodeURIComponent(id)}',version=0)", normalizedOperationPath: '/readConfig' });
    const multilineActions = db.prepare("SELECT e.evidence_json evidenceJson,e.status status,e.unresolved_reason unresolvedReason FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.call_type='remote_action' AND c.operation_path_expr LIKE '/readConfig(%' AND c.operation_path_expr LIKE '%' || char(10) || '%'").all() as Array<{ evidenceJson: string; status: string; unresolvedReason: string | null }>;
    expect(multilineActions).toHaveLength(2);
    for (const action of multilineActions) {
      expect(action.status).toBe('resolved');
      expect(action.unresolvedReason).toBeNull();
      const evidence = JSON.parse(action.evidenceJson) as { normalizedOperationPath?: string; invocationArgumentPlaceholderKeys?: string[]; resolutionReasons?: string[] };
      expect(evidence.normalizedOperationPath).toBe('/readConfig');
      expect(evidence.invocationArgumentPlaceholderKeys?.length).toBeGreaterThan(0);
      expect(evidence.resolutionReasons?.some((reason) => reason.startsWith('missing_variable:'))).not.toBe(true);
    }
    const namespaceAction = db.prepare("SELECT e.evidence_json evidenceJson,e.status status FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.call_type='remote_action' AND c.operation_path_expr LIKE '/ConfigService.readConfig(%'").get() as { evidenceJson: string; status: string };
    expect(namespaceAction.status).toBe('resolved');
    expect(JSON.parse(namespaceAction.evidenceJson)).toMatchObject({ normalizedOperationPath: '/ConfigService.readConfig', targetOperationPath: '/readConfig' });
    const remoteQuery = db.prepare("SELECT e.* FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.call_type='remote_query' AND c.operation_path_expr LIKE '/UserGroups%'").get() as { edge_type: string; status: string; to_id: string; unresolved_reason: string | null; evidence_json: string };
    expect(remoteQuery.edge_type).toBe('HANDLER_RUNS_REMOTE_QUERY');
    expect(remoteQuery.status).toBe('terminal');
    expect(remoteQuery.to_id).toContain('UserGroups');
    expect(remoteQuery.to_id).not.toMatch(/^\d+$/);
    expect(remoteQuery.unresolved_reason).toBeNull();
    expect(JSON.parse(remoteQuery.evidence_json)).toMatchObject({ queryEntity: 'UserGroups', remoteQueryTarget: 'Remote entity: /ConfigService:UserGroups', odataPathIntent: { kind: 'entity_query', hasQueryString: true, entitySegment: 'UserGroups' } });
    const placeholderQuery = db.prepare("SELECT e.status status,e.unresolved_reason unresolvedReason,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.operation_path_expr LIKE '/ProjectMappings%'").get() as { status: string; unresolvedReason: string | null; evidenceJson: string };
    expect(placeholderQuery).toMatchObject({ status: 'terminal', unresolvedReason: null });
    const placeholderEvidence = JSON.parse(placeholderQuery.evidenceJson) as { queryEntity?: string; queryPlaceholderKeys?: string[] };
    expect(placeholderEvidence.queryEntity).toBe('ProjectMappings');
    expect(placeholderEvidence.queryPlaceholderKeys).toEqual(['id']);
    const calculateScore = db.prepare("SELECT e.status status,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.operation_path_expr LIKE '/calculateScore%'").get() as { status: string; evidenceJson: string };
    expect(calculateScore.status).toBe('resolved');
    expect(JSON.parse(calculateScore.evidenceJson)).toMatchObject({ targetOperationPath: '/calculateScore' });
    const result = trace(db, { repo: 'facade-service', servicePath: '/FacadeService', operation: 'runFlow' }, { depth: 10, includeExternal: true });
    expect(result.edges.some((edge) => String(edge.to).includes('/ConfigService/readConfig'))).toBe(true);
    const persistedRemoteEdge = result.edges.find((edge) => edge.type === 'remote_action' && String(edge.to).includes('/ConfigService/readConfig'));
    expect(typeof persistedRemoteEdge?.evidence.outboundCallId).toBe('number');
    expect(typeof persistedRemoteEdge?.evidence.graphEdgeId).toBe('number');
    expect(persistedRemoteEdge?.evidence).toMatchObject({ callSite: { sourceFile: 'srv/FlowHandler.ts' }, linker: { status: 'resolved' }, persistedTarget: { kind: 'operation' }, contextualResolutionParticipated: true });
    expect(typeof (persistedRemoteEdge?.evidence.callSite as { sourceLine?: unknown } | undefined)?.sourceLine).toBe('number');
    expect(persistedRemoteEdge?.evidence.outboundEvidence).toMatchObject({ parser: 'typescript_ast' });
    expect(result.edges.some((edge) => edge.type === 'operation_implemented_by_handler' && String(edge.to).includes('ConfigHandler.readConfig'))).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'remote_query' && String(edge.to).includes('Remote entity: /ConfigService:UserGroups'))).toBe(true);
    const before = db.prepare("SELECT status FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.operation_path_expr='/${operationName}'").get() as { status: string };
    expect(before.status).toBe('dynamic');
    trace(db, { repo: 'facade-service', servicePath: '/FacadeService', operation: 'runFlow' }, { depth: 10, vars: { operationName: 'dynamicOperation' } });
    const after = db.prepare("SELECT status FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER) WHERE e.from_kind='call' AND c.operation_path_expr='/${operationName}'").get() as { status: string };
    expect(after.status).toBe('dynamic');
    db.close();
  });
});
