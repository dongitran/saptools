import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { linkWorkspace, trace } from '../../src/index.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

async function createDynamicTargetFixture(
  root: string,
  includeBetaRequire: boolean,
): Promise<void> {
  const requires: Record<string, unknown> = {
    svc_alpha_process: {
      kind: 'odata',
      credentials: {
        destination: 'svc_alpha_process',
        path: '/AlphaProcessService',
      },
    },
  };
  if (includeBetaRequire) {
    requires.svc_beta_process = {
      kind: 'odata',
      credentials: {
        destination: 'svc_beta_process',
        path: '/BetaProcessService',
      },
    };
  }
  await writeFixtureFile(root, 'gateway-app/.git-fixture');
  await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
    name: '@neutral/gateway-app',
    version: '1.0.0',
    cds: { requires },
  }));
  await writeFixtureFile(root, 'gateway-app/srv/gateway.cds', 'service GatewayService { action runDynamicFlow(); }');
  await writeFixtureFile(root, 'gateway-app/srv/GatewayHandler.ts', `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class GatewayHandler {
  @Action('runDynamicFlow')
  async runDynamicFlow(domainName: string, domainCode: string): Promise<void> {
    const client = await cds.connect.to(\`svc_\${domainCode}_process\`, {
      credentials: {
        destination: \`svc_\${domainCode}_process\`,
        path: \`/\${domainName}ProcessService\`,
      },
    });
    await client.send({ method: 'POST', path: '/collectPaths', data: {} });
  }
}
`);
  await writeFixtureFile(root, 'gateway-app/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { GatewayHandler } from './GatewayHandler.js';\ncreateCombinedHandler({ handler: [GatewayHandler] });\n");
  await createProcessService(root, 'alpha-process', '@neutral/alpha-process', 'AlphaProcessService', 'AlphaHandler');
  await createProcessService(root, 'beta-process', '@neutral/beta-process', 'BetaProcessService', 'BetaHandler');
}

async function createProcessService(
  root: string,
  repo: string,
  packageName: string,
  serviceName: string,
  handlerName: string,
): Promise<void> {
  await writeFixtureFile(root, `${repo}/.git-fixture`);
  await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({ name: packageName, version: '1.0.0' }));
  await writeFixtureFile(root, `${repo}/srv/process.cds`, `service ${serviceName} { action collectPaths(); }`);
  await writeFixtureFile(root, `${repo}/srv/${handlerName}.ts`, `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class ${handlerName} {
  @Action('collectPaths')
  async collectPaths(): Promise<void> {}
}
`);
  await writeFixtureFile(root, `${repo}/srv/server.ts`, `import { createCombinedHandler } from 'cds-routing-handlers';
import { ${handlerName} } from './${handlerName}.js';
createCombinedHandler({ handler: [${handlerName}] });
`);
}

async function prepareDynamicTargetWorkspace(
  includeBetaRequire: boolean,
): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-dynamic-target-'));
  await createDynamicTargetFixture(root, includeBetaRequire);
  return prepareWorkspace(root);
}

function missingRuntimeDiagnostic(result: ReturnType<typeof trace>): Row {
  return record(result.diagnostics.find((item) =>
    item.code === 'trace_runtime_variables_missing'));
}

describe('dynamic runtime target exploration', () => {
  it('keeps explicit runtime variable resolution and traverses the handler', async () => {
    const { db, workspaceId } = await prepareDynamicTargetWorkspace(true);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runDynamicFlow' }, {
      depth: 6,
      vars: { domainName: 'Beta', domainCode: 'beta' },
    });
    expect(result.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/BetaProcessService/collectPaths'
      && !edge.unresolvedReason)).toBe(true);
    expect(result.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('BetaHandler.collectPaths'))).toBe(true);
    db.close();
  });

  it('summarizes ranked dynamic candidates in strict mode without traversing them', async () => {
    const { db, workspaceId } = await prepareDynamicTargetWorkspace(true);
    linkWorkspace(db, workspaceId);
    const stored = db.prepare(`
      SELECT evidence_json evidenceJson FROM graph_edges
      WHERE edge_type='DYNAMIC_EDGE_CANDIDATE' ORDER BY id LIMIT 1
    `).get() as { evidenceJson?: string };
    const storedEvidence = record(JSON.parse(stored.evidenceJson ?? '{}'));
    const candidateScores = rows(storedEvidence.candidateScores);
    expect(candidateScores.length).toBeGreaterThan(0);
    expect(candidateScores.every((item) =>
      Array.isArray(item.reasons)
      && item.reasons.includes('operation_path_match'))).toBe(true);
    const result = trace(db, { repo: 'gateway-app', operation: 'runDynamicFlow' }, {
      depth: 6,
      maxDynamicCandidates: 2,
    });
    const diagnostic = missingRuntimeDiagnostic(result);
    expect(diagnostic).toMatchObject({
      candidateCount: 2,
      shownCandidateCount: 2,
      omittedCandidateCount: 0,
      missingVariables: ['domainCode', 'domainName'],
    });
    expect(rows(diagnostic.candidateSuggestions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        servicePath: '/AlphaProcessService',
        operationPath: '/collectPaths',
        derivedVariables: { domainName: 'Alpha', domainCode: 'alpha' },
      }),
      expect.objectContaining({
        servicePath: '/BetaProcessService',
        operationPath: '/collectPaths',
        derivedVariables: { domainName: 'Beta', domainCode: 'beta' },
      }),
    ]));
    expect(rows(diagnostic.candidateSuggestions).every((item) =>
      Array.isArray(item.reasons))).toBe(true);
    expect(String(rows(diagnostic.suggestedVarSets)[0]?.cli)).toContain('--var');
    expect(result.edges.some((edge) => edge.type === 'dynamic_candidate_branch')).toBe(false);
    expect(renderTraceTable(result)).toContain('candidates: 2 shown, 0 omitted');
    expect(renderTraceTable(result)).toContain('--var domainName=Alpha');
    db.close();
  });

  it('adds capped exploratory candidate branches in candidates mode', async () => {
    const { db, workspaceId } = await prepareDynamicTargetWorkspace(true);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runDynamicFlow' }, {
      depth: 6,
      dynamicMode: 'candidates',
      maxDynamicCandidates: 1,
    });
    const branches = result.edges.filter((edge) => edge.type === 'dynamic_candidate_branch');
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      to: '/AlphaProcessService/collectPaths',
      unresolvedReason: 'Exploratory dynamic target candidate; provide runtime variables to select it',
    });
    expect(branches[0]?.evidence).toMatchObject({
      exploratory: true,
      dynamicMode: 'candidates',
      selected: false,
      omittedCandidateCount: 1,
    });
    expect(missingRuntimeDiagnostic(result)).toMatchObject({
      candidateCount: 2,
      shownCandidateCount: 1,
      omittedCandidateCount: 1,
    });
    db.close();
  });

  it('infers and traverses a unique fully-derived dynamic candidate', async () => {
    const { db, workspaceId } = await prepareDynamicTargetWorkspace(false);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runDynamicFlow' }, {
      depth: 6,
      dynamicMode: 'infer',
      maxDynamicCandidates: 5,
    });
    const edge = result.edges.find((item) =>
      item.type === 'remote_action'
      && item.to === '/AlphaProcessService/collectPaths');
    expect(edge?.unresolvedReason).toBeUndefined();
    expect(edge?.evidence).toMatchObject({
      effectiveResolution: {
        status: 'resolved',
        targetRepo: 'alpha-process',
        targetServicePath: '/AlphaProcessService',
      },
      dynamicTargetInference: {
        status: 'resolved',
        inferredVariables: { domainName: 'Alpha', domainCode: 'alpha' },
      },
    });
    expect(result.edges.some((item) =>
      item.type === 'operation_implemented_by_handler'
      && String(item.to).includes('AlphaHandler.collectPaths'))).toBe(true);
    db.close();
  });

  it('does not infer when fully-derived candidates tie', async () => {
    const { db, workspaceId } = await prepareDynamicTargetWorkspace(true);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runDynamicFlow' }, {
      depth: 6,
      dynamicMode: 'infer',
      maxDynamicCandidates: 5,
    });
    const dynamicEdge = result.edges.find((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/${domainName}ProcessService/collectPaths');
    expect(dynamicEdge?.to).toBe('/${domainName}ProcessService/collectPaths');
    expect(dynamicEdge?.unresolvedReason).toContain('runtime variables');
    expect(dynamicEdge?.evidence).toMatchObject({
      dynamicTargetInference: {
        status: 'ambiguous',
        reason: 'candidate_tied_with_equal_score',
      },
    });
    const candidates = rows(record(dynamicEdge?.evidence).dynamicTargetCandidates);
    expect(candidates.some((candidate) =>
      Array.isArray(candidate.rejectedReasons)
      && candidate.rejectedReasons.includes('candidate_tied_with_equal_score'))).toBe(true);
    expect(JSON.stringify(dynamicEdge?.evidence)).toContain('candidate_tied_with_equal_score');
    expect(result.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/AlphaProcessService/collectPaths')).toBe(false);
    db.close();
  });
});
