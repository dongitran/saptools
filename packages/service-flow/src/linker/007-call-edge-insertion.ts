import type { Db } from '../db/connection.js';
import {
  ambiguousPathCandidates,
  linkedCallEvidence,
  objectJson,
  objectValue,
} from './002-call-evidence.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { insertEventCallEdge } from './006-event-template-link.js';
import { externalHttpTarget } from './external-http-target.js';
import {
  classifyODataPathIntent,
  normalizeODataOperationInvocationPath,
  type ODataPathIntent,
} from './odata-path-normalizer.js';
import { buildRemoteQueryTarget } from './remote-query-target.js';
import {
  resolveOperation,
  type OperationResolution,
} from './service-resolver.js';

export interface CallEdgeInsertionResult {
  status: string;
  callType: string;
}

interface CallPathContext {
  intent: ODataPathIntent;
  entityQueryIntent: boolean;
  normalized: ReturnType<typeof normalizeODataOperationInvocationPath>;
  operation?: string;
}

interface CallEdgeContext extends CallPathContext {
  db: Db;
  workspaceId: number;
  call: Record<string, unknown>;
  variables: Record<string, string>;
  generation: number;
  callType: string;
  servicePath?: string;
  destination?: string;
  bindingDynamic: boolean;
  remoteEntity: boolean;
  indexedOperationCandidateCount: number;
  resolution: OperationResolution;
  evidence: Record<string, unknown>;
}

function callPathContext(
  call: Record<string, unknown>,
  variables: Record<string, string>,
): CallPathContext {
  const raw = applyVariables(String(call.operation_path_expr ?? ''), variables);
  const intent = classifyODataPathIntent(
    raw, call.method as string | undefined,
  );
  const entityQueryIntent = [
    'entity_query', 'entity_key_read', 'entity_navigation_query',
  ].includes(intent.kind);
  const resolutionPath = call.call_type === 'remote_query'
    && entityQueryIntent ? intent.pathWithoutQuery : raw;
  const normalized = normalizeODataOperationInvocationPath(resolutionPath);
  return {
    intent,
    entityQueryIntent,
    normalized,
    operation: normalized?.normalizedOperationPath ?? resolutionPath,
  };
}

function resolvedServicePath(
  call: Record<string, unknown>,
  variables: Record<string, string>,
): string | undefined {
  const expression = (call.servicePathExpr as string | undefined)
    ?? (call.requireServicePath as string | undefined);
  return applyVariables(expression, variables);
}

function resolvedDestination(
  call: Record<string, unknown>,
  variables: Record<string, string>,
): string | undefined {
  const expression = (call.destinationExpr as string | undefined)
    ?? (call.requireDestination as string | undefined);
  return expression ? applyVariables(expression, variables) : undefined;
}

function credibleOperationSignal(
  path: CallPathContext,
  indexedCandidateCount: number,
): boolean {
  if (path.normalized?.wasInvocation) return true;
  return Boolean(path.intent.topLevelOperationNameCandidate)
    && indexedCandidateCount > 0;
}

function strongEntitySignal(intent: ODataPathIntent): boolean {
  if (['entity_media', 'entity_delete', 'entity_key_read',
    'entity_navigation_query'].includes(intent.kind)) return true;
  return intent.kind === 'entity_mutation'
    && (intent.hasEntityKeyPredicate || intent.hasNavigationSuffix);
}

function operationCallEligible(
  callType: string,
  remoteEntity: boolean,
  path: CallPathContext,
  indexedCandidateCount: number,
): boolean {
  if (remoteEntity)
    return Boolean(path.operation)
      && credibleOperationSignal(path, indexedCandidateCount)
      && (!strongEntitySignal(path.intent) || indexedCandidateCount > 0);
  if (callType === 'remote_action' || callType === 'local_service_call')
    return true;
  return callType === 'remote_query' && Boolean(path.operation);
}

function callResolution(
  db: Db,
  workspaceId: number,
  call: Record<string, unknown>,
  variables: Record<string, string>,
  path: CallPathContext,
  servicePath: string | undefined,
  destination: string | undefined,
  bindingDynamic: boolean,
  remoteEntity: boolean,
): OperationResolution {
  const callType = String(call.call_type);
  const count = operationCandidateCount(
    db, workspaceId, path.operation, path.intent.topLevelOperationName,
  );
  if (!operationCallEligible(callType, remoteEntity, path, count))
    return { status: 'unresolved', candidates: [], reasons: [] };
  const aliasExpression = (call.aliasExpr as string | undefined)
    ?? (call.alias as string | undefined);
  return resolveOperation(db, {
    servicePath,
    operationPath: path.operation,
    serviceName: call.local_service_name as string | undefined,
    repoId: callType === 'local_service_call'
      ? Number(call.repo_id) : undefined,
    alias: applyVariables(aliasExpression, variables),
    destination,
    isDynamic: bindingDynamic,
    hasExplicitOverride: Object.keys(variables).length > 0
      || callType === 'local_service_call',
  }, workspaceId);
}

function callEvidence(
  call: Record<string, unknown>,
  path: CallPathContext,
  resolution: OperationResolution,
  servicePath: string | undefined,
  destination: string | undefined,
  candidateCount: number,
): Record<string, unknown> {
  const callType = String(call.call_type);
  return {
    ...linkedCallEvidence(
      call, resolution, servicePath, path.operation, destination,
      path.normalized, path.intent,
    ),
    indexedOperationCandidateCount: candidateCount,
    parserCallType: callType,
    entityOperationPrecedence: operationPrecedence(
      callType, path.intent, candidateCount, Boolean(resolution.target),
    ),
  };
}

function createCallEdgeContext(
  db: Db,
  workspaceId: number,
  call: Record<string, unknown>,
  variables: Record<string, string>,
  generation: number,
): CallEdgeContext {
  const callType = String(call.call_type);
  const path = callPathContext(call, variables);
  const servicePath = resolvedServicePath(call, variables);
  const destination = resolvedDestination(call, variables);
  const bindingDynamic = Boolean(Number(call.isDynamic ?? 0));
  const remoteEntity = callType.startsWith('remote_entity_');
  const indexedOperationCandidateCount = operationCandidateCount(
    db, workspaceId, path.operation, path.intent.topLevelOperationName,
  );
  const resolution = callResolution(
    db, workspaceId, call, variables, path, servicePath, destination,
    bindingDynamic, remoteEntity,
  );
  return {
    db, workspaceId, call, variables, generation, callType, ...path,
    servicePath, destination, bindingDynamic, remoteEntity,
    indexedOperationCandidateCount, resolution,
    evidence: callEvidence(
      call, path, resolution, servicePath, destination,
      indexedOperationCandidateCount,
    ),
  };
}

function insertAmbiguousPathEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  const analysis = objectValue(
    objectJson(context.call.evidence_json)?.pathAnalysis,
  );
  if (context.callType !== 'remote_action'
    || analysis?.status !== 'ambiguous') return undefined;
  const paths = ambiguousPathCandidates(analysis);
  const evidence = {
    ...context.evidence,
    ambiguousOperationPathCandidateCount: paths.totalCount,
    shownAmbiguousOperationPathCandidateCount: paths.shownCount,
    omittedAmbiguousOperationPathCandidateCount: paths.omittedCount,
  };
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, 'UNRESOLVED_EDGE', 'ambiguous', 'call',
    String(context.call.id), 'operation_candidates', paths.items.join(','),
    Number(context.call.confidence ?? 0.5), JSON.stringify(evidence), 0,
    'Ambiguous operation path candidates require explicit disambiguation',
    context.generation,
  );
  return { status: 'ambiguous', callType: context.callType };
}

function resolvedOperationEdge(
  context: CallEdgeContext,
  evidence = context.evidence,
): CallEdgeInsertionResult {
  const target = context.resolution.target;
  if (!target) throw new Error('resolved_operation_target_missing');
  const edgeType = context.callType === 'local_service_call'
    ? 'LOCAL_CALL_RESOLVES_TO_OPERATION'
    : 'REMOTE_CALL_RESOLVES_TO_OPERATION';
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, edgeType, 'resolved', 'call',
    String(context.call.id), 'operation', String(target.operationId),
    target.score, JSON.stringify(evidence), 0, context.generation,
  );
  return { status: 'resolved', callType: context.callType };
}

function resolutionStatus(resolution: OperationResolution): string {
  if (resolution.status === 'dynamic') return 'dynamic';
  return resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved';
}

function remoteEntityOperationEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult {
  if (context.resolution.target)
    return resolvedOperationEdge(context, {
      ...context.evidence,
      operationEntityPrecedence: 'indexed_operation_over_parser_entity',
    });
  const status = resolutionStatus(context.resolution);
  const precedence = context.resolution.candidates.length > 0
    ? 'parser_entity_with_indexed_operation_candidates'
    : 'parser_entity_operation_candidate_without_indexed_match';
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId,
    status === 'dynamic' ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE',
    status, 'call', String(context.call.id), 'operation_candidate',
    context.operation
      ? `Remote action: ${context.operation}` : 'Remote action: unknown path',
    Number(context.call.confidence ?? 0.2),
    JSON.stringify({
      ...context.evidence, operationEntityPrecedence: precedence,
    }),
    status === 'dynamic' ? 1 : 0,
    unresolvedOperationReason(context.resolution), context.generation,
  );
  return { status, callType: context.callType };
}

function remoteQueryTarget(
  context: CallEdgeContext,
  queryEntity: unknown,
): ReturnType<typeof buildRemoteQueryTarget> {
  return buildRemoteQueryTarget({
    queryEntity,
    servicePath: context.servicePath,
    serviceAlias: context.call.alias,
    serviceAliasExpr: context.call.aliasExpr,
    destination: context.destination,
    isDynamic: context.bindingDynamic,
    parserWarning: context.evidence.parserWarning,
  });
}

function insertRemoteEntityEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  if (!context.remoteEntity) return undefined;
  const resolution = context.resolution;
  if (resolution.target || resolution.candidates.length > 0
    || resolution.status === 'dynamic')
    return remoteEntityOperationEdge(context);
  const target = remoteQueryTarget(
    context, context.intent.entitySegment ?? context.call.query_entity,
  );
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, 'HANDLER_ACCESSES_REMOTE_ENTITY', 'terminal',
    'call', String(context.call.id), target.toKind, target.toId,
    Number(context.call.confidence ?? 0.5),
    JSON.stringify({
      ...context.evidence, ...target.evidence,
      remoteEntityAccess: context.callType,
    }),
    0, context.generation,
  );
  return { status: 'terminal', callType: context.callType };
}

function insertRemoteQueryEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  if (context.callType !== 'remote_query'
    || !context.entityQueryIntent && context.operation
    || context.resolution.target) return undefined;
  const target = remoteQueryTarget(context, context.call.query_entity);
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, 'HANDLER_RUNS_REMOTE_QUERY', 'terminal', 'call',
    String(context.call.id), target.toKind, target.toId,
    Number(context.call.confidence ?? 0.5),
    JSON.stringify({ ...context.evidence, ...target.evidence }),
    0, context.generation,
  );
  return { status: 'terminal', callType: context.callType };
}

function insertTransportEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  if (context.callType !== 'local_service_call'
    || context.call.unresolved_reason !== 'transport_client_method'
    || context.resolution.target
    || context.resolution.candidates.length > 0) return undefined;
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, 'HANDLER_CALLS_TRANSPORT_METHOD', 'terminal',
    'call', String(context.call.id), 'transport_method',
    String(context.operation || 'transport_client_method'),
    Number(context.call.confidence ?? 0.5),
    JSON.stringify({
      ...context.evidence, classification: 'transport_client_method',
    }),
    0, context.generation,
  );
  return { status: 'terminal', callType: context.callType };
}

function insertResolvedEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  return context.resolution.target
    ? resolvedOperationEdge(context) : undefined;
}

function insertEventEdge(
  context: CallEdgeContext,
): CallEdgeInsertionResult | undefined {
  if (context.callType !== 'async_emit'
    && context.callType !== 'async_subscribe') return undefined;
  return insertEventCallEdge(
    context.db, context.workspaceId, context.generation, context.call,
    context.variables, context.evidence,
  );
}

function fallbackEdgeType(context: CallEdgeContext): string {
  const fixed: Readonly<Record<string, string>> = {
    local_db_query: 'HANDLER_RUNS_DB_QUERY',
    external_http: 'HANDLER_CALLS_EXTERNAL_HTTP',
    async_emit: 'HANDLER_EMITS_EVENT',
    async_subscribe: 'EVENT_CONSUMED_BY_HANDLER',
  };
  return fixed[context.callType]
    ?? (context.resolution.status === 'dynamic'
      ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE');
}

function fallbackStatus(
  edgeType: string,
  resolution: OperationResolution,
): string {
  if (edgeType === 'DYNAMIC_EDGE_CANDIDATE') return 'dynamic';
  if (resolution.status === 'ambiguous') return 'ambiguous';
  return edgeType === 'UNRESOLVED_EDGE' ? 'unresolved' : 'terminal';
}

function fallbackTargetKind(
  context: CallEdgeContext,
  externalKind: string | undefined,
): string {
  if (context.callType === 'local_db_query') return 'db_entity';
  if (context.callType.startsWith('async_')) return 'event';
  if (context.callType === 'external_http')
    return externalKind ?? 'external_endpoint';
  return 'operation_candidate';
}

function remoteActionTarget(context: CallEdgeContext): string {
  if (context.operation) return `Remote action: ${context.operation}`;
  return context.call.unresolved_reason === 'dynamic_operation_path_identifier'
    ? 'Remote action: dynamic path' : 'Remote action: unknown path';
}

function fallbackTargetId(
  context: CallEdgeContext,
  externalId: string | undefined,
): string {
  if (context.callType === 'local_db_query')
    return String(context.call.query_entity ?? 'unknown');
  if (context.callType === 'remote_action') return remoteActionTarget(context);
  if (context.callType === 'external_http')
    return String(externalId ?? 'unknown');
  return String(
    context.call.event_name_expr ?? context.operation ?? 'unknown',
  );
}

function insertFallbackEdge(context: CallEdgeContext): CallEdgeInsertionResult {
  const edgeType = fallbackEdgeType(context);
  const status = fallbackStatus(edgeType, context.resolution);
  const unresolvedReason = status === 'terminal' ? null : String(
    context.call.unresolved_reason
      ?? unresolvedOperationReason(context.resolution),
  );
  const external = context.callType === 'external_http'
    ? externalHttpTarget(context.call) : undefined;
  const targetKind = fallbackTargetKind(context, external?.toKind);
  const targetId = fallbackTargetId(context, external?.toId);
  const dynamic = edgeType === 'DYNAMIC_EDGE_CANDIDATE'
    && context.resolution.status === 'dynamic';
  const evidence = external
    ? { ...context.evidence, externalTarget: external } : context.evidence;
  context.db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.workspaceId, edgeType, status, 'call', String(context.call.id),
    targetKind, targetId, Number(context.call.confidence ?? 0.2),
    JSON.stringify(evidence), dynamic ? 1 : 0, unresolvedReason,
    context.generation,
  );
  return { status, callType: context.callType };
}

export function insertCallEdge(
  db: Db,
  workspaceId: number,
  call: Record<string, unknown>,
  variables: Record<string, string>,
  generation: number,
): CallEdgeInsertionResult {
  const context = createCallEdgeContext(
    db, workspaceId, call, variables, generation,
  );
  const ambiguous = insertAmbiguousPathEdge(context);
  if (ambiguous) return ambiguous;
  const remoteEntity = insertRemoteEntityEdge(context);
  if (remoteEntity) return remoteEntity;
  const remoteQuery = insertRemoteQueryEdge(context);
  if (remoteQuery) return remoteQuery;
  const transport = insertTransportEdge(context);
  if (transport) return transport;
  const resolved = insertResolvedEdge(context);
  if (resolved) return resolved;
  const event = insertEventEdge(context);
  return event ?? insertFallbackEdge(context);
}

function operationCandidateCount(
  db: Db,
  workspaceId: number,
  operationPath: string | undefined,
  operationName: string | undefined,
): number {
  if (!operationPath && !operationName) return 0;
  const normalizedName = operationName
    ?? operationPath?.replace(/^\//, '').split('.').at(-1);
  const row = db.prepare(`SELECT COUNT(*) count FROM cds_operations o
    JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id
    WHERE r.workspace_id=? AND (
      o.operation_path=? OR o.operation_path=? OR o.operation_name=?
    )`).get(
    workspaceId, operationPath,
    normalizedName ? `/${normalizedName}` : operationPath,
    normalizedName,
  ) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function operationPrecedence(
  callType: string,
  intent: ODataPathIntent,
  indexedOperationCandidateCount: number,
  resolvedOperation: boolean,
): Record<string, unknown> {
  if (resolvedOperation) return {
    decision: 'operation',
    reason: 'indexed_operation_with_strong_service_context',
    indexedOperationCandidateCount,
  };
  if (callType === 'remote_action'
    && intent.kind === 'operation_invocation') return {
    decision: 'operation_candidate',
    rejectionReason: indexedOperationCandidateCount > 0
      ? 'indexed_candidates_lack_unique_strong_service_context'
      : 'no_indexed_operation_candidate',
    indexedOperationCandidateCount,
  };
  if (intent.kind.startsWith('entity_')) return {
    decision: 'entity',
    rejectionReason: indexedOperationCandidateCount > 0
      ? 'entity_shape_has_precedence_without_resolved_operation_context'
      : 'entity_shape_has_no_indexed_operation_evidence',
    indexedOperationCandidateCount,
  };
  return {
    decision: 'unresolved',
    rejectionReason: 'path_has_no_safe_entity_or_operation_precedence',
    indexedOperationCandidateCount,
  };
}

function unresolvedOperationReason(resolution: OperationResolution): string {
  if (resolution.status === 'dynamic')
    return `Dynamic target requires runtime variable overrides: ${
      (resolution.reasons.length
        ? resolution.reasons : ['missing runtime variables']).join(', ')}`;
  if (resolution.candidates.length === 0)
    return 'No indexed target operation matched';
  if (resolution.reasons.includes(
    'operation_path_only_has_no_strong_target_signal',
  )) return 'Operation candidates found but no strong service signal is available';
  if (resolution.reasons.includes(
    'candidate_score_below_resolution_threshold',
  )) return 'Operation candidates found but resolution score is below threshold';
  if (resolution.status === 'ambiguous')
    return 'Ambiguous operation candidates require a strong service signal';
  return 'Operation candidates found but resolution could not select a target';
}
