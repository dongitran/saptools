import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { linkWorkspace, trace } from '../../src/index.js';
import { compactTrace } from '../../src/trace/compact-trace.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const complexKey = 'tenantInfo.region?.toLowerCase()';
const dynamicPath = `\${${complexKey}}`;

async function writeCaller(root: string): Promise<void> {
  await writeFixtureFile(root, 'facade-service/.git-fixture');
  await writeFixtureFile(root, 'facade-service/package.json', JSON.stringify({
    name: '@neutral/facade-service',
    version: '1.0.0',
    dependencies: { '@neutral/target-service': '1.0.0' },
  }));
  await writeFixtureFile(
    root,
    'facade-service/srv/facade.cds',
    'service FacadeService { action runFlow(); }',
  );
  await writeFixtureFile(root, 'facade-service/srv/FlowHandler.ts', `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class FlowHandler {
  @Action('runFlow')
  async runFlow(tenantInfo: { region?: string }): Promise<void> {
    const remoteClient = await cds.connect.to('target-api', {
      credentials: { path: '/TargetService' },
    });
    await remoteClient.send({
      method: 'GET',
      path: \`/\${tenantInfo.region?.toLowerCase()}\`,
    });
  }
}
`);
  await writeFixtureFile(root, 'facade-service/srv/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { FlowHandler } from './FlowHandler.js';
createCombinedHandler({ handler: [FlowHandler] });
`);
}

async function writeTarget(root: string): Promise<void> {
  await writeFixtureFile(root, 'target-service/.git-fixture');
  await writeFixtureFile(root, 'target-service/package.json', JSON.stringify({
    name: '@neutral/target-service',
    version: '1.0.0',
  }));
  await writeFixtureFile(
    root,
    'target-service/srv/target.cds',
    'service TargetService { function lookup() returns String; }',
  );
  await writeFixtureFile(root, 'target-service/srv/TargetHandler.ts', `
import { Func, Handler } from 'cds-routing-handlers';
function lookupLeaf(): string { return 'ok'; }
@Handler()
export class TargetHandler {
  @Func('lookup')
  lookup(): string { return lookupLeaf(); }
}
`);
  await writeFixtureFile(root, 'target-service/srv/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { TargetHandler } from './TargetHandler.js';
createCombinedHandler({ handler: [TargetHandler] });
`);
}

function parseRecord(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

type TestDatabase = Awaited<
  ReturnType<typeof prepareWorkspace>
>['db'];

function assertIndexedCall(db: TestDatabase): void {
  const call = db.prepare(`SELECT call_type callType,
    operation_path_expr operationPath,evidence_json evidenceJson
    FROM outbound_calls WHERE operation_path_expr=?`).get(`/${dynamicPath}`);
  expect(call).toMatchObject({
    callType: 'remote_action',
    operationPath: `/${dynamicPath}`,
  });
  expect(parseRecord(String(call?.evidenceJson))).toMatchObject({
    odataPathIntent: {
      kind: 'unknown',
      hasQueryString: false,
      pathWithoutQuery: `/${dynamicPath}`,
      placeholderKeys: [complexKey],
    },
  });
}

function assertLinkedDynamic(db: TestDatabase, workspaceId: number): void {
  linkWorkspace(db, workspaceId);
  const stored = db.prepare(`SELECT edge.edge_type edgeType,
    edge.status status,edge.to_kind toKind,
    edge.unresolved_reason unresolvedReason
    FROM graph_edges edge JOIN outbound_calls call
      ON edge.from_kind='call' AND edge.from_id=CAST(call.id AS TEXT)
    WHERE call.operation_path_expr=?`).get(`/${dynamicPath}`);
  expect(stored).toMatchObject({
    edgeType: 'DYNAMIC_EDGE_CANDIDATE',
    status: 'dynamic',
    toKind: 'operation_candidate',
  });
  expect(String(stored?.unresolvedReason)).toContain(
    `missing_variable:${complexKey}`,
  );
}

function assertStrictProjection(db: TestDatabase, workspaceId: number): void {
  const start = { repo: 'facade-service', operation: 'runFlow' };
  const strict = trace(db, start, { depth: 8, workspaceId });
  expect(strict.diagnostics).toContainEqual(expect.objectContaining({
    code: 'trace_runtime_variables_missing',
    missingVariables: [complexKey],
  }));
  const diagnostic = compactTrace(
    db, start, { depth: 8, workspaceId },
  ).diagnostics.find((row) => row[2] === 'trace_runtime_variables_missing');
  expect(diagnostic?.[6]).toMatchObject({
    missingVariableNames: [complexKey],
    missingVariableCount: 1,
    shownMissingVariableCount: 1,
    omittedMissingVariableCount: 0,
  });
}

function assertRuntimeResolution(
  db: TestDatabase,
  workspaceId: number,
): void {
  const start = { repo: 'facade-service', operation: 'runFlow' };
  const wrong = trace(db, start, {
    depth: 8, workspaceId, vars: { 'tenantInfo.region': 'lookup' },
  });
  expect(wrong.edges.some((edge) =>
    edge.type === 'remote_action'
    && String(edge.to).includes('/TargetService/lookup'))).toBe(false);
  const resolved = trace(db, start, {
    depth: 8, workspaceId, vars: { [complexKey]: 'lookup' },
  });
  const operation = resolved.edges.find((edge) =>
    edge.type === 'remote_action'
    && String(edge.to).includes('/TargetService/lookup'));
  expect(operation).toBeDefined();
  expect(resolved.edges.some((edge) =>
    edge.type === 'local_symbol_call'
    && String(edge.from).includes('lookupLeaf'))).toBe(true);
}

async function verifyComplexDynamicFlow(): Promise<void> {
  const root = await mkdtemp(path.join(
    os.tmpdir(), 'service-flow-complex-get-',
  ));
  await Promise.all([writeCaller(root), writeTarget(root)]);
  const { db, workspaceId } = await prepareWorkspace(root);
  try {
    assertIndexedCall(db);
    assertLinkedDynamic(db, workspaceId);
    assertStrictProjection(db, workspaceId);
    assertRuntimeResolution(db, workspaceId);
  } finally {
    db.close();
  }
}

describe('complex dynamic GET operation flow', () => {
  it('keeps the full key dynamic and resolves only its exact supplied value',
    verifyComplexDynamicFlow);
});
