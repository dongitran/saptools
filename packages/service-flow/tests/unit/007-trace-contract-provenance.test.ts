import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : {};
}

function records(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

async function writePackage(
  root: string,
  repository: string,
  packageName: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFixtureFile(root, `${repository}/.git-fixture`);
  await writeFixtureFile(root, `${repository}/package.json`, JSON.stringify({
    name: packageName,
    version: '1.0.0',
  }));
  await Promise.all(Object.entries(files).map(([file, content]) =>
    writeFixtureFile(root, `${repository}/${file}`, content)));
}

async function writeTarget(
  root: string,
  repository: string,
  packageName: string,
  serviceName: string,
): Promise<void> {
  await writePackage(root, repository, packageName, {
    'srv/service.cds': `service ${serviceName} { action execute(); }`,
    'srv/TargetHandler.ts': `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class TargetHandler {
  @Action('execute')
  async execute(): Promise<void> {}
}`,
    'srv/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { TargetHandler } from './TargetHandler.js';
createCombinedHandler({ handler: [TargetHandler] });`,
  });
}

async function writeContextualRoutingWorkspace(root: string): Promise<void> {
  await writePackage(root, 'gateway-app', '@neutral/gateway-app', {
    'srv/gateway.cds': 'service GatewayService { action start(); action ambiguous(); }',
    'srv/GatewayHandler.ts': `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class GatewayHandler {
  @Action('start')
  async start(tenant: string, code: string): Promise<void> {
    const { client } = await this.openClient(tenant, code);
    await client.send({ method: 'POST', path: '/execute', data: {} });
  }

  openClient = async (tenant: string, code: string): Promise<{ client: unknown }> => {
    const client = await cds.connect.to(\`target_\${code}_service\`, {
      credentials: {
        destination: \`target_\${code}_service\`,
        path: \`/\${tenant}Service\`,
      },
    });
    return { client };
  };

  @Action('ambiguous')
  async ambiguous(tenant: string, code: string, alternate: boolean): Promise<void> {
    let client = await cds.connect.to(\`target_\${code}_service\`, {
      credentials: { destination: \`target_\${code}_service\`, path: \`/\${tenant}Service\` },
    });
    if (alternate) client = await cds.connect.to(\`backup_\${code}_service\`, {
      credentials: { destination: \`backup_\${code}_service\`, path: \`/\${tenant}Service\` },
    });
    await client.send({ method: 'POST', path: '/execute', data: {} });
  }
}`,
    'srv/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { GatewayHandler } from './GatewayHandler.js';
createCombinedHandler({ handler: [GatewayHandler] });`,
  });
  await writeTarget(
    root,
    'target-alpha-service',
    '@neutral/target_alpha_service',
    'AlphaService',
  );
  await writeTarget(
    root,
    'target-beta-service',
    '@neutral/target_beta_service',
    'BetaService',
  );
}

async function prepareContextualRoutingWorkspace(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-trace-context-'));
  await writeContextualRoutingWorkspace(root);
  return prepareWorkspace(root);
}

function traceEdge(
  result: ReturnType<typeof trace>,
  type: string,
): ReturnType<typeof trace>['edges'][number] | undefined {
  return result.edges.find((edge) => edge.type === type);
}

function currentMissingReason(key: string): string {
  return `Dynamic target is missing runtime variables: ${key}`;
}

async function writeImplementationProvenanceWorkspace(root: string): Promise<void> {
  await writePackage(root, 'decision-service', '@neutral/decision-service', {
    'srv/decision.cds': 'service DecisionService { action approve(); }',
    'srv/ARejectedHandler.ts': `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class ARejectedHandler {
  @Action('differentOperation')
  async approve(): Promise<void> {}
}`,
    'srv/SelectedHandler.ts': `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class SelectedHandler {
  @Action('approve')
  async approve(): Promise<void> {}
}`,
    'srv/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { ARejectedHandler } from './ARejectedHandler.js';
import { SelectedHandler } from './SelectedHandler.js';
createCombinedHandler({ handler: [ARejectedHandler, SelectedHandler] });`,
  });
}

async function prepareImplementationProvenanceWorkspace(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-handler-provenance-'));
  await writeImplementationProvenanceWorkspace(root);
  return prepareWorkspace(root);
}

describe('trace-time contextual runtime diagnostics', () => {
  it('uses post-substitution missing keys consistently without erasing contextual provenance', async () => {
    const { db, workspaceId } = await prepareContextualRoutingWorkspace();
    linkWorkspace(db, workspaceId);

    const withoutVariables = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
    });
    const strictEdge = traceEdge(withoutVariables, 'remote_action');
    expect(strictEdge?.unresolvedReason).toBe(
      'Dynamic target is missing runtime variables: code, tenant',
    );
    expect(record(record(strictEdge?.evidence).dynamicTargetExploration)
      .missingVariables).toEqual(['code', 'tenant']);
    expect(trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      dynamicMode: 'infer',
    }).edges.some((edge) =>
      edge.type === 'remote_action' && !edge.unresolvedReason)).toBe(false);

    const partial = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha' },
    });
    const partialEdge = traceEdge(partial, 'remote_action');
    const partialEvidence = record(partialEdge?.evidence);
    expect(partialEdge?.unresolvedReason).toBe(currentMissingReason('code'));
    expect(record(partialEvidence.effectiveResolution).unresolvedReason)
      .toBe(currentMissingReason('code'));
    expect(record(partialEvidence.linker).reason).toBe(currentMissingReason('code'));
    expect(record(partialEvidence.contextualPreSubstitutionState)).toMatchObject({
      category: 'dynamic_missing',
      missingVariables: ['code', 'tenant'],
    });
    expect(record(partialEvidence.dynamicTargetExploration)).toMatchObject({
      missingVariables: ['code'],
      candidateCount: 2,
      viableCandidateCount: 1,
      rejectedCandidateCount: 1,
    });
    const partialJson = record(JSON.parse(renderTraceJson(partial)) as unknown);
    const jsonEdge = records(partialJson.edges).find((edge) =>
      edge.type === 'remote_action');
    expect(jsonEdge?.unresolvedReason).toBe(currentMissingReason('code'));
    const partialTable = renderTraceTable(partial);
    const tableDiagnostic = partialTable.split('\n').find((line) =>
      line.includes('Runtime variables are required to resolve dynamic trace targets:'));
    expect(tableDiagnostic).toContain(
      'Runtime variables are required to resolve dynamic trace targets: code',
    );
    expect(tableDiagnostic).not.toContain('tenant');

    const candidates = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha' },
      dynamicMode: 'candidates',
      maxDynamicCandidates: 1,
    });
    const candidateEdge = traceEdge(candidates, 'remote_action');
    expect(candidateEdge?.unresolvedReason).toBe(currentMissingReason('code'));
    expect(record(record(candidateEdge?.evidence).effectiveResolution)
      .unresolvedReason).toBe(currentMissingReason('code'));
    expect(record(record(candidateEdge?.evidence).dynamicTargetExploration))
      .toMatchObject({
        candidateCount: 2,
        viableCandidateCount: 1,
        rejectedCandidateCount: 1,
        shownCandidateCount: 1,
        omittedCandidateCount: 0,
      });
    expect(candidates.edges.filter((edge) =>
      edge.type === 'dynamic_candidate_branch')).toHaveLength(1);

    const inferred = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha' },
      dynamicMode: 'infer',
    });
    const inferredEdge = traceEdge(inferred, 'remote_action');
    expect(inferredEdge?.to).toBe('/AlphaService/execute');
    expect(inferredEdge?.unresolvedReason).toBeUndefined();
    expect(record(record(inferredEdge?.evidence).effectiveResolution)
      .unresolvedReason).toBeUndefined();
    expect(record(record(inferredEdge?.evidence).linker).reason).toBeUndefined();
    expect(inferred.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && edge.to.includes('TargetHandler.execute'))).toBe(true);

    const explicit = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha', code: 'alpha' },
    });
    expect(traceEdge(explicit, 'remote_action')?.unresolvedReason).toBeUndefined();

    const incompatible = trace(db, { repo: 'gateway-app', operation: 'start' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha', code: 'wrong' },
    });
    const incompatibleEdge = traceEdge(incompatible, 'remote_action');
    expect(incompatibleEdge?.unresolvedReason)
      .toBe('No candidate remained after runtime substitution');
    expect(incompatible.diagnostics).toContainEqual(expect.objectContaining({
      code: 'no_candidate_after_runtime_substitution',
    }));
    expect(incompatible.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && edge.to.includes('TargetHandler.execute'))).toBe(false);
    db.close();
  });

  it('keeps ambiguous contextual bindings structurally blocked after runtime input', async () => {
    const { db, workspaceId } = await prepareContextualRoutingWorkspace();
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'ambiguous' }, {
      depth: 5,
      workspaceId,
      vars: { tenant: 'Alpha', code: 'alpha' },
      dynamicMode: 'infer',
    });
    const edge = traceEdge(result, 'remote_action');
    expect(edge?.unresolvedReason).toBe(
      'Ambiguous contextual service binding candidates',
    );
    expect(record(record(edge?.evidence).contextualPreSubstitutionState))
      .toMatchObject({ category: 'ambiguous_binding' });
    expect(record(record(edge?.evidence).effectiveResolution).contextualBlocker)
      .toMatchObject({ category: 'ambiguous_binding' });
    expect(edge?.to).not.toBe('/AlphaService/execute');
    db.close();
  });
});

describe('selected implementation handler provenance', () => {
  it('renders the resolved graph target rather than a higher-ranked rejected candidate', async () => {
    const { db, workspaceId } = await prepareImplementationProvenanceWorkspace();
    linkWorkspace(db, workspaceId);
    const persisted = record(db.prepare(`SELECT id,to_id toId,evidence_json evidenceJson
      FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'`).get());
    const persistedEvidence = record(JSON.parse(String(persisted.evidenceJson ?? '{}')) as unknown);
    const selectedMethod = record(db.prepare(`SELECT hm.id methodId,hm.method_name methodName,
      hm.source_line sourceLine,hc.class_name className,hc.source_file sourceFile
      FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
      WHERE hc.class_name='SelectedHandler'`).get());
    const rejectedMethod = record(db.prepare(`SELECT hm.id methodId,hm.source_line sourceLine,
      hc.source_file sourceFile FROM handler_methods hm
      JOIN handler_classes hc ON hc.id=hm.handler_class_id
      WHERE hc.class_name='ARejectedHandler'`).get());
    expect(persisted.toId).toBe(String(selectedMethod.methodId));
    expect(records(persistedEvidence.candidates)).toEqual([
      expect.objectContaining({ methodId: selectedMethod.methodId, selected: true, displayRank: 1 }),
      expect.objectContaining({ methodId: rejectedMethod.methodId, accepted: false, displayRank: 2 }),
    ]);
    expect(record(persistedEvidence.selectedHandler)).toMatchObject({
      status: 'selected',
      accepted: true,
      methodId: selectedMethod.methodId,
      className: 'SelectedHandler',
      methodName: 'approve',
      repository: { name: 'decision-service', packageName: '@neutral/decision-service' },
      sourceFile: selectedMethod.sourceFile,
      sourceLine: selectedMethod.sourceLine,
    });

    const result = trace(db, {
      repo: 'decision-service',
      servicePath: '/DecisionService',
      operation: 'approve',
    }, {
      depth: 4,
      workspaceId,
    });
    const edge = traceEdge(result, 'operation_implemented_by_handler');
    const traceEvidence = record(edge?.evidence);
    expect(record(traceEvidence.selectedHandler)).toMatchObject({
      methodId: selectedMethod.methodId,
      className: 'SelectedHandler',
      sourceFile: selectedMethod.sourceFile,
      sourceLine: selectedMethod.sourceLine,
    });
    expect(records(traceEvidence.candidates)).toEqual(
      records(persistedEvidence.candidates),
    );
    const table = renderTraceTable(result);
    expect(table).toContain(`${String(selectedMethod.sourceFile)}:${String(selectedMethod.sourceLine)}`);
    expect(table).not.toContain(`${String(rejectedMethod.sourceFile)}:${String(rejectedMethod.sourceLine)}`);
    expect(renderMermaid(result)).toContain('SelectedHandler.approve');

    db.prepare('UPDATE graph_edges SET evidence_json=? WHERE id=?').run(
      JSON.stringify({
        ...persistedEvidence,
        selectedHandler: {
          ...record(persistedEvidence.selectedHandler),
          methodId: rejectedMethod.methodId,
          sourceFile: rejectedMethod.sourceFile,
          sourceLine: rejectedMethod.sourceLine,
        },
      }),
      persisted.id,
    );
    const reconciled = trace(db, {
      repo: 'decision-service',
      servicePath: '/DecisionService',
      operation: 'approve',
    }, {
      depth: 4,
      workspaceId,
    });
    const reconciledEdge = traceEdge(reconciled, 'operation_implemented_by_handler');
    expect(record(record(reconciledEdge?.evidence).selectedHandler)).toMatchObject({
      methodId: selectedMethod.methodId,
      sourceFile: selectedMethod.sourceFile,
    });
    expect(record(record(reconciledEdge?.evidence).selectedHandlerProvenanceAudit))
      .toMatchObject({ status: 'mismatch' });
    expect(renderTraceTable(reconciled)).toContain(
      `${String(selectedMethod.sourceFile)}:${String(selectedMethod.sourceLine)}`,
    );
    db.close();
  });
});
