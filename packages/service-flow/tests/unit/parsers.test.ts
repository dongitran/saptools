import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
