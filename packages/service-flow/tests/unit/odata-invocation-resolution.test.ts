import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
import { upsertRepository, upsertWorkspace } from '../../src/db/repositories.js';
import { linkWorkspace } from '../../src/index.js';

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function addRepo(db: ReturnType<typeof openDatabase>, workspaceId: number, root: string, name: string): number {
  return upsertRepository(db, workspaceId, {
    name,
    absolutePath: path.join(root, name),
    relativePath: name,
    isGitRepo: false,
    packageName: `@neutral/${name}`,
    kind: 'cap-service',
  });
}

function addServiceOperation(db: ReturnType<typeof openDatabase>, repoId: number, servicePath: string, operationName: string): void {
  const serviceId = Number(db.prepare("INSERT INTO cds_services(repo_id,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(?,?,?,?,?,?,?) RETURNING id").get(repoId, servicePath.replace(/^\//, ''), servicePath.replace(/^\//, ''), servicePath, 0, 'srv/service.cds', 1)?.id);
  db.prepare("INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line) VALUES(?,?,?,?,?,?,?,?)").run(serviceId, 'action', operationName, `/${operationName}`, '[]', null, 'srv/service.cds', 2);
}

function addBinding(db: ReturnType<typeof openDatabase>, repoId: number, variableName: string, servicePathExpr?: string): number {
  return Number(db.prepare('INSERT INTO service_bindings(repo_id,variable_name,alias,service_path_expr,is_dynamic,placeholders_json,source_file,source_line) VALUES(?,?,?,?,?,?,?,?) RETURNING id').get(repoId, variableName, 'remote', servicePathExpr, servicePathExpr?.includes('${') ? 1 : 0, JSON.stringify(servicePathExpr?.includes('${') ? ['tenant'] : []), 'srv/caller.ts', 1)?.id);
}

function addCall(db: ReturnType<typeof openDatabase>, repoId: number, bindingId: number | null, callType: string, method: string, pathExpr: string, queryEntity?: string): void {
  db.prepare('INSERT INTO outbound_calls(repo_id,call_type,service_binding_id,method,operation_path_expr,query_entity,source_file,source_line,confidence,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(repoId, callType, bindingId, method, pathExpr, queryEntity, 'srv/caller.ts', 10, 0.8, JSON.stringify({ parser: 'neutral_seed' }));
}

describe('OData operation invocation resolution', () => {
  it('keeps invocation normalization distinct from raw paths and avoids entity promotion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-odata-invocation-'));
    const db = openDatabase(path.join(root, 'graph.db'));
    const workspaceId = upsertWorkspace(db, root, path.join(root, 'graph.db'));
    const callerRepoId = addRepo(db, workspaceId, root, 'caller-service');
    const adminRepoId = addRepo(db, workspaceId, root, 'admin-service');
    const dynamicRepoId = addRepo(db, workspaceId, root, 'dynamic-service');
    const otherRepoId = addRepo(db, workspaceId, root, 'other-service');
    addServiceOperation(db, adminRepoId, '/AdminService', 'refreshCache');
    addServiceOperation(db, dynamicRepoId, '/TenantService', 'refreshCache');
    addServiceOperation(db, adminRepoId, '/AdminService', 'sharedAction');
    addServiceOperation(db, otherRepoId, '/OtherService', 'sharedAction');

    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'adminClient', '/AdminService'), 'remote_action', 'POST', '/refreshCache()');
    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'dynamicClient', '/${tenant}Service'), 'remote_action', 'POST', '/refreshCache()');
    addCall(db, callerRepoId, null, 'remote_action', 'POST', '/sharedAction()');
    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'entityClient', '/AdminService'), 'remote_query', 'GET', '/BusinessPartners(123)', 'BusinessPartners');
    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'navigationClient', '/AdminService'), 'remote_query', 'GET', "/BusinessPartners('1')/addresses", 'BusinessPartners');
    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'mediaClient', '/AdminService'), 'remote_entity_media', 'GET', "/Documents('1')/$value", 'Documents');
    addCall(db, callerRepoId, addBinding(db, callerRepoId, 'mutationClient', '/AdminService'), 'remote_entity_mutation', 'PATCH', "/BusinessPartners('1')", 'BusinessPartners');

    const linked = linkWorkspace(db, workspaceId);
    expect(linked.remoteResolvedCount).toBe(1);
    expect(linked.dynamicCount).toBe(1);
    expect(linked.ambiguousCount).toBe(1);
    expect(linked.terminalCount).toBe(4);

    const rows = db.prepare("SELECT c.operation_path_expr path,c.call_type callType,e.edge_type edgeType,e.status status,e.unresolved_reason unresolvedReason,e.evidence_json evidenceJson FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) ORDER BY c.id").all() as Array<{ path: string; callType: string; edgeType: string; status: string; unresolvedReason: string | null; evidenceJson: string }>;
    const staticInvocation = rows.find((row) => row.path === '/refreshCache()' && row.status === 'resolved');
    const staticEvidence = JSON.parse(staticInvocation?.evidenceJson ?? '{}') as unknown;
    expect(staticEvidence).toMatchObject({
      rawOperationPath: '/refreshCache()',
      normalizedOperationPath: '/refreshCache',
      invocationArguments: '',
      targetServicePath: '/AdminService',
    });
    const candidateScores = recordValue(staticEvidence)?.candidateScores;
    expect(Array.isArray(candidateScores)).toBe(true);
    const adminScore = Array.isArray(candidateScores)
      ? candidateScores.map(recordValue).find((candidate) => candidate?.servicePath === '/AdminService')
      : undefined;
    expect(adminScore).toMatchObject({ operationPath: '/refreshCache' });
    expect(adminScore?.reasons).toEqual(expect.arrayContaining(['operation_path_match', 'exact_service_path']));
    const dynamicInvocation = rows.find((row) => row.path === '/refreshCache()' && row.status === 'dynamic');
    expect(dynamicInvocation?.unresolvedReason).toContain('missing_variable:tenant');
    expect(JSON.parse(dynamicInvocation?.evidenceJson ?? '{}')).toMatchObject({
      rawOperationPath: '/refreshCache()',
      normalizedOperationPath: '/refreshCache',
      servicePath: '/${tenant}Service',
      routingPlaceholderKeys: ['tenant'],
    });
    expect(rows.find((row) => row.path === '/sharedAction()')).toMatchObject({
      status: 'ambiguous',
      edgeType: 'UNRESOLVED_EDGE',
    });
    expect(rows.find((row) => row.path === '/BusinessPartners(123)')).toMatchObject({
      callType: 'remote_query',
      edgeType: 'HANDLER_RUNS_REMOTE_QUERY',
      status: 'terminal',
      unresolvedReason: null,
    });
    for (const entityPath of ["/BusinessPartners('1')/addresses", "/Documents('1')/$value", "/BusinessPartners('1')"]) {
      const entityRow = rows.find((row) => row.path === entityPath);
      expect(entityRow).toMatchObject({
        status: 'terminal',
        unresolvedReason: null,
      });
      expect(entityRow?.edgeType).not.toContain('OPERATION');
    }
    const mediaEvidence = JSON.parse(
      rows.find((row) => row.path === "/Documents('1')/$value")?.evidenceJson ?? '{}',
    ) as unknown;
    expect(mediaEvidence).toMatchObject({ remoteEntityAccess: 'remote_entity_media' });
    db.close();
  });
});
