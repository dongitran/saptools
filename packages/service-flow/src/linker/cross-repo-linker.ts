import type { Db } from '../db/connection.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { resolveOperation } from './service-resolver.js';
import { linkHelperPackages } from './helper-package-linker.js';
export interface LinkWorkspaceResult {
  edgeCount: number;
  unresolvedCount: number;
  resolvedCount: number;
  ambiguousCount: number;
  dynamicCount: number;
  terminalCount: number;
  dependencyResolvedCount: number;
  dependencyAmbiguousCount: number;
  implementationResolvedCount: number;
  implementationAmbiguousCount: number;
}
export function linkWorkspace(db: Db, workspaceId: number, vars: Record<string, string> = {}): LinkWorkspaceResult {
  return db.transaction(() => {
    const generation = nextGraphGeneration(db, workspaceId);
    db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
    const deps = linkHelperPackages(db, workspaceId, generation);
    const callSummary = linkCalls(db, workspaceId, vars, generation);
    const impl = linkImplementations(db, workspaceId, generation);
    db.prepare("UPDATE repositories SET graph_generation=?, graph_stale_reason=NULL, graph_stale_at=NULL WHERE workspace_id=?").run(generation, workspaceId);
    return { ...callSummary, edgeCount: deps.edgeCount + callSummary.edgeCount + impl.edgeCount, dependencyResolvedCount: deps.resolvedCount, dependencyAmbiguousCount: deps.ambiguousCount, implementationResolvedCount: impl.resolvedCount, implementationAmbiguousCount: impl.ambiguousCount };
  });
}
function nextGraphGeneration(db: Db, workspaceId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(graph_generation),0) generation FROM repositories WHERE workspace_id=?').get(workspaceId) as { generation?: number } | undefined;
  return Number(row?.generation ?? 0) + 1;
}
function linkCalls(db: Db, workspaceId: number, vars: Record<string, string>, generation: number): Omit<LinkWorkspaceResult, 'dependencyResolvedCount' | 'dependencyAmbiguousCount' | 'implementationResolvedCount' | 'implementationAmbiguousCount'> {
  let edgeCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db.prepare(`SELECT c.*,r.name repoName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,b.helper_chain_json helperChainJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE r.workspace_id=?`).all(workspaceId) as Array<Record<string, unknown>>;
  for (const call of calls) {
    const result = insertCallEdge(db, workspaceId, call, vars, generation);
    edgeCount += 1;
    resolvedCount += result.status === 'resolved' ? 1 : 0;
    unresolvedCount += result.status === 'unresolved' ? 1 : 0;
    ambiguousCount += result.status === 'ambiguous' ? 1 : 0;
    dynamicCount += result.status === 'dynamic' ? 1 : 0;
    terminalCount += result.status === 'terminal' ? 1 : 0;
  }
  return { edgeCount, unresolvedCount, resolvedCount, ambiguousCount, dynamicCount, terminalCount };
}
function insertCallEdge(db: Db, workspaceId: number, call: Record<string, unknown>, vars: Record<string, string>, generation: number): { status: string } {
  const callType = String(call.call_type);
  const op = applyVariables(String(call.operation_path_expr ?? ''), vars);
  const servicePath = applyVariables((call.servicePathExpr as string | undefined) ?? (call.requireServicePath as string | undefined), vars);
  const destination = (call.destinationExpr as string | undefined) ?? (call.requireDestination as string | undefined);
  const isDynamic = Boolean(Number(call.isDynamic ?? 0));
  const resolution = callType.startsWith('remote') ? resolveOperation(db, { servicePath, operationPath: op, alias: applyVariables((call.aliasExpr as string | undefined) ?? (call.alias as string | undefined), vars), destination: destination ? applyVariables(destination, vars) : undefined, isDynamic, hasExplicitOverride: Object.keys(vars).length > 0 }, workspaceId) : { status: 'unresolved' as const, candidates: [], reasons: [] };
  const evidence = callEvidence(call, resolution, servicePath, op, destination ? applyVariables(destination, vars) : undefined);
  if (resolution.target) {
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(call.id), 'operation', String(resolution.target.operationId), resolution.target.score, JSON.stringify(evidence), isDynamic ? 1 : 0, generation);
    return { status: 'resolved' };
  }
  const edgeType = callType === 'local_db_query' ? 'HANDLER_RUNS_DB_QUERY' : callType === 'external_http' ? 'HANDLER_CALLS_EXTERNAL_HTTP' : callType === 'async_emit' ? 'HANDLER_EMITS_EVENT' : callType === 'async_subscribe' ? 'EVENT_CONSUMED_BY_HANDLER' : resolution.status === 'dynamic' ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE';
  const status = edgeType === 'DYNAMIC_EDGE_CANDIDATE' ? 'dynamic' : resolution.status === 'ambiguous' ? 'ambiguous' : edgeType === 'UNRESOLVED_EDGE' ? 'unresolved' : 'terminal';
  const unresolvedReason = status === 'terminal' ? null : String(call.unresolved_reason ?? (resolution.status === 'ambiguous' ? 'Ambiguous operation candidates require a strong service signal' : resolution.status === 'dynamic' ? `Dynamic target requires runtime variable overrides: ${(resolution.reasons.length ? resolution.reasons : ['missing runtime variables']).join(', ')}` : 'No indexed target operation matched'));
  db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, edgeType, status, 'call', String(call.id), callType.startsWith('async_') ? 'event' : 'external', String(call.event_name_expr ?? call.query_entity ?? op ?? call.id), Number(call.confidence ?? 0.2), JSON.stringify(evidence), isDynamic || resolution.status === 'dynamic' ? 1 : 0, unresolvedReason, generation);
  return { status };
}
function callEvidence(call: Record<string, unknown>, resolution: { target?: { repoName?: string; operationName?: string }; candidates: unknown[]; status: string; reasons: string[] }, servicePath: string | undefined, op: string | undefined, destination: string | undefined): Record<string, unknown> {
  return { sourceFile: call.source_file, sourceLine: call.source_line, file: call.source_file, line: call.source_line, repo: call.repoName, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination, servicePath, operationPath: op, targetRepo: resolution.target?.repoName, targetOperation: resolution.target?.operationName, helperChain: call.helperChainJson ? (JSON.parse(String(call.helperChainJson)) as unknown) : undefined, candidates: resolution.candidates, candidateCount: resolution.candidates.length, resolutionStatus: resolution.status, resolutionReasons: resolution.reasons, analysisCompleteness: call.unresolved_reason ? 'partial' : 'complete', parserWarning: call.unresolved_reason ? { code: 'parser_warning', message: call.unresolved_reason } : undefined };
}
function linkImplementations(db: Db, workspaceId: number, generation: number): { edgeCount: number; resolvedCount: number; ambiguousCount: number } {
  const operations = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,o.operation_name operationName,s.service_path servicePath,s.repo_id modelRepoId,r.package_name modelPackage FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=?`).all(workspaceId) as Array<Record<string, unknown>>;
  let edgeCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  for (const operation of operations) {
    const rows = implementationCandidates(db, workspaceId, operation);
    if (rows.length === 0) continue;
    const unique = rows.length === 1 ? rows[0] : undefined;
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'OPERATION_IMPLEMENTED_BY_HANDLER', unique ? 'resolved' : 'ambiguous', 'operation', String(operation.operationId), unique ? 'handler_method' : 'handler_method_candidates', unique ? String(unique.methodId) : rows.map((row) => row.methodId).join(','), unique ? 0.95 : 0.5, JSON.stringify({ servicePath: operation.servicePath, operationPath: operation.operationPath, operationName: operation.operationName, candidates: rows, evidence: 'registered_application_dependency' }), 0, unique ? null : 'Ambiguous registered handler implementation candidates', generation);
    edgeCount += 1;
    if (unique) resolvedCount += 1;
    else ambiguousCount += 1;
  }
  return { edgeCount, resolvedCount, ambiguousCount };
}
function implementationCandidates(db: Db, workspaceId: number, operation: Record<string, unknown>): Array<Record<string, unknown>> {
  return db.prepare(`SELECT DISTINCT hm.id methodId,hc.id classId,hc.class_name className,hc.source_file sourceFile,hc.source_line sourceLine,hr.repo_id applicationRepoId,handlerRepo.name handlerRepo,appRepo.name applicationRepo FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id JOIN repositories handlerRepo ON handlerRepo.id=hc.repo_id JOIN handler_registrations hr ON hr.class_name=hc.class_name JOIN repositories appRepo ON appRepo.id=hr.repo_id JOIN graph_edges modelDep ON modelDep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND modelDep.status='resolved' AND modelDep.from_kind='repo' AND modelDep.from_id=CAST(appRepo.id AS TEXT) AND modelDep.to_id=CAST(? AS TEXT) JOIN graph_edges handlerDep ON handlerDep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND handlerDep.status='resolved' AND handlerDep.from_kind='repo' AND handlerDep.from_id=CAST(appRepo.id AS TEXT) AND handlerDep.to_id=CAST(handlerRepo.id AS TEXT) WHERE appRepo.workspace_id=? AND (hm.decorator_value=? OR hm.decorator_value=? OR hm.method_name=?)`).all(operation.modelRepoId, workspaceId, normalizedOperation(String(operation.operationPath ?? '')), operation.operationName, operation.operationName) as Array<Record<string, unknown>>;
}
function normalizedOperation(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}
