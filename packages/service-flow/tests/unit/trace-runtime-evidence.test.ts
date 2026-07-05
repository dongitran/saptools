import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { linkWorkspace, trace } from '../../src/index.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';

async function createRuntimeResolutionFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'facade-service/.git-fixture');
  await writeFixtureFile(root, 'facade-service/package.json', JSON.stringify({ name: '@neutral/facade-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'facade-service/srv/facade.cds', 'service FacadeService { action runFlow(); }');
  await writeFixtureFile(root, 'facade-service/srv/FlowHandler.ts', `import cds from '@sap/cds';
import { Handler, Action } from 'cds-routing-handlers';
@Handler()
export class FlowHandler {
  @Action('runFlow')
  async runFlow(tenant: string, operationName: string): Promise<void> {
    const remoteClient = await cds.connect.to(\`target_\${tenant}\`, { credentials: { destination: \`dest_\${tenant}\`, path: \`/\${tenant}Service\` } });
    await remoteClient.send({ method: 'POST', path: \`/\${operationName}\`, data: {} });
  }
}
`);
  await writeFixtureFile(root, 'facade-service/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { FlowHandler } from './FlowHandler.js';\ncreateCombinedHandler({ handler: [FlowHandler] });\n");
  await writeFixtureFile(root, 'target-service/.git-fixture');
  await writeFixtureFile(root, 'target-service/package.json', JSON.stringify({ name: '@neutral/target-service', version: '1.0.0' }));
  await writeFixtureFile(root, 'target-service/srv/target.cds', 'service TargetService { action execute(); }');
  await writeFixtureFile(root, 'target-service/srv/TargetHandler.ts', "import { Handler, Action } from 'cds-routing-handlers';\n@Handler()\nexport class TargetHandler {\n  @Action('execute')\n  execute(): void {}\n}\n");
  await writeFixtureFile(root, 'target-service/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { TargetHandler } from './TargetHandler.js';\ncreateCombinedHandler({ handler: [TargetHandler] });\n");
}

describe('trace runtime evidence clarity', () => {
  it('separates effective runtime resolution from persisted dynamic graph resolution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-runtime-evidence-'));
    await createRuntimeResolutionFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const stored = db.prepare("SELECT e.status status,e.to_kind targetKind,e.unresolved_reason unresolvedReason FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.operation_path_expr='/${operationName}'").get() as { status: string; targetKind: string; unresolvedReason: string };
    expect(stored).toMatchObject({ status: 'dynamic', targetKind: 'operation_candidate' });
    expect(stored.unresolvedReason).toContain('missing_variable:operationName');
    expect(stored.unresolvedReason).toContain('missing_variable:tenant');

    const unresolved = trace(db, { repo: 'facade-service', operation: 'runFlow' }, { depth: 5 });
    expect(unresolved.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
      suggestions: ['--var operationName=<value>', '--var tenant=<value>'],
    }));

    const result = trace(db, { repo: 'facade-service', operation: 'runFlow' }, {
      depth: 5,
      vars: { tenant: 'Target', operationName: 'execute' },
    });
    const edge = result.edges.find((item) => item.type === 'remote_action' && String(item.to).includes('/TargetService/execute'));
    expect(edge?.unresolvedReason).toBeUndefined();
    expect(edge?.evidence).toMatchObject({
      effectiveResolution: {
        status: 'resolved',
        targetKind: 'operation',
        targetRepo: 'target-service',
        targetServicePath: '/TargetService',
        targetOperationPath: '/execute',
        targetOperation: 'execute',
      },
      persistedResolution: {
        status: 'dynamic',
        targetKind: 'operation_candidate',
        edgeType: 'DYNAMIC_EDGE_CANDIDATE',
      },
      runtimeSubstitutions: {
        operationPath: { supplied: ['operationName'], missing: [], effective: '/execute' },
        servicePath: { supplied: ['tenant'], missing: [], effective: '/TargetService' },
      },
      linker: { status: 'resolved' },
    });
    expect(edge?.evidence).not.toHaveProperty('runtimeResolvedCandidate');
    expect(result.edges.some((item) => item.type === 'operation_implemented_by_handler' && String(item.to).includes('TargetHandler.execute'))).toBe(true);
    expect(renderTraceTable(result)).toContain('/TargetService/execute');
    expect(renderMermaid(result)).toContain('/TargetService/execute');
    db.close();
  });
});
