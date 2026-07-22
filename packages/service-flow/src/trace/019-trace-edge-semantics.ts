import type { TraceEdge } from '../types.js';
import type { CompactSemanticEndpoint, CompactStatus } from './014-compact-contract.js';
import {
  compactDecisionFromEvidence,
  compactEventStatus,
  compactGraphStatus,
  compactRefs,
  compactResolutionStatus,
  compactSite,
  semanticCallSource,
  semanticGraphTarget,
  semanticHandler,
  semanticOperation,
  semanticScopeTarget,
  semanticSymbol,
  type SemanticCallRow,
  type SemanticTargetRow,
  type TraceEdgeRecorder,
} from './015-trace-edge-recorder.js';
import type { PlannedEventSubscriberTransition } from './011-event-subscriber-traversal.js';
import type { DynamicCandidateBranch } from './dynamic-branches.js';

interface ImplementationObservation {
  operationId: unknown;
  handlerMethodId?: unknown;
  handlerSymbolId?: unknown;
  graphEdgeId?: unknown;
  persistedStatus?: string;
  persistedTargetKind?: string;
  persistedTargetId?: string;
  effectiveStatus: string;
  strategy: string;
  guided?: boolean;
  contextual?: boolean;
  unresolvedReason?: string;
  evidence: Record<string, unknown>;
  site: Record<string, unknown>;
}

interface LocalCallObservation {
  symbolCall: Record<string, unknown>;
  evidence: Record<string, unknown>;
  unresolvedReason?: string;
}

interface ScopeObservation {
  workspaceId?: number;
  repositoryId?: number;
  sourceFiles?: ReadonlySet<string>;
  symbolIds?: ReadonlySet<number>;
  structuralKey: string;
}

interface OutboundObservation {
  call: SemanticCallRow;
  row: SemanticTargetRow;
  evidence: Record<string, unknown>;
  workspaceId: number;
  dynamicMode?: string;
  unresolvedReason?: string;
}

export function recordImplementationObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  input: ImplementationObservation,
): void {
  const target = semanticHandler(input.handlerMethodId, input.handlerSymbolId,
    () => recorder.unavailable('target', 'selected_handler'));
  recorder.record(edge, {
    source: semanticOperation(input.operationId,
      () => recorder.unavailable('source', 'operation')),
    target,
    status: compactResolutionStatus(input.effectiveStatus, input.unresolvedReason),
    decision: compactDecisionFromEvidence(input.evidence, {
      effectiveResolutionStatus: input.unresolvedReason
        ? 'unresolved' : input.effectiveStatus,
      effectiveTarget: decisionTarget(target),
      persistedResolutionStatus: input.persistedStatus,
      persistedTarget: input.persistedTargetKind && input.persistedTargetId
        ? { kind: input.persistedTargetKind, id: input.persistedTargetId }
        : undefined,
      implementationStrategy: input.strategy,
      implementationGuided: input.guided,
      implementationContextual: input.contextual,
      reasonCode: input.unresolvedReason
        ? 'selected_handler_unavailable' : undefined,
    }),
    refs: compactRefs({ graphEdgeId: input.graphEdgeId,
      operationId: input.operationId,
      handlerMethodId: input.handlerMethodId,
      symbolId: input.handlerSymbolId }),
    site: compactSite(input.site),
  });
}

export function recordLocalCallObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  input: LocalCallObservation,
): CompactSemanticEndpoint {
  const source = semanticSymbol(input.symbolCall.caller_symbol_id,
    () => recorder.unavailable('source', 'caller_symbol'));
  const target = semanticSymbol(input.symbolCall.callee_symbol_id,
    () => recorder.unavailable('target', 'callee_symbol'));
  recorder.record(edge, {
    source, target,
    status: compactResolutionStatus(
      input.symbolCall.status, input.unresolvedReason,
    ),
    decision: compactDecisionFromEvidence(input.evidence, {
      effectiveResolutionStatus: String(input.symbolCall.status),
      reasonCode: input.unresolvedReason ? 'symbol_call_unresolved' : undefined,
    }),
    refs: { symbolCallIds: idArray(input.symbolCall.id),
      symbolIds: idArray(input.symbolCall.caller_symbol_id,
        input.symbolCall.callee_symbol_id) },
    site: compactSite(input.symbolCall),
  });
  return target;
}

export function recordCycleObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  source: CompactSemanticEndpoint,
  scope: ScopeObservation,
  refs: Record<string, unknown>,
  site: Record<string, unknown>,
): void {
  recorder.record(edge, {
    source,
    target: scope.workspaceId === undefined
      ? recorder.unavailable('target', 'cycle_scope')
      : semanticScopeTarget(scope.workspaceId, scope.repositoryId,
          scope.sourceFiles, scope.symbolIds, scope.structuralKey),
    status: 'cycle',
    decision: compactDecisionFromEvidence(edge.evidence, {
      reasonCode: 'structural_ancestry_cycle',
    }),
    refs: compactRefs(refs),
    site: compactSite(site),
  });
}

export function recordOutboundObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  input: OutboundObservation,
): { source: CompactSemanticEndpoint; target: CompactSemanticEndpoint } {
  const source = semanticCallSource(input.call, input.workspaceId);
  const target = semanticGraphTarget(
    input.row, input.call, input.workspaceId,
    () => recorder.unavailable('target', input.row.to_kind),
  );
  recorder.record(edge, {
    source, target,
    status: compactGraphStatus(input.row, input.evidence,
      input.unresolvedReason, input.dynamicMode),
    decision: compactDecisionFromEvidence(input.evidence, {
      reasonCode: input.unresolvedReason
        ? safeReasonCode(input.evidence.reasonCode, 'outbound_target_unresolved')
        : undefined,
    }),
    refs: compactRefs({
      graphEdgeId: positiveId(input.evidence.persistedGraphEdgeId),
      outboundCallId: input.call.id,
      operationId: input.row.to_kind === 'operation' ? input.row.to_id : undefined,
      symbolId: input.call.source_symbol_id,
    }),
    site: compactSite(input.call),
  });
  return { source, target };
}

export function recordEventBridgeObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  plan: PlannedEventSubscriberTransition,
  workspaceId: number,
  subscriptionCount: number,
): CompactSemanticEndpoint {
  const handler = plan.transition.handler;
  const target: CompactSemanticEndpoint = handler
    ? { kind: 'symbol', symbolId: handler.symbolId }
    : { kind: 'target', workspaceId,
        repositoryId: plan.transition.subscriptionRepoId,
        targetKind: plan.transition.targetKind,
        targetId: plan.transition.targetId };
  recorder.record(edge, {
    source: { kind: 'event', workspaceId,
      eventName: plan.transition.eventName },
    target,
    status: compactEventStatus(plan.transition.status, plan.bodyExpansion),
    decision: compactDecisionFromEvidence(plan.evidence, {
      eventSubscriptionCount: subscriptionCount,
      reasonCode: plan.transition.reasonCode,
    }),
    refs: eventReferences(plan),
    site: eventSite(plan),
  });
  return target;
}

export function recordEventCycleObservation(
  recorder: TraceEdgeRecorder,
  edge: TraceEdge,
  plan: PlannedEventSubscriberTransition,
  source: CompactSemanticEndpoint,
  workspaceId: number,
): void {
  const handler = plan.transition.handler;
  if (!plan.state) return;
  recorder.record(edge, {
    source,
    target: semanticScopeTarget(workspaceId, handler?.repoId,
      handler ? new Set([handler.sourceFile]) : undefined,
      handler ? new Set([handler.symbolId]) : undefined,
      plan.state.structuralKey),
    status: 'cycle',
    decision: compactDecisionFromEvidence(edge.evidence, {
      reasonCode: 'structural_ancestry_cycle',
      dispatchCertainty: 'static_name_only',
    }),
    refs: eventReferences(plan),
    site: eventSite(plan),
  });
}

export function recordDynamicBranchObservation(
  recorder: TraceEdgeRecorder,
  branch: DynamicCandidateBranch,
  call: SemanticCallRow,
  source: CompactSemanticEndpoint,
  evidence: Record<string, unknown>,
  workspaceId: number,
): void {
  const target = dynamicBranchTarget(recorder, branch, workspaceId);
  recorder.record(branch.edge, {
    source, target, status: 'dynamic',
    decision: compactDecisionFromEvidence(evidence, {
      dynamicMode: 'candidates',
      effectiveTarget: branch.operationId === undefined
        ? undefined : { kind: 'operation', id: String(branch.operationId) },
      remediationCode: 'provide_runtime_variables',
    }),
    refs: compactRefs({ graphEdgeId: positiveId(evidence.persistedGraphEdgeId),
      outboundCallId: call.id, operationId: branch.operationId,
      symbolId: call.source_symbol_id }),
    site: compactSite(call),
  });
}

function dynamicBranchTarget(
  recorder: TraceEdgeRecorder,
  branch: DynamicCandidateBranch,
  workspaceId: number,
): CompactSemanticEndpoint {
  if (branch.operationId !== undefined)
    return { kind: 'operation', operationId: branch.operationId };
  if (branch.servicePath && branch.operationPath) return {
    kind: 'target', workspaceId,
    repositoryId: branch.repositoryId,
    targetKind: 'dynamic_operation_candidate',
    targetId: JSON.stringify([branch.servicePath, branch.operationPath]),
  };
  return recorder.unavailable('target', 'dynamic_operation_candidate');
}

export function graphObservationStatus(
  row: SemanticTargetRow,
  evidence: Record<string, unknown>,
  unresolvedReason: string | undefined,
  dynamicMode: string | undefined,
): CompactStatus {
  return compactGraphStatus(row, evidence, unresolvedReason, dynamicMode);
}

function eventReferences(
  plan: PlannedEventSubscriberTransition,
): ReturnType<typeof compactRefs> {
  return compactRefs({ graphEdgeId: plan.transition.graphEdgeId,
    subscribeCallId: plan.transition.subscribeCallId,
    symbolCallId: plan.transition.symbolCallId,
    symbolId: plan.transition.handler?.symbolId });
}

function eventSite(
  plan: PlannedEventSubscriberTransition,
): ReturnType<typeof compactSite> {
  return compactSite({ repository: plan.transition.subscriptionRepoName,
    sourceFile: plan.transition.sourceFile,
    sourceLine: plan.transition.sourceLine,
    startOffset: plan.transition.callSiteStartOffset,
    endOffset: plan.transition.callSiteEndOffset });
}

function safeReasonCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value)
    ? value : fallback;
}

function positiveId(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
    ? value : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) return numeric > 0 ? numeric : undefined;
  return value;
}

function idArray(...values: unknown[]): Array<number | string> | undefined {
  const ids = values.flatMap((value) => {
    const id = positiveId(value);
    return id === undefined ? [] : [id];
  });
  return ids.length > 0 ? ids : undefined;
}

function decisionTarget(
  endpoint: CompactSemanticEndpoint,
): { kind: string; id: string } | undefined {
  if (endpoint.kind === 'symbol')
    return { kind: 'symbol', id: String(endpoint.symbolId) };
  if (endpoint.kind === 'handler_method')
    return { kind: 'handler_method', id: String(endpoint.handlerMethodId) };
  return undefined;
}
