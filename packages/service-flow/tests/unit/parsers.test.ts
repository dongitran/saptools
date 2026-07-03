import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseExecutableSymbols } from '../../src/parsers/symbol-parser.js';
import {
  discoverRepositories,
  parseCdsFile,
  parseDecorators,
  parseGeneratedConstants,
  parseHandlerRegistrations,
  parseOutboundCalls,
  parsePackageJson,
  parseServiceBindings,
  redactText,
  applyVariables,
} from '../../src/index.js';
const fixture = path.resolve('tests/fixtures/cap-workspace');
describe('service-flow parsers', () => {
  it('discovers nested git repositories', async () => {
    const repos = await discoverRepositories(fixture, ['node_modules', '.git']);
    expect(repos.map((r) => r.name)).toContain('facade-service');
    expect(repos).toHaveLength(5);
  });
  it('continues scanning nested repositories when the selected root has a git marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-roots-'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(path.join(root, 'apps', 'nested', '.git'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'apps', 'nested', '.git', 'config'),
      '[core]\n',
    );
    const repos = await discoverRepositories(root, ['node_modules']);
    expect(repos.map((r) => r.relativePath)).toEqual(['.', 'apps/nested']);
  });
  it('ignores empty root git markers while scanning nested repositories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-empty-git-'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'apps', 'nested', '.git'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'apps', 'nested', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    const repos = await discoverRepositories(root, ['node_modules']);
    expect(repos.map((r) => r.relativePath)).toEqual(['apps/nested']);
  });
  it('parses package cds requires', async () => {
    const pkg = await parsePackageJson(path.join(fixture, 'facade-service'));
    expect(pkg.cdsRequires.map((r) => r.alias)).toContain('identity');
  });
  it('parses cds services and operations', async () => {
    const services = await parseCdsFile(
      path.join(fixture, 'facade-service'),
      'srv/facade-service.cds',
    );
    expect(services[0]?.servicePath).toBe('/FacadeService');
    expect(services[0]?.operations[0]?.operationName).toBe('doWork');
  });
  it('parses decorators and registrations', async () => {
    const handlers = await parseDecorators(
      path.join(fixture, 'facade-service'),
      'srv/functions/EntryHandler.ts',
    );
    expect(handlers[0]?.methods[0]?.decoratorValue).toBe('doWork');
    const regs = await parseHandlerRegistrations(
      path.join(fixture, 'facade-service'),
      'srv/server.ts',
    );
    expect(regs.length).toBeGreaterThan(0);
  });

  it('parses AST handler registration arrays, spreads, imports, defaults, aliases, and re-exports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-reg-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'local.ts'), `
      import { PingHandler as ImportedPingHandler } from './ping';
      import defaultHandlers from './default-handlers';
      import { publicHandlers } from './re-export';
      const functionHandlers = [ImportedPingHandler];
      const entityHandlers = [...defaultHandlers];
      const customArray = [...functionHandlers, ...entityHandlers, ...publicHandlers, ValidateHandler];
      createCombinedHandler({ handler: [DirectHandler] });
      createCombinedHandler({ handler: customArray });
    `);
    await fs.writeFile(path.join(root, 'srv', 'default-handlers.ts'), `
      const defaultList = [DefaultHandler];
      export default defaultList;
    `);
    await fs.writeFile(path.join(root, 'srv', 'source.ts'), `
      export const exportedArray = [ReExportedHandler];
    `);
    await fs.writeFile(path.join(root, 'srv', 're-export.ts'), `
      export { exportedArray as publicHandlers } from './source';
    `);
    const regs = await parseHandlerRegistrations(root, 'srv/local.ts');
    expect(regs.map((reg) => reg.className)).toEqual(expect.arrayContaining(['DirectHandler', 'ImportedPingHandler', 'DefaultHandler', 'ReExportedHandler', 'ValidateHandler']));
    expect(regs.find((reg) => reg.className === 'ImportedPingHandler')?.importSource).toBe('./ping#PingHandler');
    expect(regs.every((reg) => reg.registrationFile === 'srv/local.ts')).toBe(true);
    expect(regs.every((reg) => typeof reg.registrationLine === 'number')).toBe(true);
  });

  it('parses service bindings and outbound calls', async () => {
    const root = path.join(fixture, 'rules-service');
    const bindings = await parseServiceBindings(
      root,
      'srv/functions/RulesHandler.ts',
    );
    expect(bindings.some((b) => b.isDynamic)).toBe(true);
    const calls = await parseOutboundCalls(
      root,
      'srv/functions/RulesHandler.ts',
    );
    expect(calls.map((c) => c.callType)).toContain('remote_action');
  });

  it('propagates imported helper service bindings only to caller locals', async () => {
    const root = path.join(fixture, 'facade-service');
    const bindings = await parseServiceBindings(
      root,
      'srv/functions/EntryHandler.ts',
    );
    expect(
      bindings.some((b) => b.variableName === 'rules' && b.alias === 'rules'),
    ).toBe(true);
    const identity = bindings.find((b) => b.variableName === 'identity');
    expect(identity?.helperChain?.[0]).toMatchObject({
      importedHelper: 'createIdentityClient',
      exportedSymbol: 'createIdentityClient',
      helperSourceFile: 'srv/functions/connection-helper.ts',
    });
    const rules = bindings.find((b) => b.variableName === 'rules');
    expect(rules?.helperChain?.[0]).toMatchObject({
      importedHelper: 'createRulesRemote',
      exportedSymbol: 'createRulesRemote',
      helperSourceFile: 'srv/functions/connection-helper.ts',
    });
  });
  it('parses two-argument cds.connect.to without confusing alias and service path', async () => {
    const root = path.join(fixture, 'rules-service');
    const bindings = await parseServiceBindings(
      root,
      'srv/functions/RulesHandler.ts',
    );
    const process = bindings.find((b) => b.variableName === 'process');
    expect(process?.aliasExpr).toBe('svc_${objectCode}_process');
    expect(process?.destinationExpr).toBe('svc_${objectCode}_process');
    expect(process?.servicePathExpr).toBe('/${objectType}ProcessService');
    expect(process?.placeholders).toEqual(
      expect.arrayContaining(['objectCode', 'objectType']),
    );
  });
  it('propagates class-field helper object returns to destructured caller locals', async () => {
    const root = path.join(fixture, 'rules-service');
    const bindings = await parseServiceBindings(
      root,
      'srv/functions/ClassHelperHandler.ts',
    );
    const process = bindings.find((b) => b.variableName === 'processClient');
    expect(process?.aliasExpr).toBe('svc_${objectCode}_process');
    expect(process?.servicePathExpr).toBe('/${objectType}ProcessService');
    expect(process?.helperChain?.[0]).toMatchObject({
      className: 'ClassHelperHandler',
      classHelper: 'createProcessClient',
      returnedProperty: 'processClient',
    });
  });

  it('parses aliased local service calls and ignores entity accessors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-local-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      import cds from '@sap/cds';
      export async function run() {
        const service = cds.services["acme.catalog.CatalogService"];
        cds.services.db.entities("Catalog.Items");
        cds.services.CatalogService.entities;
        await service.loadSummary({ id: '1' });
        await cds.services.CatalogService.refresh({ id: '1' });
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    const local = calls.filter((call) => call.callType === 'local_service_call');
    expect(local.map((call) => call.operationPathExpr).sort()).toEqual(['/loadSummary', '/refresh']);
    expect(local.every((call) => call.operationPathExpr !== '/entities')).toBe(true);
    expect(local.find((call) => call.operationPathExpr === '/loadSummary')?.localServiceName).toBe('acme.catalog.CatalogService');
  });
  it('parses generated constants and redacts secrets', async () => {
    const constants = await parseGeneratedConstants(
      path.join(fixture, 'facade-service'),
      'srv/functions/EntryHandler.ts',
    );
    expect(constants.some((c) => c.value === 'doWork')).toBe(true);
    expect(redactText('authorization: Bearer token password=abc')).toContain(
      '[REDACTED]',
    );
  });
  it('resolves dynamic templates', () => {
    expect(
      applyVariables('/${objectType}ProcessService', { objectType: 'Thing' }),
    ).toBe('/ThingProcessService');
  });
});

describe('executable symbol parser trace-quality cases', () => {
  it('keeps only conservative local symbol calls and supports export lists/object helpers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-symbols-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'helper.ts'), `
      const loadMetadata = async () => {};
      const cacheHelper = {
        getConfiguration: async () => {},
        getRules() {}
      };
      export { loadMetadata as publicLoadMetadata, cacheHelper };
    `);
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), `
      import externalLib from 'external-lib';
      import { publicLoadMetadata, cacheHelper } from './helper';
      function localHelper(): void {}
      class FacadeEntryHandler {
        public async run(): Promise<void> {
          JSON.parse('{}');
          Object.keys({});
          [1].map((x) => x);
          localHelper();
          this.otherMethod();
          externalLib.doThing();
          await publicLoadMetadata();
          await cacheHelper.getConfiguration();
        }
        otherMethod(): void {}
      }
    `);
    const helper = await import('../../src/parsers/symbol-parser.js');
    const parsedHelper = await helper.parseExecutableSymbols(root, 'src/helper.ts');
    expect(parsedHelper.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: 'loadMetadata', exported: true, exportedName: 'publicLoadMetadata' }),
      expect.objectContaining({ qualifiedName: 'cacheHelper.getConfiguration', exported: true, exportedName: 'cacheHelper.getConfiguration' }),
      expect.objectContaining({ qualifiedName: 'cacheHelper.getRules', exported: true, exportedName: 'cacheHelper.getRules' }),
    ]));
    const parsedEntry = await helper.parseExecutableSymbols(root, 'src/entry.ts');
    expect(parsedEntry.calls.map((call) => call.calleeExpression).sort()).toEqual([
      'cacheHelper.getConfiguration',
      'localHelper',
      'publicLoadMetadata',
      'this.otherMethod',
    ]);
  });


  it('exports only public static members of exported classes and indexes shorthand object aliases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-exported-class-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'worker.ts'), `
      import { runHeavyCheck } from './run-heavy-check';
      export const workerFunctions = { runHeavyCheck };
      export class DomainWorker {
        static instance(): unknown { return DomainWorker.singleton.pool; }
        public runInstance(): void {}
        private static hidden(): void {}
      }
      class InternalWorker { static instance(): void {} }
    `);
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), `
      import { DomainWorker } from './worker';
      import { PackageWorker } from '@scope/worker';
      export async function handle(): Promise<void> {
        const worker = DomainWorker.instance();
        await worker.runHeavyCheck({});
        PackageWorker.instance();
      }
    `);
    const { parseExecutableSymbols } = await import('../../src/parsers/symbol-parser.js');
    const parsedWorker = await parseExecutableSymbols(root, 'src/worker.ts');
    const staticMember = parsedWorker.symbols.find((symbol) => symbol.qualifiedName === 'DomainWorker.instance');
    expect(staticMember).toMatchObject({ exported: true, exportedName: 'DomainWorker.instance' });
    expect(staticMember?.importExportEvidence).toMatchObject({ source: 'exported_class_member', memberKind: 'static_method' });
    const objectAlias = parsedWorker.symbols.find((symbol) => symbol.qualifiedName === 'workerFunctions.runHeavyCheck');
    expect(objectAlias).toMatchObject({ kind: 'object_alias', exportedName: 'runHeavyCheck' });
    expect(objectAlias?.importExportEvidence).toMatchObject({ source: 'exported_object_shorthand', targetImportSource: './run-heavy-check' });
    expect(parsedWorker.symbols.find((symbol) => symbol.qualifiedName === 'DomainWorker.runInstance')?.exported).toBe(false);
    expect(parsedWorker.symbols.find((symbol) => symbol.qualifiedName === 'DomainWorker.hidden')?.exported).toBe(false);
    expect(parsedWorker.symbols.find((symbol) => symbol.qualifiedName === 'InternalWorker.instance')?.exported).toBe(false);
    const parsedHandler = await parseExecutableSymbols(root, 'src/handler.ts');
    expect(parsedHandler.calls.map((call) => call.calleeExpression).sort()).toEqual(['DomainWorker.instance', 'worker.runHeavyCheck']);
    expect(parsedHandler.calls.find((call) => call.calleeExpression === 'worker.runHeavyCheck')?.evidence).toMatchObject({ relation: 'relative_import_proxy_member', caller: 'handle', targetName: 'runHeavyCheck', factory: 'DomainWorker.instance' });
  });
});

describe('CAP DB query parser and output labels', () => {
  async function callsFor(source: string): Promise<Awaited<ReturnType<typeof parseOutboundCalls>>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-db-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), source);
    return parseOutboundCalls(root, 'src/handler.ts');
  }

  it('extracts entities from chained cds.run query forms', async () => {
    const calls = await callsFor(`
      export async function run(id: string): Promise<void> {
        await cds.run(SELECT.one.from(Items).columns((col) => col('*')).where({ id }));
        await cds.run(
          SELECT.one
            .from(ItemVersions)
            .columns((col) => {
              col('*');
              col.children((child) => child('*'));
            })
            .where({ id })
        );
        await cds.run(SELECT.from(ItemSections).where({ id }));
        await cds.run(SELECT.one(Books).columns('ID').where({ id }));
        await cds.run(INSERT.into(AuditLogs).entries({ id }));
        await cds.run(UPSERT.into(AuditEntries).entries({ id }));
        await cds.run(UPDATE(Items).set({ id }));
        await cds.run(UPDATE.entity(ItemDetails).set({ id }));
        await cds.run(DELETE.from(this.model['ItemSections']).where({ id }));
        await cds.run(buildQuery(id));
      }
    `);
    const dbCalls = calls.filter((call) => call.callType === 'local_db_query');
    expect(dbCalls.map((call) => call.queryEntity)).toEqual([
      'Items',
      'ItemVersions',
      'ItemSections',
      'Books',
      'AuditLogs',
      'AuditEntries',
      'Items',
      'ItemDetails',
      'ItemSections',
      undefined,
    ]);
    expect(dbCalls.at(-1)?.unresolvedReason).toBe('dynamic_entity_expression');
  });

  it('filters noisy property symbol calls but keeps local helper evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-symbol-filter-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), `
      function validatePayload(): void {}
      class EntryHandler {
        private logger = { error() {} };
        private cache = new Map<string, string>();
        async run(items: string[], req: { reject(code: number, message: string): void }): Promise<void> {
          items.push('x');
          items.includes('x');
          items.findIndex((item) => item === 'x');
          'x'.toUpperCase();
          this.logger.error('failed');
          this.cache.get('x');
          await cds.run(SELECT.from(Books));
          req.reject(400, 'bad request');
          JSON.stringify({ ok: true });
          Date.now();
          Promise.all([]);
          validatePayload();
          this.loadDetails();
        }
        loadDetails(): void {}
      }
    `);
    const { parseExecutableSymbols } = await import('../../src/parsers/symbol-parser.js');
    const parsed = await parseExecutableSymbols(root, 'src/handler.ts');
    expect(parsed.calls.map((call) => call.calleeExpression).sort()).toEqual(['this.loadDetails', 'validatePayload']);
    expect(parsed.calls.find((call) => call.calleeExpression === 'this.loadDetails')?.evidence.relation).toBe('indexed_this_method');
  });
});

describe('trace output rendering', () => {
  it('renders unknown DB parser warnings without numeric entity labels', async () => {
    const { renderTraceTable } = await import('../../src/output/table-output.js');
    const { renderMermaid } = await import('../../src/output/mermaid-output.js');
    const result = {
      start: {},
      nodes: [],
      diagnostics: [],
      edges: [{ step: 1, type: 'local_db_query', from: 'process-helper-a:src/EntryHandler.ts:10', to: 'Entity: unknown', evidence: { sourceFile: 'src/EntryHandler.ts', sourceLine: 10, parserWarning: { code: 'parser_warning', message: 'dynamic query' } }, confidence: 0.55 }],
    };
    expect(renderTraceTable(result)).toContain('Entity: unknown');
    expect(renderTraceTable(result)).not.toContain(' 1234 ');
    expect(renderMermaid(result)).toContain('Entity: unknown');
  });
});

describe('service-flow ownership symbol regressions', () => {
  it('indexes class property function members and targeted callback symbols', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-owner-symbols-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), `
class HandlerClass {
  public helperMethod = async () => {
    await cds.run(SELECT.from(EntityName));
  };
  private remoteHelper = async function () {
    await svc.send({ method: 'POST', path: '/doWork' });
  };
  ordinary(): void { this.helperMethod(); }
}
cds.on('served', async () => {
  await messaging.on('Changed', async () => undefined);
});
`);
    const parsed = await parseExecutableSymbols(root, 'src/handler.ts');
    expect(parsed.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: 'HandlerClass.helperMethod', kind: 'method' }),
      expect.objectContaining({ qualifiedName: 'HandlerClass.remoteHelper', kind: 'method' }),
      expect.objectContaining({ qualifiedName: 'HandlerClass.ordinary', kind: 'method' }),
    ]));
    expect(parsed.symbols.some((symbol) => symbol.qualifiedName.startsWith('module:src/handler.ts#callback:'))).toBe(true);
  });
});

describe('outbound AST parser hardening', () => {
  async function parseSource(source: string): Promise<{ calls: Awaited<ReturnType<typeof parseOutboundCalls>>; symbols: Awaited<ReturnType<typeof parseExecutableSymbols>>['symbols'] }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-ast-outbound-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), source);
    const calls = await parseOutboundCalls(root, 'src/handler.ts');
    const symbols = (await parseExecutableSymbols(root, 'src/handler.ts')).symbols;
    return { calls, symbols };
  }

  it('ignores outbound-like code in line comments, block comments, and strings', async () => {
    const { calls } = await parseSource(`
      // await cds.run(SELECT.from(OldEntity));
      // await remoteClient.send({ path: '/oldOperation', method: 'POST' });
      // await messageClient.emit('OldEvent', body);
      // executeHttpRequest({ destinationName: 'legacy' }, { method: 'GET' });
      /*
        await cds.run(SELECT.from(BlockEntity));
        await remoteClient.send({ path: '/blockOperation', method: 'POST' });
        await messageClient.publish('BlockEvent', body);
        await messageClient.on('BlockEvent', handler);
        await axios('/legacy');
        await useOrFetchDestination({ destinationName: 'legacy' });
      */
      const text = "await cds.run(SELECT.from(StringEntity)); remoteClient.send({ path: '/string' });";
    `);
    expect(calls).toHaveLength(0);
  });

  it('indexes equivalent executable outbound calls with AST evidence', async () => {
    const { calls } = await parseSource(`
      async function run(): Promise<void> {
        const remoteClient = await cds.connect.to('RemoteService');
        await cds.run(SELECT.from(RealEntity));
        await remoteClient.send({ path: '/doWork', method: 'POST' });
        await remoteClient.emit('Changed', {});
        await remoteClient.on('Changed', () => undefined);
        await executeHttpRequest({ destinationName: 'dest' }, { method: 'GET' });
      }
    `);
    expect(calls.map((call) => call.callType).sort()).toEqual(['async_emit', 'async_subscribe', 'external_http', 'local_db_query', 'remote_action']);
    expect(calls.every((call) => call.evidence?.parser === 'typescript_ast')).toBe(true);
  });

  it('does not treat Express response send or generic event emitters as service-flow outbound behavior', async () => {
    const { calls, symbols } = await parseSource(`
      app.get('/health', (_req, res) => {
        res.status(200).send('OK');
      });
      desktopApp.on('window-all-closed', () => undefined);
      windowRef.on('close', () => undefined);
    `);
    expect(calls).toHaveLength(0);
    expect(symbols.some((symbol) => symbol.qualifiedName.includes('#callback:'))).toBe(false);
  });

  it('creates a synthetic owner for indexed top-level CAP event registrations', async () => {
    const { calls, symbols } = await parseSource(`
      cds.on('served', async () => {
        logger.info('ready');
      });
    `);
    expect(calls).toEqual([expect.objectContaining({ callType: 'async_subscribe', eventNameExpr: 'served' })]);
    expect(symbols.some((symbol) => symbol.kind === 'event_registration' && symbol.qualifiedName.includes('module:src/handler.ts#event:served:'))).toBe(true);
  });
});
