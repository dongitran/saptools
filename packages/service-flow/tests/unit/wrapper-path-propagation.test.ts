import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOutboundCalls } from '../../src/parsers/outbound-call-parser.js';

async function write(root: string, text: string): Promise<void> {
  await fs.writeFile(path.join(root, 'handler.ts'), text);
}

async function writeFile(root: string, relativePath: string, text: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

describe('local wrapper path propagation', () => {
  it('resolves same-file higher-order literal path wrapper calls while preserving dynamic wrapper sends', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-wrapper-'));
    await write(root, `
      const sendWithClient = (client: unknown, method: string, path: string, headers: unknown) => {
        return async () => client.send({ method, path, headers });
      };
      export async function runFlow(catalogClient: unknown, headers: { path: string }) {
        await sendWithClient(catalogClient, 'GET', '/loadCatalog()', headers)();
        const dynamicPath = headers.path;
        await sendWithClient(catalogClient, 'GET', dynamicPath, headers)();
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.some((call) => call.operationPathExpr === '/loadCatalog()' && call.evidence?.classifier === 'higher_order_wrapper_literal_path')).toBe(true);
    expect(calls.some((call) => call.unresolvedReason === 'dynamic_operation_path_identifier')).toBe(true);
  });

  it('resolves local arrow and function declaration wrappers with literal caller paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-local-wrapper-'));
    await write(root, `
      import cds from '@sap/cds';
      async function runFlow(): Promise<void> {
        const serviceClient = await cds.connect.to('remote_service');
        const post = (path: string) => serviceClient.send({ method: 'POST', path, data: {} });
        function get(path: string) { return serviceClient.send({ method: 'GET', path }); }
        await post('/firstAction');
        await post('/secondAction');
        await get('/readAction');
        const dynamicPath = String(Date.now());
        await post(dynamicPath);
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.filter((call) => call.operationPathExpr === '/firstAction')).toHaveLength(1);
    expect(calls.filter((call) => call.operationPathExpr === '/secondAction')).toHaveLength(1);
    expect(calls.filter((call) => call.operationPathExpr === '/readAction')).toHaveLength(1);
    expect(calls.some((call) => call.evidence?.receiver === 'serviceClient' && call.evidence?.callerLine)).toBe(true);
    expect(calls.some((call) => call.operationPathExpr === undefined && call.unresolvedReason === 'dynamic_operation_path_identifier')).toBe(true);
    expect(calls.some((call) => call.evidence?.classifier === 'service_client_send_object' && call.evidence?.operationPathExpression === 'path')).toBe(false);
  });

  it('resolves wrapper const and template path arguments with evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-wrapper-static-'));
    await write(root, "\n      const sendWithClient = (client: unknown, method: string, path: string, headers: unknown) => client.send({ method, path, headers });\n      export async function runFlow(catalogClient: unknown, headers: unknown, id: string): Promise<void> {\n        const actionPath = '/someAction';\n        await sendWithClient(catalogClient, 'POST', actionPath, headers);\n        await sendWithClient(catalogClient, 'GET', `/someAction(id='${id}')`, headers);\n      }\n    ");
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.find((call) => call.operationPathExpr === '/someAction')?.evidence).toMatchObject({ wrapperFunction: 'sendWithClient', wrapperPathSourceKind: 'const', literalPathSource: 'same_scope_const_initializer' });
    expect(calls.find((call) => call.operationPathExpr === "/someAction(id='${id}')")?.evidence).toMatchObject({ wrapperFunction: 'sendWithClient', wrapperPathSourceKind: 'template', normalizedOperationPath: 'someAction' });
    expect(calls).toHaveLength(2);
  });

  it('resolves direct shorthand path from static initializer and leaves dynamic shorthand unresolved', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-shorthand-path-'));
    await write(root, `
      export async function runFlow(serviceClient: { send(input: unknown): Promise<unknown> }, request: { path: string }): Promise<void> {
        const path = '/someAction';
        await serviceClient.send({ method: 'POST', path });
        const dynamicPath = request.path;
        await serviceClient.send({ method: 'POST', path: dynamicPath });
        await serviceClient.send({ method: 'POST', path: request.path });
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.find((call) => call.operationPathExpr === '/someAction')?.evidence?.literalPathSource).toBe('same_scope_const_initializer');
    expect(calls.filter((call) => call.unresolvedReason === 'dynamic_operation_path_identifier')).toHaveLength(2);
  });

  it('records branch candidate evidence without guessing across incompatible paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-path-candidates-'));
    await write(root, `
      export async function runFlow(serviceClient: { send(input: unknown): Promise<unknown> }, condition: boolean, input: { value: string }): Promise<void> {
        let path = '/defaultAction';
        if (condition) path = '/alternateAction';
        await serviceClient.send({ method: 'POST', path });
        let computedPath = '/initialAction';
        computedPath = input.value;
        await serviceClient.send({ method: 'POST', path: computedPath });
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    const branch = calls.find((call) => call.evidence?.staticPathCandidates);
    expect(branch?.operationPathExpr).toBeUndefined();
    expect(branch?.unresolvedReason).toBe('dynamic_operation_path_identifier');
    expect(branch?.evidence?.staticPathCandidates).toMatchObject({ candidatePaths: ['/defaultAction', '/alternateAction'], normalizedCandidateOperations: ['defaultAction', 'alternateAction'] });
    expect(calls.filter((call) => call.unresolvedReason === 'dynamic_operation_path_identifier')).toHaveLength(2);
  });

  it('resolves nested wrapper literal paths only when the caller path is static', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-nested-wrapper-'));
    await write(root, `
      import cds from '@sap/cds';
      async function sendInner(client: { send(input: unknown): Promise<unknown> }, path: string): Promise<unknown> {
        return client.send({ method: 'POST', path, data: {} });
      }
      async function sendOuter(client: { send(input: unknown): Promise<unknown> }, operationPath: string): Promise<unknown> {
        return sendInner(client, operationPath);
      }
      export async function runFlow(input: { path: string }): Promise<void> {
        const remoteClient = await cds.connect.to('remote_service');
        await sendOuter(remoteClient, '/nestedAction');
        await sendOuter(remoteClient, input.path);
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    expect(calls.find((call) => call.operationPathExpr === '/nestedAction')?.evidence).toMatchObject({
      classifier: 'higher_order_wrapper_literal_path',
      wrapperFunction: 'sendOuter',
      nestedWrapperFunction: 'sendInner',
    });
    expect(calls.filter((call) => call.unresolvedReason === 'dynamic_operation_path_identifier')).toHaveLength(1);
  });

  it('resolves imported and nested imported wrappers at the caller site only for proven service clients', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-imported-wrapper-'));
    await writeFile(root, 'inner.ts', `
      export async function sendInner(client: { send(input: unknown): Promise<unknown> }, path: string): Promise<unknown> {
        return client.send({ method: 'POST', path, data: {} });
      }
    `);
    await writeFile(root, 'outer.ts', `
      import { sendInner } from './inner.js';
      export async function sendOuter(client: { send(input: unknown): Promise<unknown> }, operationPath: string): Promise<unknown> {
        return sendInner(client, operationPath);
      }
    `);
    await writeFile(root, 'transport.ts', `
      export function sendTransport(client: { send(input: unknown): unknown }, path: string): unknown {
        return client.send({ method: 'POST', path });
      }
    `);
    await writeFile(root, 'handler.ts', `
      import cds from '@sap/cds';
      import { sendOuter } from './outer.js';
      import { sendTransport } from './transport.js';
      export async function runFlow(input: { path: string }): Promise<void> {
        const remoteClient = await cds.connect.to('remote_service', { credentials: { path: '/RemoteService' } });
        const transport = createTransport();
        await sendOuter(remoteClient, '/executeTask()');
        await sendOuter(remoteClient, input.path);
        sendTransport(transport, '/mustNotBecomeCapOperation');
      }
    `);

    const calls = await parseOutboundCalls(root, 'handler.ts');
    const literal = calls.find((call) => call.operationPathExpr === '/executeTask()');
    expect(literal).toMatchObject({
      sourceFile: 'handler.ts',
      callType: 'remote_action',
      serviceVariableName: 'remoteClient',
    });
    expect(literal?.evidence).toMatchObject({
      classifier: 'imported_wrapper_literal_path',
      callerSite: { sourceFile: 'handler.ts' },
      calleeSite: { sourceFile: 'outer.ts' },
      wrapperChain: ['sendOuter', 'sendInner'],
    });
    const dynamic = calls.find((call) => call.evidence?.classifier === 'imported_wrapper_dynamic_path');
    expect(dynamic).toMatchObject({
      sourceFile: 'handler.ts',
      operationPathExpr: '${input.path}',
      unresolvedReason: 'dynamic_operation_path_identifier',
    });
    expect(dynamic?.evidence).toMatchObject({
      missingPathIdentifier: 'input.path',
      calleeSite: { sourceFile: 'outer.ts' },
    });
    expect(calls.some((call) => call.operationPathExpr === '/mustNotBecomeCapOperation')).toBe(false);
    expect(calls.every((call) => call.sourceFile === 'handler.ts')).toBe(true);
  });
});
