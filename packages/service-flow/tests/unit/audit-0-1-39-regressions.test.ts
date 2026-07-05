import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCdsFile } from '../../src/parsers/cds-parser.js';
import { parseOutboundCalls } from '../../src/parsers/outbound-call-parser.js';

async function write(root: string, file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}

describe('0.1.39 audit regressions', () => {
  it('does not resolve an operation path from same-spelling sibling scope variables', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-lexical-'));
    await write(root, 'handler.ts', `
      interface Client { send(input: unknown): Promise<unknown> }
      declare function chooseRoute(): string;
      async function first(client: Client): Promise<void> {
        let route = chooseRoute();
        await client.send({ method: "POST", path: route });
      }
      function second(): string {
        const route = "/unrelatedAction";
        return route;
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operationPathExpr).toBeUndefined();
    expect(calls[0]?.unresolvedReason).toBe('dynamic_operation_path_identifier');
    expect(JSON.stringify(calls[0]?.evidence)).not.toContain('/unrelatedAction');
  });

  it('honors declaration order, transitive const aliases, branch candidates, and later dynamic writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-scope-'));
    await write(root, 'handler.ts', `
      interface Client { send(input: unknown): Promise<unknown> }
      async function run(client: Client, flag: boolean, input: { path: string }): Promise<void> {
        const base = '/aliasedAction';
        const alias = base;
        await client.send({ method: 'POST', path: alias });
        await client.send({ method: 'POST', path: afterCall });
        const afterCall = '/tooLateAction';
        let branch = '/firstAction';
        if (flag) branch = '/secondAction';
        await client.send({ method: 'GET', path: branch });
        let later = '/stableAction';
        later = input.path;
        await client.send({ method: 'POST', path: later });
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.find((call) => call.operationPathExpr === '/aliasedAction')).toBeTruthy();
    expect(calls.find((call) => call.evidence?.rawPathExpression === 'afterCall')?.operationPathExpr).toBeUndefined();
    const branch = calls.find((call) => call.evidence?.rawPathExpression === 'branch');
    expect(branch?.operationPathExpr).toBeUndefined();
    expect(branch?.evidence?.staticPathCandidates).toMatchObject({ candidatePaths: ['/firstAction', '/secondAction'], normalizedCandidateOperations: ['firstAction', 'secondAction'] });
    expect(calls.find((call) => call.evidence?.rawPathExpression === 'later')?.operationPathExpr).toBeUndefined();
  });

  it('keeps external URL and destination templates with substitutions dynamic', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-external-'));
    await write(root, 'handler.ts', `
      declare const host: string;
      declare const recordId: string;
      declare const tenant: string;
      declare function useOrFetchDestination(input: unknown): Promise<unknown>;
      async function run(): Promise<void> {
        await fetch(\`https://\${host}/records/\${recordId}\`);
        await useOrFetchDestination({ destinationName: \`REMOTE_\${tenant}\` });
        await fetch("https://example.invalid/health");
        await fetch(\`https://example.invalid/health\`);
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    const dynamicTargets = calls.filter((call) => call.externalTarget?.dynamic);
    expect(dynamicTargets).toHaveLength(2);
    expect(dynamicTargets.every((call) => !call.externalTarget?.label.includes('${'))).toBe(true);
    expect(calls.filter((call) => call.externalTarget?.dynamic === false && call.externalTarget.kind === 'static_url')).toHaveLength(2);
  });

  it('reads CDS path annotations from original text for services and supported extensions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-cds-'));
    await write(root, 'srv/service.cds', `
      namespace neutral.model;
      @(path: '/prefix-api')
      service PrefixService { action first(); }
      service SuffixService @(path: "/suffix-api") { action second(); }
      using { PrefixService } from '@neutral/model/service';
      extend PrefixService @(path: '/alpha-api') {}
      extend service SuffixService @(path: '/beta-api') {}
    `);
    const services = await parseCdsFile(root, 'srv/service.cds');
    expect(services.map((service) => service.servicePath)).toEqual(['/prefix-api', '/suffix-api', '/alpha-api', '/beta-api']);
    expect(services.filter((service) => service.isExtend).map((service) => service.serviceName)).toEqual(['PrefixService', 'SuffixService']);
  });
});
