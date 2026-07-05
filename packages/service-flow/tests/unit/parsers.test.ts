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

  it('keeps CAP event emits conservative and ignores generic realtime emitters', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-events-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'events.ts'), `
      import cds from '@sap/cds';
      export async function run(userId: string) {
        const realtime = getRealtimeServer();
        const socket = getSocket();
        realtime.emit("room-message", {});
        realtime.to(userId).emit("direct-message", {});
        socket.broadcast.emit("typing", {});
        const messaging = await cds.connect.to("message-bus");
        await messaging.emit("DomainEvent", {});
        await messaging.publish("PublishedEvent", {});
        await cds.emit("CdsEvent", {});
        await messaging.on("SubscribedEvent", () => undefined);
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/events.ts');
    const events = calls.filter((call) => call.callType === 'async_emit' || call.callType === 'async_subscribe');
    expect(events.map((call) => call.eventNameExpr).sort()).toEqual(['CdsEvent', 'DomainEvent', 'PublishedEvent', 'SubscribedEvent']);
    expect(events.some((call) => call.eventNameExpr === 'room-message')).toBe(false);
    expect(events.every((call) => call.evidence?.receiverClassification === 'cap_evidence')).toBe(true);
  });

  it('adds object-shaped evidence to local CAP service calls including aliases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-local-evidence-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      import cds from '@sap/cds';
      export async function run() {
        const catalog = cds.services.CatalogService;
        await catalog.refresh({ id: '1' });
        await cds.services.AdminService.rebuild({ id: '1' });
      }
    `);
    const local = (await parseOutboundCalls(root, 'srv/handler.ts')).filter((call) => call.callType === 'local_service_call');
    expect(local).toHaveLength(2);
    const aliasCall = local.find((call) => call.localServiceName === 'CatalogService');
    expect(aliasCall?.evidence).toMatchObject({ parser: 'typescript_ast', classifier: 'local_cap_service_call', localServiceName: 'CatalogService', operation: 'refresh', aliasChain: ['cds.services.CatalogService', 'catalog'] });
    const directCall = local.find((call) => call.localServiceName === 'AdminService');
    expect(directCall?.evidence).toMatchObject({ parser: 'typescript_ast', classifier: 'local_cap_service_call', localServiceLookup: 'cds.services.AdminService', operation: 'rebuild' });
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


  it('resolves conservative class instance method calls for same-file and relative helper classes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-class-instance-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'helper.ts'), `
      export class ImportedHelper {
        async run(primaryClient: unknown): Promise<void> { await primaryClient.send({ method: 'POST', path: '/run', data: {} }); }
      }
      export class OtherHelper {
        async run(primaryClient: unknown): Promise<void> { await primaryClient.send({ method: 'POST', path: '/other', data: {} }); }
      }
    `);
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), `
      import { ImportedHelper, OtherHelper } from './helper';
      class LocalHelper { async check(primaryClient: unknown): Promise<void> { await primaryClient.send({ method: 'POST', path: '/check', data: {} }); } }
      export async function start(primaryClient: unknown, secondaryClient: unknown): Promise<void> {
        const local = new LocalHelper();
        const imported = new ImportedHelper();
        const other = new OtherHelper();
        await local.check(primaryClient);
        await imported.run(primaryClient);
        await other.run(secondaryClient);
        const dynamicName = 'run';
        await imported[dynamicName](primaryClient);
      }
    `);
    const { parseExecutableSymbols } = await import('../../src/parsers/symbol-parser.js');
    const parsed = await parseExecutableSymbols(root, 'src/entry.ts');
    expect(parsed.calls.map((call) => call.calleeExpression).sort()).toEqual(['imported.run', 'local.check', 'other.run']);
    expect(parsed.calls.find((call) => call.calleeExpression === 'local.check')?.evidence).toMatchObject({ relation: 'class_instance_method', instanceVariable: 'local', className: 'LocalHelper', methodName: 'check', candidateStrategy: 'same_file_class_instance_method' });
    expect(parsed.calls.find((call) => call.calleeExpression === 'imported.run')?.evidence).toMatchObject({ relation: 'class_instance_method', instanceVariable: 'imported', className: 'ImportedHelper', methodName: 'run', classImportSource: './helper', candidateStrategy: 'relative_import_class_instance_method' });
    expect(parsed.symbols.find((symbol) => symbol.qualifiedName === 'LocalHelper.check')?.importExportEvidence).toMatchObject({ parameterBindings: [{ index: 0, kind: 'identifier', name: 'primaryClient' }] });
  });


  it('keeps nested this receiver calls conservative unless helper instance evidence exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-nested-this-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'imported.ts'), "export class ImportedHelper { run(): void {} }\n");
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), `
      import { ImportedHelper } from './imported';
      class LocalHelper { run(): void {} }
      class CurrentClass {
        private localHelper = new LocalHelper();
        private importedHelper = new ImportedHelper();
        private helper = { run(): void {} };
        private cache = { clear(): void {} };
        private graphs: Record<string, { findPath(input: string): void }> = {};
        run(): void {}
        clear(): void {}
        findPath(input: string): void {}
        execute(input: string): void {
          this.run();
          this.helper.run();
          this.cache.clear();
          this.graphs[input].findPath(input);
          this.localHelper.run();
          this.importedHelper.run();
        }
      }
    `);
    const parsed = await parseExecutableSymbols(root, 'src/handler.ts');
    const expressions = parsed.calls.map((call) => call.calleeExpression).sort();
    expect(expressions).toEqual(['this.importedHelper.run', 'this.localHelper.run', 'this.run']);
    expect(parsed.calls.find((call) => call.calleeExpression === 'this.run')?.calleeLocalName).toBe('CurrentClass.run');
    expect(parsed.calls.find((call) => call.calleeExpression === 'this.localHelper.run')?.calleeLocalName).toBe('LocalHelper.run');
    expect(parsed.calls.find((call) => call.calleeExpression === 'this.importedHelper.run')?.calleeLocalName).toBe('ImportedHelper.run');
    expect(expressions).not.toContain('this.helper.run');
    expect(expressions).not.toContain('this.cache.clear');
    expect(expressions).not.toContain('this.graphs[input].findPath');
  });

  it('does not collect JavaScript built-in instances as class instance symbol calls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-builtins-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), `
      class LocalHelper { run(value: string): string { return value; } }
      export async function start(value: string): Promise<void> {
        const local = new LocalHelper();
        const seen = new Set<string>();
        const mapping = new Map<string, string>();
        const d = new Date();
        const re = new RegExp(value);
        local.run(value);
        seen.add(value);
        mapping.entries();
        d.getTime();
        re.test(value);
      }
    `);
    const parsed = await parseExecutableSymbols(root, 'src/entry.ts');
    expect(parsed.calls.map((call) => call.calleeExpression)).toEqual(['local.run']);
  });

  it('records one-level object parameter destructuring aliases inside helper bodies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-parameter-alias-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), `
      export async function prepareHistory(input: { processClient: unknown; headers: Record<string, string> }): Promise<void> {
        const { processClient } = input;
        const { processClient: client } = input;
        let assignedClient;
        ({ processClient: assignedClient } = input);
        await processClient.send({ method: 'POST', path: '/loadPriorState' });
        await client.send({ method: 'POST', path: '/loadCurrentState' });
        await assignedClient.send({ method: 'POST', path: '/loadNextState' });
      }
    `);
    const parsed = await parseExecutableSymbols(root, 'src/entry.ts');
    expect(parsed.symbols.find((symbol) => symbol.qualifiedName === 'prepareHistory')?.importExportEvidence).toMatchObject({
      parameterPropertyAliases: [
        { parameter: 'input', property: 'processClient', local: 'processClient', kind: 'object_parameter_destructure' },
        { parameter: 'input', property: 'processClient', local: 'client', kind: 'object_parameter_destructure' },
        { parameter: 'input', property: 'processClient', local: 'assignedClient', kind: 'object_parameter_destructure' },
      ],
    });
  });

  it('records destructured object parameter metadata for class methods', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-destructured-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'entry.ts'), `
      export class WorkflowHelper {
        async validate({ configClient, client: serviceClient, optionalClient = fallbackClient }: { configClient: unknown; client: unknown; optionalClient?: unknown }): Promise<void> {
          await configClient.send({ method: 'POST', path: '/validatePayload' });
          await serviceClient.send({ method: 'POST', path: '/checkAuthorization' });
        }
      }
    `);
    const parsed = await parseExecutableSymbols(root, 'src/entry.ts');
    expect(parsed.symbols.find((symbol) => symbol.qualifiedName === 'WorkflowHelper.validate')?.importExportEvidence).toMatchObject({
      parameters: [],
      parameterBindings: [{
        index: 0,
        kind: 'object_pattern',
        properties: [
          { property: 'configClient', local: 'configClient' },
          { property: 'client', local: 'serviceClient' },
          { property: 'optionalClient', local: 'optionalClient' },
        ],
      }],
    });
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

describe('OData send parser evidence', () => {
  it('persists entity-key placeholders separately from operation invocation arguments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-documents-parser-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      export async function run(documentService, attachment, file, attachmentID, request, data, content) {
        await documentService.send({ method: "POST", path: "/DocumentAttachment", data });
        await documentService.send({ method: "PUT", path: \`/DocumentAttachment(\${attachment.ID})/file\`, data: content });
        await documentService.send({ method: "PUT", path: \`/DocumentAttachment('\${file.ID}')/content\`, data: content });
        await documentService.send({ method: "GET", path: \`/DocumentAttachment(\${attachmentID})\` });
        await documentService.send({ method: "POST", path: "/refreshCache(id=\${request.ID})" });
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    const media = calls.find((call) => call.operationPathExpr?.includes('/file'));
    expect(media?.callType).toBe('remote_entity_media');
    expect(media?.evidence).toMatchObject({ odataPathIntent: { kind: 'entity_media', keyPredicatePlaceholderKeys: ['attachment.ID'], mediaOrPropertySuffix: 'file' } });
    const read = calls.find((call) => call.operationPathExpr?.includes('attachmentID'));
    expect(read?.callType).toBe('remote_query');
    expect(read?.evidence).toMatchObject({ odataPathIntent: { kind: 'entity_key_read', keyPredicatePlaceholderKeys: ['attachmentID'] } });
    const operation = calls.find((call) => call.operationPathExpr?.startsWith('/refreshCache'));
    expect(operation?.callType).toBe('remote_action');
    expect(operation?.evidence).toMatchObject({ odataPathIntent: { kind: 'operation_invocation', invocationArgumentPlaceholderKeys: ['request.ID'], keyPredicatePlaceholderKeys: [] } });
  });
});

describe('0.1.42 parser regressions', () => {
  it('ignores commented CDS usings and preserves the live module specifier', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-cds-comments-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'extension.cds'), `
      using { SharedService } from '@neutral/right-model/db/service';
      /*
      using { SharedService } from '@neutral/wrong-model/db/service';
      */
      extend service SharedService @(path: '/concrete-api') {}
    `);
    const services = await parseCdsFile(root, 'srv/extension.cds');
    expect(services[0]?.extension).toMatchObject({
      importedSymbol: 'SharedService',
      moduleSpecifier: '@neutral/right-model/db/service',
      importKind: 'package',
    });
  });

  it('resolves catch and loop shadowing back to the outer immutable path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-lexical-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      const ROUTE = '/outer';
      export async function run(client) {
        try { await work(); } catch (ROUTE) { void ROUTE; }
        await client.send({ method: 'POST', path: ROUTE });
        for (let LOOP_ROUTE = 0; LOOP_ROUTE < 1; LOOP_ROUTE += 1) { void LOOP_ROUTE; }
        const LOOP_PATH = '/loop-outer';
        for (let LOOP_PATH = 0; LOOP_PATH < 1; LOOP_PATH += 1) { void LOOP_PATH; }
        await client.send({ method: 'POST', path: LOOP_PATH });
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    expect(calls.map((call) => call.operationPathExpr)).toEqual(['/outer', '/loop-outer']);
    expect(calls.every((call) => call.evidence?.literalPathSource === 'same_scope_const_initializer')).toBe(true);
  });

  it('keeps nested catch and loop block declarations inside their real block scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-nested-lexical-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      const route = "/outerAction";
      export async function run() {
        const remote = await cds.connect.to("remote_catalog");
        for (const item of [1]) {
          {
            const route = "/innerAction";
            void route;
          }
          await remote.send("POST", route, { item });
        }
        try { await work(); } catch (error) {
          {
            const route = "/innerAction";
            void route;
          }
          void error;
          await remote.send("POST", route, {});
        }
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    const positional = calls.filter((call) => call.evidence?.classifier === 'service_client_send_method_path');
    expect(positional.map((call) => call.operationPathExpr)).toEqual(['/outerAction', '/outerAction']);
    expect(positional.every((call) => call.evidence?.literalPathSource === 'same_scope_const_initializer')).toBe(true);
  });

  it('classifies positional remote CAP send only for proven connected clients', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-positional-send-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      export async function run(response, socket, customTransport) {
        const remote = await cds.connect.to('remote_catalog');
        const PATH = '/performWork';
        await remote.send('POST', PATH, { ok: true }, { Authorization: 'hidden' });
        response.send('OK');
        socket.send('payload');
        customTransport.send('dispatchJob', {});
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callType: 'remote_action',
      serviceVariableName: 'remote',
      method: 'POST',
      operationPathExpr: '/performWork',
    });
    expect(calls[0]?.evidence).toMatchObject({ classifier: 'service_client_send_method_path' });
  });

  it('classifies proven CAP send operation overload and immutable aliases without generic send fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-operation-send-'));
    await fs.mkdir(path.join(root, 'srv'), { recursive: true });
    await fs.writeFile(path.join(root, 'srv', 'handler.ts'), `
      export async function run(response, customTransport) {
        const remote = await cds.connect.to('remote_catalog');
        const operation = 'performWork';
        await remote.send(operation, { ok: true });
        await remote.send('POST', '/performWork', { ok: true });
        await customTransport.send('performWork', {});
        response.send('OK');
      }
    `);
    const calls = await parseOutboundCalls(root, 'srv/handler.ts');
    expect(calls).toHaveLength(2);
    const operation = calls.find((call) => call.evidence?.classifier === 'service_client_send_operation_event');
    expect(operation).toMatchObject({ callType: 'remote_action', serviceVariableName: 'remote', operationPathExpr: '/performWork', unresolvedReason: undefined });
    expect(operation?.method).toBeUndefined();
    expect(operation?.evidence).toMatchObject({ literalOperationSource: 'const_alias' });
  });
});
