import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import { upsertRepository, upsertWorkspace } from '../../src/db/repositories.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';

function insertService(db: ReturnType<typeof openDatabase>, repoId: number, servicePath: string, sourceLine: number): number {
  return Number(db.prepare("INSERT INTO cds_services(repo_id,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(?,?,?,?,?,?,?) RETURNING id").get(repoId, servicePath.replace(/^\//, ''), servicePath.replace(/^\//, ''), servicePath, 0, 'srv/service.cds', sourceLine)?.id);
}

function insertOperation(db: ReturnType<typeof openDatabase>, serviceId: number, operationName: string, sourceLine: number, provenance = 'direct', baseOperationId: number | null = null): number {
  return Number(db.prepare('INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,provenance,base_operation_id) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id').get(serviceId, 'action', operationName, `/${operationName}`, '[]', null, 'srv/service.cds', sourceLine, provenance, baseOperationId)?.id);
}

function insertImplementationEdge(db: ReturnType<typeof openDatabase>, workspaceId: number, operationId: number, status: string, evidence: Record<string, unknown>, reason: string): void {
  db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(workspaceId, 'OPERATION_IMPLEMENTED_BY_HANDLER', status, 'operation', String(operationId), 'handler_method_candidates', '1,2', 0.5, JSON.stringify(evidence), 0, reason, 1);
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
    const baseServiceId = insertService(db, repoId, '/BaseService', 1);
    const baseOperationId = insertOperation(db, baseServiceId, 'performWork', 2);
    for (const suffix of ['A', 'B', 'C', 'D', 'E']) {
      const serviceId = insertService(db, repoId, `/Tenant${suffix}Service`, 10);
      const operationId = insertOperation(db, serviceId, 'performWork', 11, 'inherited', baseOperationId);
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

    const callerId = Number(db.prepare("INSERT INTO symbols(repo_id,kind,name,qualified_name,exported,start_line,end_line,source_file,evidence_json) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").get(repoId, 'function', 'caller', 'caller', 1, 1, 3, 'srv/helper.ts', '{}')?.id);
    const calleeId = Number(db.prepare("INSERT INTO symbols(repo_id,kind,name,qualified_name,exported,start_line,end_line,source_file,evidence_json) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").get(repoId, 'function', 'callee', 'callee', 1, 5, 7, 'srv/helper.ts', '{}')?.id);
    db.prepare('INSERT INTO symbol_calls(repo_id,caller_symbol_id,callee_symbol_id,callee_expression,source_file,source_line,status,confidence,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(repoId, callerId, calleeId, 'callee', 'srv/helper.ts', 2, 'resolved', 0.8, JSON.stringify({ callArguments: [{ kind: 'identifier', name: 'serviceClient' }] }));
    db.prepare('INSERT INTO outbound_calls(repo_id,source_symbol_id,call_type,operation_path_expr,source_file,source_line,confidence,unresolved_reason,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(repoId, callerId, 'remote_action', null, 'srv/helper.ts', 3, 0.4, 'dynamic_operation_path_identifier', JSON.stringify({ receiver: 'serviceClient', operationPathExpression: 'request.path' }));

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
        count: 5,
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
    expect(ownershipDetail?.expandedExamples).toHaveLength(5);
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
    const serviceId = insertService(db, repoId, '/ProductService', 1);
    const operationId = insertOperation(db, serviceId, 'activate', 2);
    const insertCall = db.prepare('INSERT INTO outbound_calls(repo_id,call_type,operation_path_expr,source_file,source_line,confidence,evidence_json) VALUES(?,?,?,?,?,?,?) RETURNING id');
    const insertEdge = db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const line of [10, 20, 30, 40]) {
      const callId = Number(insertCall.get(repoId, 'remote_action', '/activate', 'srv/facade.ts', line, 0.8, JSON.stringify({ parser: 'neutral_fixture' }))?.id);
      insertEdge.run(workspaceId, 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(callId), 'operation', String(operationId), 0.9, '{}', 0, 1);
    }

    const compact = doctorDiagnostics(db, true).find((item) => item.code === 'remote_target_without_implementation') as {
      callSiteCount?: number;
      examples?: unknown[];
      expandedExamples?: unknown[];
      servicePath?: string;
      operationPath?: string;
    };
    expect(compact).toMatchObject({ servicePath: '/ProductService', operationPath: '/activate', callSiteCount: 4 });
    expect(compact.examples).toHaveLength(3);
    expect(compact.expandedExamples).toBeUndefined();

    const detailed = doctorDiagnostics(db, true, { detail: true }).find((item) => item.code === 'remote_target_without_implementation') as typeof compact;
    expect(detailed.expandedExamples).toHaveLength(4);
    db.close();
  });

});
