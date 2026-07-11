import type { Db } from '../db/connection.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { classifyODataPathIntent, normalizeODataOperationInvocationPath } from './odata-path-normalizer.js';
import { buildRemoteQueryTarget } from './remote-query-target.js';
import { resolveOperation } from './service-resolver.js';
import { linkHelperPackages } from './helper-package-linker.js';
import { externalHttpTarget } from './external-http-target.js';
import { linkImplementations as linkCanonicalImplementations } from './000-implementation-candidates.js';
import {
  ambiguousPathCandidates,
  linkedCallEvidence,
  objectJson,
  objectValue,
} from './002-call-evidence.js';
export interface LinkWorkspaceResult {
  edgeCount: number;
  unresolvedCount: number;
  resolvedCount: number;
  remoteResolvedCount: number;
  localResolvedCount: number;
  ambiguousCount: number;
  dynamicCount: number;
  terminalCount: number;
  dependencyResolvedCount: number;
  dependencyAmbiguousCount: number;
  implementationResolvedCount: number;
  implementationAmbiguousCount: number;
  implementationUnresolvedCount: number;
}
export function linkWorkspace(db: Db, workspaceId: number, vars: Record<string, string> = {}): LinkWorkspaceResult {
  return db.transaction(() => {
    const generation = nextGraphGeneration(db, workspaceId);
    db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
    const deps = linkHelperPackages(db, workspaceId, generation);
    const impl = linkCanonicalImplementations(db, workspaceId, generation);
    const callSummary = linkCalls(db, workspaceId, vars, generation);
    db.prepare("UPDATE repositories SET graph_generation=?, graph_stale_reason=NULL, graph_stale_at=NULL WHERE workspace_id=?").run(generation, workspaceId);
    return { ...callSummary, edgeCount: deps.edgeCount + callSummary.edgeCount + impl.edgeCount, dependencyResolvedCount: deps.resolvedCount, dependencyAmbiguousCount: deps.ambiguousCount, implementationResolvedCount: impl.resolvedCount, implementationAmbiguousCount: impl.ambiguousCount, implementationUnresolvedCount: impl.unresolvedCount };
  });
}
function nextGraphGeneration(db: Db, workspaceId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(graph_generation),0) generation FROM repositories WHERE workspace_id=?').get(workspaceId) as { generation?: number } | undefined;
  return Number(row?.generation ?? 0) + 1;
}
function linkCalls(db: Db, workspaceId: number, vars: Record<string, string>, generation: number): Omit<LinkWorkspaceResult, 'dependencyResolvedCount' | 'dependencyAmbiguousCount' | 'implementationResolvedCount' | 'implementationAmbiguousCount' | 'implementationUnresolvedCount'> {
  let edgeCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;
  let remoteResolvedCount = 0;
  let localResolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db.prepare(`SELECT c.*,r.name repoName,b.id selectedBindingId,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,b.source_file bindingSourceFile,b.source_line bindingSourceLine,b.helper_chain_json helperChainJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE r.workspace_id=?`).all(workspaceId) as Array<Record<string, unknown>>;
  for (const call of calls) {
    const result = insertCallEdge(db, workspaceId, call, vars, generation);
    edgeCount += 1;
    resolvedCount += result.status === 'resolved' ? 1 : 0;
    remoteResolvedCount += result.status === 'resolved' && result.callType !== 'local_service_call' ? 1 : 0;
    localResolvedCount += result.status === 'resolved' && result.callType === 'local_service_call' ? 1 : 0;
    unresolvedCount += result.status === 'unresolved' ? 1 : 0;
    ambiguousCount += result.status === 'ambiguous' ? 1 : 0;
    dynamicCount += result.status === 'dynamic' ? 1 : 0;
    terminalCount += result.status === 'terminal' ? 1 : 0;
  }
  return { edgeCount, unresolvedCount, resolvedCount, remoteResolvedCount, localResolvedCount, ambiguousCount, dynamicCount, terminalCount };
}
function insertCallEdge(db: Db, workspaceId: number, call: Record<string, unknown>, vars: Record<string, string>, generation: number): { status: string; callType: string } {
  const callType = String(call.call_type);
  const rawOp = applyVariables(String(call.operation_path_expr ?? ''), vars);
  const intent = classifyODataPathIntent(rawOp, call.method as string | undefined);
  const isEntityQueryIntent = ['entity_query', 'entity_key_read', 'entity_navigation_query'].includes(intent.kind);
  const resolutionRawOp = callType === 'remote_query' && isEntityQueryIntent ? intent.pathWithoutQuery : rawOp;
  const normalized = normalizeODataOperationInvocationPath(resolutionRawOp);
  const op = normalized?.normalizedOperationPath ?? resolutionRawOp;
  const servicePath = applyVariables((call.servicePathExpr as string | undefined) ?? (call.requireServicePath as string | undefined), vars);
  const destination = (call.destinationExpr as string | undefined) ?? (call.requireDestination as string | undefined);
  const isDynamic = Boolean(Number(call.isDynamic ?? 0));
  const isRemoteEntityCall = callType.startsWith('remote_entity_');
  const indexedOperationCandidateCount = operationCandidateCount(db, workspaceId, op, intent.topLevelOperationName);
  const credibleOperationSignal = Boolean(normalized?.wasInvocation) || (Boolean(intent.topLevelOperationNameCandidate) && indexedOperationCandidateCount > 0);
  const strongEntitySignal = ['entity_media', 'entity_delete', 'entity_key_read', 'entity_navigation_query'].includes(intent.kind) || (intent.kind === 'entity_mutation' && (intent.hasEntityKeyPredicate || intent.hasNavigationSuffix));
  const operationLikeRemoteEntity = isRemoteEntityCall && Boolean(op) && credibleOperationSignal && (!strongEntitySignal || indexedOperationCandidateCount > 0);
  const isOperationCall = operationLikeRemoteEntity || ((callType === 'remote_action' || callType === 'local_service_call') || (callType === 'remote_query' && Boolean(op)));
  const resolution = isOperationCall ? resolveOperation(db, { servicePath, operationPath: op, serviceName: call.local_service_name as string | undefined, repoId: callType === 'local_service_call' ? Number(call.repo_id) : undefined, alias: applyVariables((call.aliasExpr as string | undefined) ?? (call.alias as string | undefined), vars), destination: destination ? applyVariables(destination, vars) : undefined, isDynamic, hasExplicitOverride: Object.keys(vars).length > 0 || callType === 'local_service_call' }, workspaceId) : { status: 'unresolved' as const, candidates: [], reasons: [] };
  const evidence: Record<string, unknown> = {
    ...linkedCallEvidence(
      call,
      resolution,
      servicePath,
      op,
      destination ? applyVariables(destination, vars) : undefined,
      normalized,
      intent,
    ),
    indexedOperationCandidateCount,
    parserCallType: callType,
    entityOperationPrecedence: operationPrecedence(
      callType,
      intent,
      indexedOperationCandidateCount,
      Boolean(resolution.target),
    ),
  };
  const pathAnalysis = objectValue(objectJson(call.evidence_json)?.pathAnalysis);
  if (callType === 'remote_action' && pathAnalysis?.status === 'ambiguous') {
    const candidatePaths = ambiguousPathCandidates(pathAnalysis);
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      workspaceId,
      'UNRESOLVED_EDGE',
      'ambiguous',
      'call',
      String(call.id),
      'operation_candidates',
      candidatePaths.items.join(','),
      Number(call.confidence ?? 0.5),
      JSON.stringify({
        ...evidence,
        ambiguousOperationPathCandidateCount: candidatePaths.totalCount,
        shownAmbiguousOperationPathCandidateCount: candidatePaths.shownCount,
        omittedAmbiguousOperationPathCandidateCount: candidatePaths.omittedCount,
      }),
      0,
      'Ambiguous operation path candidates require explicit disambiguation',
      generation,
    );
    return { status: 'ambiguous', callType };
  }
  if (isRemoteEntityCall && (resolution.target || resolution.candidates.length > 0 || resolution.status === 'dynamic')) {
    if (resolution.target) {
      db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(call.id), 'operation', String(resolution.target.operationId), resolution.target.score, JSON.stringify({ ...evidence, operationEntityPrecedence: 'indexed_operation_over_parser_entity' }), 0, generation);
      return { status: 'resolved', callType };
    }
    const status = resolution.status === 'dynamic' ? 'dynamic' : resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved';
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, status === 'dynamic' ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE', status, 'call', String(call.id), 'operation_candidate', op ? `Remote action: ${op}` : 'Remote action: unknown path', Number(call.confidence ?? 0.2), JSON.stringify({ ...evidence, operationEntityPrecedence: resolution.candidates.length > 0 ? 'parser_entity_with_indexed_operation_candidates' : 'parser_entity_operation_candidate_without_indexed_match' }), status === 'dynamic' ? 1 : 0, unresolvedOperationReason(resolution), generation);
    return { status, callType };
  }
  if (isRemoteEntityCall) {
    const target = buildRemoteQueryTarget({ queryEntity: intent.entitySegment ?? call.query_entity, servicePath, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination: destination ? applyVariables(destination, vars) : undefined, isDynamic, parserWarning: evidence.parserWarning });
    const entityKind = callType.replace('remote_entity_', 'remote_entity_');
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'HANDLER_ACCESSES_REMOTE_ENTITY', 'terminal', 'call', String(call.id), target.toKind, target.toId, Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, ...target.evidence, remoteEntityAccess: entityKind }), 0, generation);
    return { status: 'terminal', callType };
  }
  if (callType === 'remote_query' && (isEntityQueryIntent || !op) && !resolution.target) {
    const target = buildRemoteQueryTarget({ queryEntity: call.query_entity, servicePath, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination: destination ? applyVariables(destination, vars) : undefined, isDynamic, parserWarning: evidence.parserWarning });
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'HANDLER_RUNS_REMOTE_QUERY', 'terminal', 'call', String(call.id), target.toKind, target.toId, Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, ...target.evidence }), 0, generation);
    return { status: 'terminal', callType };
  }
  if (callType === 'local_service_call' && call.unresolved_reason === 'transport_client_method' && !resolution.target && resolution.candidates.length === 0) {
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'HANDLER_CALLS_TRANSPORT_METHOD', 'terminal', 'call', String(call.id), 'transport_method', String(op || 'transport_client_method'), Number(call.confidence ?? 0.5), JSON.stringify({ ...evidence, classification: 'transport_client_method' }), 0, generation);
    return { status: 'terminal', callType };
  }
  if (resolution.target) {
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, callType === 'local_service_call' ? 'LOCAL_CALL_RESOLVES_TO_OPERATION' : 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(call.id), 'operation', String(resolution.target.operationId), resolution.target.score, JSON.stringify(evidence), 0, generation);
    return { status: 'resolved', callType };
  }
  const edgeType = callType === 'local_db_query' ? 'HANDLER_RUNS_DB_QUERY' : callType === 'external_http' ? 'HANDLER_CALLS_EXTERNAL_HTTP' : callType === 'async_emit' ? 'HANDLER_EMITS_EVENT' : callType === 'async_subscribe' ? 'EVENT_CONSUMED_BY_HANDLER' : resolution.status === 'dynamic' ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE';
  const status = edgeType === 'DYNAMIC_EDGE_CANDIDATE' ? 'dynamic' : resolution.status === 'ambiguous' ? 'ambiguous' : edgeType === 'UNRESOLVED_EDGE' ? 'unresolved' : 'terminal';
  const unresolvedReason = status === 'terminal' ? null : String(call.unresolved_reason ?? unresolvedOperationReason(resolution));
  const externalTarget = callType === 'external_http' ? externalHttpTarget(call) : undefined;
  const targetKind = callType === 'local_db_query' ? 'db_entity' : callType.startsWith('async_') ? 'event' : callType === 'external_http' ? (externalTarget?.toKind ?? 'external_endpoint') : 'operation_candidate';
  const targetId = callType === 'local_db_query' ? String(call.query_entity ?? 'unknown') : callType === 'remote_action' ? (op ? `Remote action: ${op}` : (call.unresolved_reason === 'dynamic_operation_path_identifier' ? 'Remote action: dynamic path' : 'Remote action: unknown path')) : callType === 'external_http' ? String(externalTarget?.toId ?? 'unknown') : String(call.event_name_expr ?? op ?? 'unknown');
  const graphLevelDynamic = edgeType === 'DYNAMIC_EDGE_CANDIDATE' && resolution.status === 'dynamic';
  const finalEvidence = externalTarget ? { ...evidence, externalTarget } : evidence;
  db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, edgeType, status, 'call', String(call.id), targetKind, targetId, Number(call.confidence ?? 0.2), JSON.stringify(finalEvidence), graphLevelDynamic ? 1 : 0, unresolvedReason, generation);
  return { status, callType };
}
function operationCandidateCount(db: Db, workspaceId: number, operationPath: string | undefined, operationName: string | undefined): number {
  if (!operationPath && !operationName) return 0;
  const normalizedName = operationName ?? operationPath?.replace(/^\//, '').split('.').at(-1);
  const row = db.prepare(`SELECT COUNT(*) count FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND (o.operation_path=? OR o.operation_path=? OR o.operation_name=?)`).get(workspaceId, operationPath, normalizedName ? `/${normalizedName}` : operationPath, normalizedName) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function operationPrecedence(
  callType: string,
  intent: ReturnType<typeof classifyODataPathIntent>,
  indexedOperationCandidateCount: number,
  resolvedOperation: boolean,
): Record<string, unknown> {
  if (resolvedOperation) {
    return {
      decision: 'operation',
      reason: 'indexed_operation_with_strong_service_context',
      indexedOperationCandidateCount,
    };
  }
  if (callType === 'remote_action' && intent.kind === 'operation_invocation') {
    return {
      decision: 'operation_candidate',
      rejectionReason: indexedOperationCandidateCount > 0
        ? 'indexed_candidates_lack_unique_strong_service_context'
        : 'no_indexed_operation_candidate',
      indexedOperationCandidateCount,
    };
  }
  if (intent.kind.startsWith('entity_')) {
    return {
      decision: 'entity',
      rejectionReason: indexedOperationCandidateCount > 0
        ? 'entity_shape_has_precedence_without_resolved_operation_context'
        : 'entity_shape_has_no_indexed_operation_evidence',
      indexedOperationCandidateCount,
    };
  }
  return {
    decision: 'unresolved',
    rejectionReason: 'path_has_no_safe_entity_or_operation_precedence',
    indexedOperationCandidateCount,
  };
}

function unresolvedOperationReason(resolution: { candidates: unknown[]; status: string; reasons: string[] }): string {
  if (resolution.status === 'dynamic') return `Dynamic target requires runtime variable overrides: ${(resolution.reasons.length ? resolution.reasons : ['missing runtime variables']).join(', ')}`;
  if (resolution.candidates.length === 0) return 'No indexed target operation matched';
  if (resolution.reasons.includes('operation_path_only_has_no_strong_target_signal')) return 'Operation candidates found but no strong service signal is available';
  if (resolution.reasons.includes('candidate_score_below_resolution_threshold')) return 'Operation candidates found but resolution score is below threshold';
  if (resolution.status === 'ambiguous') return 'Ambiguous operation candidates require a strong service signal';
  return 'Operation candidates found but resolution could not select a target';
}
