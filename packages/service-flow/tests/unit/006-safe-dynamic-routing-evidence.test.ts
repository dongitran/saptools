import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { boundDoctorDiagnostics } from '../../src/cli/001-doctor-projection.js';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { DEFAULT_EVIDENCE_CANDIDATE_LIMIT } from '../../src/utils/000-bounded-projection.js';
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function writePackage(
  root: string,
  repo: string,
  packageName: string,
  files: Record<string, string>,
  dependencies: Record<string, string> = {},
): Promise<void> {
  await writeFixtureFile(root, `${repo}/.git-fixture`);
  await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({
    name: packageName,
    version: '1.0.0',
    dependencies,
  }));
  await Promise.all(Object.entries(files).map(([file, source]) =>
    writeFixtureFile(root, `${repo}/${file}`, source)));
}

async function writeConcreteWorker(
  root: string,
  repo: string,
  packageName: string,
  servicePath: string,
): Promise<void> {
  await writePackage(root, repo, packageName, {
    'srv/extension.cds': `using { SharedProcessService as ImportedProcess } from '@neutral/shared-model/srv/model';
extend service ImportedProcess @(path: '${servicePath}') {}`,
  }, { '@neutral/shared-model': '1.0.0' });
}

async function writeRoutingWorkspace(root: string): Promise<void> {
  await writePackage(root, 'gateway-app', '@neutral/gateway-app', {
    'srv/gateway.cds': 'service GatewayService { action startFlow(); }',
    'srv/GatewayHandler.ts': `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class GatewayHandler {
  @Action('startFlow')
  async startFlow(entityCode: string, entityName: string): Promise<void> {
    const { client } = await this.openWorker(entityCode, entityName);
    await client.send({ method: 'POST', path: '/collectPaths', data: {} });
  }

  openWorker = async (entityCode: string, entityName: string): Promise<{ client: unknown }> => {
    const client = await cds.connect.to(\`worker_\${entityCode}_process\`, {
      credentials: {
        destination: \`worker_\${entityCode}_process\`,
        path: \`/\${entityName}ProcessService\`,
      },
    });
    return { client };
  };
}`,
    'srv/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { GatewayHandler } from './GatewayHandler.js';
createCombinedHandler({ handler: [GatewayHandler] });`,
  });
  await writePackage(root, 'shared-model', '@neutral/shared-model', {
    'srv/model.cds': 'service SharedProcessService { action collectPaths(); action reviewPaths(); }',
  });
  await writeConcreteWorker(
    root,
    'worker-or-process',
    '@neutral/worker_or_process',
    '/OrderProcessService',
  );
  await writeConcreteWorker(
    root,
    'worker-in-process',
    '@neutral/worker_in_process',
    '/InvoiceProcessService',
  );
  for (const worker of additionalWorkers()) {
    await writeConcreteWorker(
      root, worker.repo, worker.packageName, worker.servicePath,
    );
  }
  await writePackage(root, 'route-helper', '@neutral/route-helper', {
    'src/RouteHandler.ts': `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class RouteHandler {
  @Action('collectPaths')
  async collectPaths(): Promise<void> {}
}`,
    'src/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { RouteHandler } from './RouteHandler.js';
createCombinedHandler({ handler: [RouteHandler] });`,
  }, { 'cds-routing-handlers': '1.0.0' });
  for (const helper of reviewHelpers()) await writeReviewHelper(root, helper);
}

function additionalWorkers(): Array<{
  repo: string;
  packageName: string;
  servicePath: string;
}> {
  return [
    { repo: 'worker-customer-process', packageName: '@neutral/worker_customer_process', servicePath: '/CustomerProcessService' },
    { repo: 'worker-product-process', packageName: '@neutral/worker_product_process', servicePath: '/ProductProcessService' },
    { repo: 'worker-shipment-process', packageName: '@neutral/worker_shipment_process', servicePath: '/ShipmentProcessService' },
    { repo: 'worker-review-process', packageName: '@neutral/worker_review_process', servicePath: '/ReviewProcessService' },
  ];
}

function reviewHelpers(): Array<{ repo: string; packageName: string; marker: string }> {
  return [
    { repo: 'review-helper-a', packageName: '@neutral/review-helper-a', marker: 'A' },
    { repo: 'review-helper-b', packageName: '@neutral/review-helper-b', marker: 'B' },
    { repo: 'review-helper-c', packageName: '@neutral/review-helper-c', marker: 'C' },
    { repo: 'review-helper-d', packageName: '@neutral/review-helper-d', marker: 'D' },
    { repo: 'review-helper-e', packageName: '@neutral/review-helper-e', marker: 'E' },
    { repo: 'review-helper-z', packageName: '@neutral/review-helper-z', marker: 'Z' },
  ];
}

async function writeReviewHelper(
  root: string,
  helper: { repo: string; packageName: string; marker: string },
): Promise<void> {
  await writePackage(root, helper.repo, helper.packageName, {
    'src/ReviewHandler.ts': `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class ReviewHandler {
  @Action('reviewPaths')
  async reviewPaths(): Promise<void> {
    await cds.run(SELECT.from(Review${helper.marker}));
  }
}`,
    'src/server.ts': `import { createCombinedHandler } from 'cds-routing-handlers';
import { ReviewHandler } from './ReviewHandler.js';
createCombinedHandler({ handler: [ReviewHandler] });`,
  }, { 'cds-routing-handlers': '1.0.0' });
}

async function prepareRoutingWorkspace(): ReturnType<typeof prepareWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-safe-routing-'));
  await writeRoutingWorkspace(root);
  return prepareWorkspace(root);
}

function runtimeDiagnostic(result: ReturnType<typeof trace>, code: string): Row {
  return record(result.diagnostics.find((item) => item.code === code));
}

const candidateArrayKeys = new Set([
  'candidates',
  'candidateScores',
  'candidateFamilies',
  'candidateEvidence',
  'candidatePaths',
  'candidateRawPaths',
  'candidateNormalizedOperationPaths',
  'normalizedCandidateOperations',
  'candidateLiterals',
  'registrations',
  'implementationHintSuggestions',
  'selectableImplementationRepositories',
  'bindingCandidates',
  'bindingAlternatives',
  'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions',
  'candidateSuggestions',
  'rejectedCandidates',
  'suggestedVarSets',
  'selectorSuggestions',
  'serviceSuggestions',
  'repositories',
  'matchedHints',
  'copyableExamples',
  'examples',
  'expandedExamples',
]);

function candidateArrayLengths(value: unknown, pathPrefix = '$'):
Array<{ path: string; length: number }> {
  if (Array.isArray(value)) return value.flatMap((item, index) =>
    candidateArrayLengths(item, `${pathPrefix}[${index}]`));
  const row = record(value);
  return Object.entries(row).flatMap(([key, item]) => {
    const path = `${pathPrefix}.${key}`;
    const own = Array.isArray(item) && candidateArrayKeys.has(key)
      ? [{ path, length: item.length }]
      : [];
    return [...own, ...candidateArrayLengths(item, path)];
  });
}

function graphEvidence(db: Db): Row[] {
  const rows = db.prepare(
    'SELECT evidence_json evidenceJson FROM graph_edges ORDER BY id',
  ).all();
  return rows.map((row) =>
    record(JSON.parse(String(row.evidenceJson ?? '{}'))));
}

describe('call-scoped dynamic routing evidence', () => {
  it('uses the selected helper-returned binding to derive route-owner identity', async () => {
    const { db, workspaceId } = await prepareRoutingWorkspace();
    linkWorkspace(db, workspaceId);
    const call = record(db.prepare(`SELECT c.service_binding_id bindingId,c.evidence_json evidenceJson,
      b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,
      b.service_path_expr servicePathExpr,b.helper_chain_json helperChainJson
      FROM outbound_calls c JOIN service_bindings b ON b.id=c.service_binding_id
      WHERE c.call_type='remote_action' ORDER BY c.id LIMIT 1`).get());
    const binding = record(record(JSON.parse(String(call.evidenceJson ?? '{}')))
      .serviceBindingResolution);
    expect(call.bindingId).toBeTypeOf('number');
    expect(binding.selectedBindingId).toBe(call.bindingId);
    expect(call).toMatchObject({
      aliasExpr: 'worker_${entityCode}_process',
      destinationExpr: 'worker_${entityCode}_process',
      servicePathExpr: '/${entityName}ProcessService',
    });
    expect(JSON.stringify(call.helperChainJson)).toContain('returnedProperty');

    const strict = trace(db, { repo: 'gateway-app', operation: 'startFlow' }, {
      depth: 6,
      workspaceId,
      vars: { entityName: 'Order' },
    });
    const strictDiagnostic = runtimeDiagnostic(
      strict,
      'trace_runtime_variables_missing',
    );
    expect(strictDiagnostic.viableCandidateCount).toBe(1);
    expect(Number(strictDiagnostic.rejectedCandidateCount)).toBeGreaterThan(0);
    const strictExploration = record(record(strict.edges.find((edge) =>
      edge.type === 'remote_action')?.evidence).dynamicTargetExploration);
    expect(strictExploration).toMatchObject({
      suggestedVarSetCount: 1,
      shownSuggestedVarSetCount: 1,
      omittedSuggestedVarSetCount: 0,
    });
    expect(records(strictExploration.suggestedVarSets)[0]).toMatchObject({
      variables: { entityName: 'Order', entityCode: 'or' },
      cli: '--var entityName=Order --var entityCode=or',
    });
    expect(strict.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('RouteHandler.collectPaths'))).toBe(false);

    const inferred = trace(db, { repo: 'gateway-app', operation: 'startFlow' }, {
      depth: 6,
      workspaceId,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
    });
    const remote = inferred.edges.find((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/OrderProcessService/collectPaths');
    expect(remote?.unresolvedReason).toBeUndefined();
    const selected = records(record(remote?.evidence).dynamicTargetCandidates)
      .find((candidate) => candidate.selected === true);
    expect(selected).toMatchObject({
      repoName: 'worker-or-process',
      derivedVariables: { entityCode: 'or' },
    });
    expect(record(record(selected?.derivedVariableSources).entityCode)).toMatchObject({
      sourceRepo: 'worker-or-process',
      rule: 'exact_normalized_identity_template_match',
    });
    expect(record(record(remote?.evidence).dynamicTargetExploration)
      .routingContext).toMatchObject({
      selectedBindingId: call.bindingId,
      bindingResolutionStatus: 'selected',
      fallbackUsed: false,
      selectedBinding: {
        aliasExpr: 'worker_${entityCode}_process',
        servicePath: '/${entityName}ProcessService',
      },
    });
    expect(inferred.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler'
      && String(edge.to).includes('RouteHandler.collectPaths'))).toBe(true);
    db.close();
  });

  it('rejects incompatible selected-binding routing values before generic resolution', async () => {
    const { db, workspaceId } = await prepareRoutingWorkspace();
    linkWorkspace(db, workspaceId);
    for (const dynamicMode of ['strict', 'candidates', 'infer'] as const) {
      const result = trace(db, { repo: 'gateway-app', operation: 'startFlow' }, {
        depth: 6,
        workspaceId,
        dynamicMode,
        vars: { entityName: 'Order', entityCode: 'wrong' },
      });
      const diagnostic = runtimeDiagnostic(
        result,
        'no_candidate_after_runtime_substitution',
      );
      expect(diagnostic).toMatchObject({
        suppliedVariables: { entityName: 'Order', entityCode: 'wrong' },
        viableCandidateCount: 0,
      });
      expect(JSON.stringify(diagnostic.substitutedSignals))
        .toContain('worker_wrong_process');
      expect(result.edges.some((edge) =>
        edge.type === 'remote_action'
        && edge.to === '/OrderProcessService/collectPaths'
        && !edge.unresolvedReason)).toBe(false);
      expect(result.edges.some((edge) =>
        edge.type === 'dynamic_candidate_branch')).toBe(false);
      expect(result.edges.some((edge) =>
        edge.type === 'operation_implemented_by_handler'
        && String(edge.to).includes('RouteHandler.collectPaths'))).toBe(false);
    }
    db.close();
  });

  it('keeps identity collisions unresolved for the concrete route owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-routing-collision-'));
    await writeRoutingWorkspace(root);
    await writeFixtureFile(root, 'worker-in-process/package.json', JSON.stringify({
      name: '@neutral/worker_or_process',
      version: '1.0.0',
      dependencies: { '@neutral/shared-model': '1.0.0' },
    }));
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app', operation: 'startFlow' }, {
      depth: 6,
      workspaceId,
      vars: { entityName: 'Order' },
      dynamicMode: 'infer',
    });
    const edge = result.edges.find((item) => item.type === 'remote_action');
    const candidates = records(record(edge?.evidence).dynamicTargetCandidates);
    const order = candidates.find((candidate) =>
      candidate.repoName === 'worker-or-process');
    expect(order).toMatchObject({
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(record(order?.derivedVariableSources)).not.toHaveProperty('entityCode');
    expect(record(record(edge?.evidence).dynamicTargetInference)).toMatchObject({
      status: 'unresolved',
      reason: 'missing_required_runtime_variable',
    });
    db.close();
  });

  it('uses canonical operation facts when the matching route is outside graph evidence', async () => {
    const { db, workspaceId } = await prepareRoutingWorkspace();
    linkWorkspace(db, workspaceId);
    const persisted = graphEvidence(db).find((evidence) =>
      evidence.selectedBindingId !== undefined
      && evidence.resolutionStatus === 'dynamic');
    expect(records(persisted?.candidates).some((candidate) =>
      candidate.repoName === 'worker-shipment-process')).toBe(false);

    const result = trace(db, { repo: 'gateway-app', operation: 'startFlow' }, {
      depth: 6,
      workspaceId,
      vars: { entityName: 'Shipment' },
      dynamicMode: 'infer',
    });
    expect(result.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/ShipmentProcessService/collectPaths'
      && !edge.unresolvedReason)).toBe(true);
    db.close();
  });

  it('caps graph and diagnostic evidence while a canonical hint selects beyond the prefix', async () => {
    const { db, workspaceId } = await prepareRoutingWorkspace();
    linkWorkspace(db, workspaceId);
    const persisted = graphEvidence(db);
    const implementation = persisted.find((evidence) =>
      evidence.servicePath === '/OrderProcessService'
      && evidence.operationPath === '/reviewPaths');
    expect(Number(implementation?.candidateCount)).toBeGreaterThan(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    expect(records(implementation?.candidates)).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    expect(Number(implementation?.omittedCandidateCount)).toBeGreaterThan(0);
    expect(records(implementation?.candidates).some((candidate) =>
      record(candidate.handlerPackage).name === 'review-helper-z')).toBe(false);

    const ambiguousStart = trace(db, {
      repo: 'worker-or-process',
      servicePath: '/OrderProcessService',
      operation: 'reviewPaths',
    }, {
      depth: 2,
      workspaceId,
    });
    const startDiagnostic = runtimeDiagnostic(ambiguousStart, 'trace_start_ambiguous');
    expect(startDiagnostic).toMatchObject({
      candidateCount: Number(implementation?.candidateCount),
      shownCandidateCount: DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
      omittedCandidateCount: Number(implementation?.omittedCandidateCount),
    });
    expect(records(startDiagnostic.candidates)).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );

    const guided = trace(db, {
      repo: 'worker-or-process',
      servicePath: '/OrderProcessService',
      operation: 'reviewPaths',
    }, {
      depth: 6,
      includeDb: true,
      workspaceId,
      implementationHints: [{
        servicePath: '/OrderProcessService',
        operationPath: '/reviewPaths',
        implementationRepo: 'review-helper-z',
      }],
    });
    expect(guided.edges.some((edge) =>
      edge.type === 'local_db_query' && edge.to === 'Entity: ReviewZ')).toBe(true);

    const doctor = doctorDiagnostics(db, true, { detail: true });
    const machineValues = [persisted, guided, doctor];
    const arrays = candidateArrayLengths(machineValues);
    expect(arrays.length).toBeGreaterThan(0);
    expect(arrays.filter((item) => item.length > DEFAULT_EVIDENCE_CANDIDATE_LIMIT))
      .toEqual([]);

    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const before = graphEvidence(db);
    linkWorkspace(db, workspaceId);
    expect(graphEvidence(db)).toEqual(before);
    db.close();
  });

  it('caps nested parser path alternatives and ambiguous graph target ids', async () => {
    const { db, workspaceId } = await prepareRoutingWorkspace();
    const paths = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
      .map((name) => `/${name}Route`);
    const call = record(db.prepare(`SELECT id FROM outbound_calls
      WHERE call_type='remote_action' ORDER BY id LIMIT 1`).get());
    db.prepare('UPDATE outbound_calls SET evidence_json=? WHERE id=?').run(
      JSON.stringify({
        parser: 'fixture',
        pathAnalysis: {
          status: 'ambiguous',
          candidateRawPaths: paths,
          candidateNormalizedOperationPaths: paths,
        },
        staticPathCandidates: { candidatePaths: paths },
      }),
      call.id,
    );
    linkWorkspace(db, workspaceId);
    const edge = record(db.prepare(`SELECT to_id toId,evidence_json evidenceJson FROM graph_edges
      WHERE from_kind='call' AND from_id=?`).get(String(call.id)));
    const evidence = record(JSON.parse(String(edge.evidenceJson ?? '{}')));
    const pathAnalysis = record(record(evidence.outboundEvidence).pathAnalysis);
    expect(String(edge.toId).split(',')).toHaveLength(DEFAULT_EVIDENCE_CANDIDATE_LIMIT);
    expect(strings(pathAnalysis.candidateRawPaths)).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    expect(strings(pathAnalysis.candidateNormalizedOperationPaths)).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    expect(pathAnalysis).toMatchObject({
      candidateRawPathCount: paths.length,
      omittedCandidateRawPathCount: 1,
      candidateNormalizedOperationPathCount: paths.length,
      omittedCandidateNormalizedOperationPathCount: 1,
    });
    const arrays = candidateArrayLengths(evidence);
    expect(arrays.filter((item) => item.length > DEFAULT_EVIDENCE_CANDIDATE_LIMIT))
      .toEqual([]);
    const doctor = boundDoctorDiagnostics([{
      examples: [{ candidateNormalizedOperationPaths: paths }],
    }]);
    expect(candidateArrayLengths(doctor).filter((item) =>
      item.length > DEFAULT_EVIDENCE_CANDIDATE_LIMIT)).toEqual([]);
    expect(record(records(record(doctor[0]).examples)[0]))
      .toMatchObject({
        candidateNormalizedOperationPathCount: paths.length,
        omittedCandidateNormalizedOperationPathCount: 1,
      });
    db.close();
  });
});
