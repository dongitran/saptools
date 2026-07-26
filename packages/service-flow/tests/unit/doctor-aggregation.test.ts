import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import {
  insertCalls,
  insertSymbolCalls,
} from '../../src/db/call-fact-repository.js';
import { upsertRepository, upsertWorkspace } from '../../src/db/repositories.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { DEFAULT_EVIDENCE_CANDIDATE_LIMIT } from '../../src/utils/bounded-projection.js';
import {
  insertOwnerlessCall,
  markRepositoryCurrent,
} from './current-fact-fixture.js';

function insertService(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  servicePath: string,
  sourceLine: number,
  baseServiceId: number | null = null,
): number {
  const serviceName = servicePath.replace(/^\//, '');
  return Number(db.prepare(`INSERT INTO cds_services(
    repo_id,service_name,qualified_name,service_path,is_extend,
    source_file,source_line,extension_base_service_id,extension_base_status
  ) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, serviceName, serviceName, servicePath,
    baseServiceId === null ? 0 : 1, 'srv/service.cds', sourceLine,
    baseServiceId, baseServiceId === null ? null : 'resolved',
  )?.id);
}

function insertOperation(db: ReturnType<typeof openDatabase>, serviceId: number, operationName: string, sourceLine: number, provenance = 'direct', baseOperationId: number | null = null): number {
  return Number(db.prepare('INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,provenance,base_operation_id) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id').get(serviceId, 'action', operationName, `/${operationName}`, '[]', null, 'srv/service.cds', sourceLine, provenance, baseOperationId)?.id);
}

function insertImplementationEdge(db: ReturnType<typeof openDatabase>, workspaceId: number, operationId: number, status: string, evidence: Record<string, unknown>, reason: string): void {
  db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(workspaceId, 'OPERATION_IMPLEMENTED_BY_HANDLER', status, 'operation', String(operationId), 'handler_method_candidates', '1,2', 0.5, JSON.stringify(evidence), 0, reason, 1);
}

function insertExecutableSymbol(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  name: string,
  startOffset: number,
  endOffset: number,
): void {
  db.prepare(`INSERT INTO symbols(
    repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    repoId, 'function', name, name, 0, 1, 10,
    startOffset, endOffset, 'srv/helper.ts',
    JSON.stringify({
      executableBodyEligibility: {
        eligible: true,
        reason: 'body_present',
      },
    }),
  );
}

function insertSymbolAndWrapperFacts(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
): void {
  insertExecutableSymbol(db, repoId, 'caller', 0, 100);
  insertExecutableSymbol(db, repoId, 'callee', 110, 150);
  insertSymbolCalls(db, repoId, [{
    callerQualifiedName: 'caller',
    calleeExpression: 'callee',
    calleeLocalName: 'callee',
    sourceFile: 'srv/helper.ts',
    sourceLine: 2,
    callSiteStartOffset: 20,
    callSiteEndOffset: 30,
    callRole: 'ordinary_call',
    evidence: {
      relation: 'indexed_local_symbol',
      caller: 'caller',
      targetName: 'callee',
      callArguments: [{ kind: 'identifier', name: 'serviceClient' }],
    },
  }]);
  insertCalls(db, repoId, [{
    callType: 'remote_action',
    sourceFile: 'srv/helper.ts',
    sourceLine: 3,
    callSiteStartOffset: 40,
    callSiteEndOffset: 50,
    sourceSymbolQualifiedName: 'caller',
    confidence: 0.4,
    unresolvedReason: 'dynamic_operation_path_identifier',
    serviceBindingReference: {
      status: 'not_applicable',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    },
    evidence: {
      sourceOwnerResolution: 'owned_exact',
      receiver: 'serviceClient',
      operationPathExpression: 'request.path',
    },
  }]);
}

describe('strict doctor implementation aggregation', () => {
  it('aggregates repeated implementation candidate failures by actionable category', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-doctor-aggregation-'));
    const db = openDatabase(path.join(root, 'graph.db'));
    const workspaceId = upsertWorkspace(db, root, path.join(root, 'graph.db'));
    const repoId = upsertRepository(db, workspaceId, {
      name: 'model-core',
      absolutePath: path.join(root, 'model-core'),
      relativePath: 'model-core',
      isGitRepo: false,
      packageName: '@neutral/model-core',
      kind: 'cap-db-model',
    });
    markRepositoryCurrent(db, repoId, '@neutral/model-core');
    const baseServiceId = insertService(db, repoId, '/BaseService', 1);
    const baseOperationId = insertOperation(db, baseServiceId, 'performWork', 2);
    const variants = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const suffix of variants) {
      const serviceId = insertService(
        db, repoId, `/Tenant${suffix}Service`, 10, baseServiceId,
      );
      const operationId = insertOperation(
        db, serviceId, 'performWork', 2, 'inherited', baseOperationId,
      );
      insertImplementationEdge(db, workspaceId, operationId, 'unresolved', {
        servicePath: `/Tenant${suffix}Service`,
        operationPath: '/performWork',
        operationName: 'performWork',
        baseOperationId,
        candidates: [{
          accepted: false,
          rejectedReasons: ['missing direct ownership, exact local service path, or validated cross-package dependency evidence'],
          handlerPackage: { name: 'helper-shared', packageName: '@neutral/shared-helper' },
        }],
      }, 'No implementation candidate passed policy');
    }
    const duplicateServiceId = insertService(db, repoId, '/DuplicateService', 20);
    const duplicateOperationId = insertOperation(db, duplicateServiceId, 'syncData', 21);
    insertImplementationEdge(db, workspaceId, duplicateOperationId, 'ambiguous', {
      servicePath: '/DuplicateService',
      operationPath: '/syncData',
      operationName: 'syncData',
      ambiguityReasons: ['duplicate_package_name_candidates'],
      candidateFamilies: [{ reason: 'duplicate_package_name_candidates', packageName: '@neutral/duplicate-helper', count: 2 }],
      candidates: [
        { accepted: true, handlerPackage: { name: 'helper-a', packageName: '@neutral/duplicate-helper' } },
        { accepted: true, handlerPackage: { name: 'helper-b', packageName: '@neutral/duplicate-helper' } },
      ],
    }, 'Ambiguous registered handler implementation candidates');

    insertSymbolAndWrapperFacts(db, repoId);

    const diagnostics = doctorDiagnostics(db, true);
    expect(diagnostics.some((item) => item.code === 'implementation_candidates_rejected')).toBe(false);
    const aggregate = diagnostics.find((item) => item.code === 'strict_implementation_candidate_quality') as {
      severity?: string;
      summary?: Array<{ category: string; count: number; reason: string; candidateFamily: string; suggestedAction: string }>;
      categories?: Array<{ category: string; count: number; baseOperation?: string; servicePathPattern?: string; reason?: string; candidateFamily?: string; examples?: unknown[]; expandedExamples?: unknown[]; suggestedAction?: string; suggestedHints?: string[] }>;
    };
    expect(aggregate?.severity).toBe('warning');
    expect(aggregate.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'missing_strong_ownership_evidence',
        baseOperation: 'performWork',
        servicePathPattern: '/Tenant*Service',
        candidateFamily: '@neutral/shared-helper',
        count: variants.length,
      }),
      expect.objectContaining({
        category: 'duplicate_package_name_candidates',
        candidateFamily: '@neutral/duplicate-helper',
        count: 1,
      }),
      expect.objectContaining({
        category: 'missing_parameter_metadata',
        count: 1,
      }),
      expect.objectContaining({
        category: 'dynamic_wrapper_paths',
        candidateFamily: 'wrapper_path',
        count: 1,
      }),
    ]));
    const duplicateSummary = aggregate.summary?.find((item) => item.category === 'duplicate_package_name_candidates');
    expect(duplicateSummary).toMatchObject({ candidateFamily: '@neutral/duplicate-helper', count: 1 });
    expect(duplicateSummary?.suggestedAction).toContain('--implementation-hint');
    const duplicateCategory = aggregate.categories?.find((item) => item.category === 'duplicate_package_name_candidates');
    expect(duplicateCategory?.suggestedHints).toEqual(expect.arrayContaining([
      '--implementation-hint service=/DuplicateService,operation=/syncData,family=@neutral/duplicate-helper,repo=helper-a',
      '--implementation-hint service=/DuplicateService,operation=/syncData,family=@neutral/duplicate-helper,repo=helper-b',
    ]));
    const wrapperSummary = aggregate.summary?.find((item) => item.category === 'dynamic_wrapper_paths');
    expect(wrapperSummary).toMatchObject({ reason: 'wrapper path cannot be proven statically' });
    expect(wrapperSummary?.suggestedAction).toContain('--var');
    for (const category of aggregate.categories ?? []) {
      expect((category.examples ?? []).length).toBeLessThanOrEqual(3);
      expect(category.expandedExamples).toBeUndefined();
      expect(typeof category.suggestedAction).toBe('string');
    }

    const detailed = doctorDiagnostics(db, true, { detail: true }).find((item) => item.code === 'strict_implementation_candidate_quality') as typeof aggregate;
    const ownershipDetail = detailed.categories?.find((item) => item.category === 'missing_strong_ownership_evidence');
    expect(ownershipDetail?.examples).toHaveLength(3);
    expect(ownershipDetail).toMatchObject({
      exampleCount: variants.length,
      shownExampleCount: 3,
      omittedExampleCount: variants.length - 3,
      expandedExampleCount: variants.length,
      shownExpandedExampleCount: DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
      omittedExpandedExampleCount:
        variants.length - DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    });
    expect(ownershipDetail?.expandedExamples).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    db.close();
  });

  it('aggregates repeated remote targets without implementation by service and operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-doctor-missing-impl-'));
    const db = openDatabase(path.join(root, 'graph.db'));
    const workspaceId = upsertWorkspace(db, root, path.join(root, 'graph.db'));
    const repoId = upsertRepository(db, workspaceId, {
      name: 'facade-service',
      absolutePath: path.join(root, 'facade-service'),
      relativePath: 'facade-service',
      isGitRepo: false,
      packageName: '@neutral/facade-service',
      kind: 'cap-service',
    });
    markRepositoryCurrent(db, repoId, '@neutral/facade-service');
    const serviceId = insertService(db, repoId, '/ProductService', 1);
    const operationId = insertOperation(db, serviceId, 'activate', 2);
    const insertEdge = db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const lines = [10, 20, 30, 40, 50, 60];
    for (const line of lines) {
      const startOffset = line * 10;
      const callId = insertOwnerlessCall(db, repoId, {
        callType: 'remote_action',
        method: 'POST',
        operationPathExpr: '/activate',
        sourceFile: 'srv/facade.ts',
        sourceLine: line,
        startOffset,
        endOffset: startOffset + 8,
        evidence: { parser: 'neutral_fixture' },
      });
      insertEdge.run(workspaceId, 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(callId), 'operation', String(operationId), 0.9, '{}', 0, 1);
    }

    const compact = doctorDiagnostics(db, true).find((item) => item.code === 'remote_target_without_implementation') as {
      callSiteCount?: number;
      examples?: unknown[];
      expandedExamples?: unknown[];
      servicePath?: string;
      operationPath?: string;
    };
    expect(compact).toMatchObject({ servicePath: '/ProductService', operationPath: '/activate', callSiteCount: lines.length });
    expect(compact.examples).toHaveLength(3);
    expect(compact.expandedExamples).toBeUndefined();

    const detailed = doctorDiagnostics(db, true, { detail: true }).find((item) => item.code === 'remote_target_without_implementation') as typeof compact;
    expect(detailed).toMatchObject({
      expandedExampleCount: lines.length,
      shownExpandedExampleCount: DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
      omittedExpandedExampleCount:
        lines.length - DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    });
    expect(detailed.expandedExamples).toHaveLength(
      DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
    );
    db.close();
  });

});
