import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { linkWorkspace, trace } from '../../src/index.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

async function createContextWorkspace(root: string): Promise<void> {
  await writeFixtureFile(root, 'remote-service/.git-fixture');
  await writeFixtureFile(root, 'remote-service/package.json', JSON.stringify({ name: '@neutral/remote-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'remote-service/srv/remote.cds', 'service RemoteService { action directTask(); action objectTask(); action arrayTask(); action transactionTask(); }');
  await writeFixtureFile(root, 'remote-service/srv/TaskHandler.ts', `import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class TaskHandler {
  @Action('directTask') directTask(): void {}
  @Action('objectTask') objectTask(): void {}
  @Action('arrayTask') arrayTask(): void {}
  @Action('transactionTask') transactionTask(): void {}
}
`);
  await writeFixtureFile(root, 'remote-service/srv/server.ts', `import { createCombinedHandler } from 'cds-routing-handlers';
import { TaskHandler } from './TaskHandler.js';
createCombinedHandler({ handler: [TaskHandler] });
`);

  await writeFixtureFile(root, 'gateway-service/.git-fixture');
  await writeFixtureFile(root, 'gateway-service/package.json', JSON.stringify({ name: '@neutral/gateway-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'gateway-service/srv/gateway.cds', 'service GatewayService { action begin(); }');
  await writeFixtureFile(root, 'gateway-service/srv/helpers.ts', `export async function direct(client: { send(input: unknown): Promise<unknown> }): Promise<void> {
  await client.send({ method: 'POST', path: '/directTask()' });
}
export async function objectParam({ client }: { client: { send(input: unknown): Promise<unknown> } }): Promise<void> {
  await client.send({ method: 'POST', path: '/objectTask()' });
}
export async function arrayParam([client]: Array<{ send(input: unknown): Promise<unknown> }>): Promise<void> {
  await client.send({ method: 'POST', path: '/arrayTask()' });
}
export async function transactionParam(client: { send(input: unknown): Promise<unknown> }): Promise<void> {
  await client.send({ method: 'POST', path: '/transactionTask()' });
}
export async function dynamicPath(client: { send(input: unknown): Promise<unknown> }, path: string): Promise<void> {
  await client.send({ method: 'POST', path });
}
`);
  await writeFixtureFile(root, 'gateway-service/srv/EntryHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
import { direct, objectParam, arrayParam, transactionParam, dynamicPath } from './helpers.js';
@Handler()
export class EntryHandler {
  @Action('begin')
  async begin(req: unknown): Promise<void> {
    const remoteClient = await cds.connect.to('remote', { credentials: { path: '/RemoteService' } });
    const remoteTx = remoteClient.tx(req);
    await direct(remoteClient);
    await objectParam({ client: remoteClient });
    await arrayParam([remoteClient]);
    await transactionParam(remoteTx);
    await dynamicPath(remoteClient, req.path);
  }
}
`);
  await writeFixtureFile(root, 'gateway-service/srv/server.ts', `import { createCombinedHandler } from 'cds-routing-handlers';
import { EntryHandler } from './EntryHandler.js';
createCombinedHandler({ handler: [EntryHandler] });
`);
}

describe('imported contextual service-client propagation', () => {
  it('propagates direct, object, array, and transaction client arguments with caller and callee evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-imported-context-'));
    await createContextWorkspace(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const result = trace(db, { repo: 'gateway-service', handler: 'EntryHandler' }, { depth: 8 });
    for (const operation of ['directTask', 'objectTask', 'arrayTask', 'transactionTask']) {
      const edge = result.edges.find((item) => item.type === 'remote_action' && item.to.includes(operation));
      expect(edge?.unresolvedReason).toBeUndefined();
      expect(edge?.evidence.contextualBinding).toMatchObject({
        callerSite: { sourceFile: 'srv/EntryHandler.ts' },
        calleeSite: { sourceFile: 'srv/helpers.ts' },
      });
    }
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
      missingVariables: ['req.path'],
      suggestions: ['--var req.path=<value>'],
    }));
    const runtimeResult = trace(db, { repo: 'gateway-service', handler: 'EntryHandler' }, {
      depth: 8,
      vars: { 'req.path': '/directTask()' },
    });
    const dynamicCallerEdge = runtimeResult.edges.find((item) =>
      item.type === 'remote_action'
      && item.from.includes('EntryHandler.ts')
      && item.evidence.outboundEvidence
      && String((item.evidence.outboundEvidence as Record<string, unknown>).classifier) === 'imported_wrapper_dynamic_path');
    expect(dynamicCallerEdge?.to).toBe('/RemoteService/directTask');
    expect(dynamicCallerEdge?.unresolvedReason).toBeUndefined();
    db.close();
  });
});
