import { describe, expect, it } from 'vitest';
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
