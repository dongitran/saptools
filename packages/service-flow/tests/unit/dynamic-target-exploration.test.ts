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

const boundedDynamicArrayKeys = new Set([
  'candidates',
  'candidateScores',
  'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions',
  'candidateSuggestions',
  'suggestedVarSets',
  'rejectedCandidates',
  'rejectedCandidateSuggestions',
  'copyableExamples',
]);

function boundedDynamicArrays(
  value: unknown,
  pathPrefix = '$',
): Array<{ path: string; length: number }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      boundedDynamicArrays(item, `${pathPrefix}[${index}]`));
  }
  const object = record(value);
  return Object.entries(object).flatMap(([key, item]) => {
    const itemPath = `${pathPrefix}.${key}`;
    const current = Array.isArray(item) && boundedDynamicArrayKeys.has(key)
      ? [{ path: itemPath, length: item.length }]
      : [];
    return [...current, ...boundedDynamicArrays(item, itemPath)];
  });
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

async function createIdentityDynamicTargetFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'gateway-app/.git-fixture');
  await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
    name: '@neutral/gateway-app',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, 'gateway-app/srv/gateway.cds', 'service GatewayService { action runIdentityFlow(); }');
  await writeIdentityGatewayHandler(root, 'worker_${entityCode}_process');
  await writeFixtureFile(root, 'gateway-app/srv/server.ts', "import { createCombinedHandler } from 'cds-routing-handlers';\nimport { GatewayHandler } from './GatewayHandler.js';\ncreateCombinedHandler({ handler: [GatewayHandler] });\n");
  await createProcessService(
    root,
    'worker-or-process',
    '@neutral/worker_or_process',
    'OrderProcessService',
    'OrderHandler',
  );
  await createProcessService(
    root,
    'worker-in-process',
    '@neutral/worker_in_process',
    'InvoiceProcessService',
    'InvoiceHandler',
  );
}

async function writeIdentityGatewayHandler(
  root: string,
  routeTemplate: string,
): Promise<void> {
  const routeExpression = `\`${routeTemplate}\``;
  await writeFixtureFile(root, 'gateway-app/srv/GatewayHandler.ts', `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class GatewayHandler {
  @Action('runIdentityFlow')
  async runIdentityFlow(entityName: string, entityCode: string): Promise<void> {
    const client = await cds.connect.to(${routeExpression}, {
      credentials: {
        destination: ${routeExpression},
        path: \`/\${entityName}ProcessService\`,
      },
    });
    await client.send({ method: 'POST', path: '/collectPaths', data: {} });
  }
}
`);
}

async function prepareIdentityDynamicTargetWorkspace(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-dynamic-identity-'));
  await createIdentityDynamicTargetFixture(root);
  return prepareWorkspace(root);
}

async function prepareIdentityVariantWorkspace(
  mutate: (root: string) => Promise<void>,
): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-dynamic-variant-'));
  await createIdentityDynamicTargetFixture(root);
  await mutate(root);
  return prepareWorkspace(root);
}

function missingRuntimeDiagnostic(result: ReturnType<typeof trace>): Row {
  return record(result.diagnostics.find((item) =>
    item.code === 'trace_runtime_variables_missing'));
}

function diagnosticByCode(result: ReturnType<typeof trace>, code: string): Row {
  return record(result.diagnostics.find((item) => item.code === code));
}

function dynamicEvidence(result: ReturnType<typeof trace>): Row {
  const edge = result.edges.find((item) =>
    Object.keys(record(record(item.evidence).dynamicTargetExploration)).length > 0);
  return record(edge?.evidence);
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
      Array.isArray(candidate.inferenceBlockReasons)
      && candidate.inferenceBlockReasons.includes('candidate_tied_with_equal_score'))).toBe(true);
    expect(JSON.stringify(dynamicEdge?.evidence)).toContain('candidate_tied_with_equal_score');
    expect(result.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/AlphaProcessService/collectPaths')).toBe(false);
    db.close();
  });

  it('narrows partial substitutions before counting candidates', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const strict = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      maxDynamicCandidates: 5,
    });
    const strictDiagnostic = missingRuntimeDiagnostic(strict);
    expect(strictDiagnostic).toMatchObject({
      candidateCount: 2,
      viableCandidateCount: 1,
      rejectedCandidateCount: 1,
      shownCandidateCount: 1,
      omittedCandidateCount: 0,
    });
    expect(rows(strictDiagnostic.candidateSuggestions)).toEqual([
      expect.objectContaining({
        servicePath: '/OrderProcessService',
        operationPath: '/collectPaths',
      }),
    ]);
    expect(rows(strictDiagnostic.suggestedVarSets)).toContainEqual(
      expect.objectContaining({
        variables: { entityName: 'Order', entityCode: 'or' },
        cli: '--var entityName=Order --var entityCode=or',
      }),
    );
    expect(strict.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('OrderHandler.collectPaths'))).toBe(false);
    db.close();
  });

  it('branches only to candidates viable after partial substitution', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const candidates = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'candidates',
      maxDynamicCandidates: 5,
    });
    const branches = candidates.edges.filter((edge) =>
      edge.type === 'dynamic_candidate_branch');
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      to: '/OrderProcessService/collectPaths',
      evidence: {
        viable: true,
        rejected: false,
        exploratory: true,
        selected: false,
      },
    });
    expect(branches.some((edge) =>
      String(edge.to).includes('/InvoiceProcessService'))).toBe(false);
    db.close();
  });

  it('infers an identity-only variable with exact generic provenance', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
      maxDynamicCandidates: 5,
    });
    const edge = result.edges.find((item) =>
      item.type === 'remote_action'
      && item.to === '/OrderProcessService/collectPaths');
    expect(edge?.unresolvedReason).toBeUndefined();
    expect(edge?.evidence).toMatchObject({
      dynamicTargetInference: {
        status: 'resolved',
      },
    });
    expect(record(record(edge?.evidence).dynamicTargetInference).inferredVariables)
      .toMatchObject({ entityCode: 'or' });
    const selected = rows(record(edge?.evidence).dynamicTargetCandidates)
      .find((candidate) => candidate.selected === true);
    expect(selected).toMatchObject({
      repoName: 'worker-or-process',
      packageName: '@neutral/worker_or_process',
      servicePath: '/OrderProcessService',
      viable: true,
      rejected: false,
      selected: true,
      derivedVariables: { entityCode: 'or' },
    });
    const provenance = record(record(selected?.derivedVariableSources).entityCode);
    expect(String(provenance.sourceKind)).toMatch(/identity/);
    expect([
      '@neutral/worker_or_process',
      'worker-or-process',
    ]).toContain(provenance.matchedName);
    expect(provenance.normalizedForm ?? provenance.normalizedName).toBe('worker_or_process');
    expect(String(provenance.rule ?? provenance.normalizationRule)).toMatch(/exact.*identity|identity.*exact/);
    expect(result.edges.some((item) =>
      item.type === 'operation_implemented_by_handler'
      && String(item.to).includes('OrderHandler.collectPaths'))).toBe(true);
    db.close();
  });

  it('reports a no-match diagnostic for a conflicting explicit identity value', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order', entityCode: 'wrong' },
      dynamicMode: 'infer',
      maxDynamicCandidates: 2,
    });
    const diagnostic = diagnosticByCode(
      result,
      'no_candidate_after_runtime_substitution',
    );
    expect(diagnostic).toMatchObject({
      code: 'no_candidate_after_runtime_substitution',
      suppliedVariables: { entityName: 'Order', entityCode: 'wrong' },
      candidateCount: 2,
      viableCandidateCount: 0,
      rejectedCandidateCount: 2,
    });
    const substituted = JSON.stringify(diagnostic.substitutedSignals);
    expect(substituted).toContain('/OrderProcessService');
    expect(substituted).toContain('worker_wrong_process');
    expect(result.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/OrderProcessService/collectPaths'
      && !edge.unresolvedReason)).toBe(false);
    expect(result.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('OrderHandler.collectPaths'))).toBe(false);
    db.close();
  });

  it('bounds every dynamic candidate array in trace JSON', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'candidates',
      maxDynamicCandidates: 1,
    });
    const diagnostic = missingRuntimeDiagnostic(result);
    const machineOutput = JSON.parse(JSON.stringify({
      evidence: dynamicEvidence(result),
      diagnostic,
    })) as unknown;
    const exposedArrays = boundedDynamicArrays(machineOutput);
    expect(exposedArrays.some((item) =>
      item.path.endsWith('.candidateScores'))).toBe(true);
    expect(exposedArrays.filter((item) => item.length > 1)).toEqual([]);
    expect(exposedArrays.some((item) =>
      item.path.endsWith('.rejectedCandidates'))).toBe(true);
    expect(diagnostic).toMatchObject({
      candidateCount: 2,
      viableCandidateCount: 1,
      rejectedCandidateCount: 1,
      shownCandidateCount: 1,
      omittedCandidateCount: 0,
    });
    expect(result.edges.filter((edge) =>
      edge.type === 'dynamic_candidate_branch')).toHaveLength(1);
    db.close();
  });

  it('refuses inference when exact require and identity derivations conflict', async () => {
    const { db, workspaceId } = await prepareIdentityVariantWorkspace(async (root) => {
      await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
        name: '@neutral/gateway-app',
        version: '1.0.0',
        cds: { requires: {
          worker_alt_process: {
            kind: 'odata',
            credentials: {
              destination: 'worker_alt_process',
              path: '/OrderProcessService',
            },
          },
        } },
      }));
    });
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
    });
    const evidence = dynamicEvidence(result);
    const rejected = rows(record(evidence.dynamicTargetExploration).rejectedCandidates);
    const candidate = rejected.find((item) => item.repoName === 'worker-or-process');
    const conflict = rows(candidate?.conflicts)[0];
    expect(conflict).toMatchObject({
      key: 'entityCode',
      values: ['alt', 'or'],
      reason: 'conflicting_strong_derivations',
    });
    expect(conflict?.sources).toEqual(expect.arrayContaining([
      'cds_require.alias',
      'package_identity',
    ]));
    expect(record(evidence.dynamicTargetInference).status).not.toBe('resolved');
    expect(result.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('OrderHandler.collectPaths'))).toBe(false);
    db.close();
  });

  it('refuses identity fallback when package identities are duplicated', async () => {
    const { db, workspaceId } = await prepareIdentityVariantWorkspace(async (root) => {
      await writeFixtureFile(root, 'worker-in-process/package.json', JSON.stringify({
        name: '@neutral/worker_or_process',
        version: '1.0.0',
      }));
    });
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
    });
    const evidence = dynamicEvidence(result);
    const candidate = rows(evidence.dynamicTargetCandidates)
      .find((item) => item.repoName === 'worker-or-process');
    expect(candidate).toMatchObject({
      missingVariables: ['entityCode'],
      completeVariables: { entityName: 'Order' },
      derivedVariables: {},
      selected: false,
    });
    expect(record(candidate?.derivedVariableSources)).not.toHaveProperty('entityCode');
    expect(record(evidence.dynamicTargetInference)).toMatchObject({
      status: 'unresolved',
      reason: 'missing_required_runtime_variable',
    });
    db.close();
  });

  it('keeps a bare identity template unresolved without literal boundaries', async () => {
    const { db, workspaceId } = await prepareIdentityVariantWorkspace(async (root) => {
      await writeIdentityGatewayHandler(root, '${entityCode}');
    });
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'runIdentityFlow' }, {
      depth: 6,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
    });
    const evidence = dynamicEvidence(result);
    const candidate = rows(evidence.dynamicTargetCandidates)
      .find((item) => item.repoName === 'worker-or-process');
    expect(candidate).toMatchObject({
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(record(candidate?.derivedVariableSources)).not.toHaveProperty('entityCode');
    expect(record(evidence.dynamicTargetInference).status).not.toBe('resolved');
    db.close();
  });

  it('resolves both entry selectors in memory without mutating the dynamic row', async () => {
    const { db, workspaceId } = await prepareIdentityDynamicTargetWorkspace();
    linkWorkspace(db, workspaceId);
    const snapshot = (): Row => record(db.prepare(`
      SELECT id,edge_type edgeType,status,to_kind targetKind,to_id targetId,
        unresolved_reason unresolvedReason,evidence_json evidenceJson
      FROM graph_edges WHERE edge_type='DYNAMIC_EDGE_CANDIDATE'
      ORDER BY id LIMIT 1
    `).get());
    const before = snapshot();
    expect(before).toMatchObject({
      edgeType: 'DYNAMIC_EDGE_CANDIDATE',
      status: 'dynamic',
      targetKind: 'operation_candidate',
    });
    const options = {
      depth: 6,
      vars: { entityName: 'Order', entityCode: 'or' },
    };
    const byOperation = trace(
      db,
      { repo: 'gateway-app', operation: 'runIdentityFlow' },
      options,
    );
    expect(snapshot()).toEqual(before);
    const byPath = trace(db, {
      repo: 'gateway-app',
      servicePath: '/GatewayService',
      operationPath: '/runIdentityFlow',
    }, options);
    expect(snapshot()).toEqual(before);
    const downstreamHandler = (result: ReturnType<typeof trace>): string | undefined =>
      result.edges.find((edge) =>
        edge.type === 'operation_implemented_by_handler'
        && String(edge.to).includes('OrderHandler.collectPaths'))?.to;
    expect(downstreamHandler(byOperation)).toBe('worker-or-process:OrderHandler.collectPaths');
    expect(downstreamHandler(byPath)).toBe(downstreamHandler(byOperation));
    for (const result of [byOperation, byPath]) {
      const edge = result.edges.find((item) =>
        item.type === 'remote_action'
        && item.to === '/OrderProcessService/collectPaths');
      expect(edge?.evidence).toMatchObject({
        persistedResolution: {
          status: 'dynamic',
          edgeType: 'DYNAMIC_EDGE_CANDIDATE',
        },
        effectiveResolution: { status: 'resolved' },
      });
    }
    db.close();
  });
});
