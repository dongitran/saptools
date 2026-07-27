import type { Db } from '../db/connection.js';
import type { TraceEdge, TraceOptions } from '../types.js';
import {
  baseTraceEvidence,
  runtimeResolution,
  type TraceGraphRow,
} from './evidence.js';
import { edgeTarget } from './edge-target.js';
import { dynamicCandidateBranches } from './dynamic-branches.js';
import {
  contextualRuntimeResolution,
  type ContextBinding,
  type ContextualGraphRow,
  type ContextualRuntimeResolution,
} from './contextual-runtime-state.js';
import {
  TraversalScopeScheduler,
  type TraversalScopeState,
} from './traversal-scope.js';
import type { PlannedEventSubscriberTransition } from './event-subscriber-traversal.js';
import {
  graphForCalls,
  symbolNode,
  type TraceGraphEdgeRow,
} from './trace-graph-lookups.js';
import {
  enqueueCausalScope,
  nextPendingRoot,
  type PendingTraceRootScope,
  type TraceQueueScope,
} from './trace-root-scopes.js';
import type { CompactSemanticEndpoint } from './compact-contract.js';
import { TraceEdgeRecorder } from './trace-edge-recorder.js';
import {
  knownBindingsForCalls,
  knownBindingsForScope,
  parseTraceEvidence,
  receiverFromTraceEvidence,
} from './trace-context.js';
import {
  recordCycleObservation,
  recordDynamicBranchObservation,
  recordEventBridgeObservation,
  recordEventCycleObservation,
  recordLocalCallObservation,
  recordOutboundObservation,
} from './trace-edge-semantics.js';
import { outboundScopeSymbolIds } from './nested-event-scopes.js';
import type { ImplementationHintOptions } from './trace-implementation-scope.js';
import { processOperationTarget } from './trace-operation-execution.js';
import { runtimeEventResolution, runtimeEventSubscriberPlans } from './event-runtime-resolution.js';
import { planLocalCallExpansion } from './local-call-expansion.js';
import {
  eventShapeRuntimeEvidence,
  outboundTraceEdgeType,
  outboundTraceTargetNode,
  visibleEventShapeRows,
} from './event-shape-candidate-trace.js';

export interface CallRow extends Record<string, unknown> {
  id: number;
  repo_id: number;
  repoName: string;
  source_file: string;
  source_line: number;
  call_type: string;
  confidence: number;
  source_symbol_id?: number;
  workspaceId: number;
  graphGeneration: number;
}

export interface EffectiveOutbound {
  evidence: Record<string, unknown>;
  row: TraceGraphRow;
  to: string;
  semanticWorkspaceId: number;
  semantic: {
    source: CompactSemanticEndpoint;
    target: CompactSemanticEndpoint;
  };
}

export interface TraceExecutionRuntime {
  db: Db;
  options: TraceOptions;
  hintOptions: ImplementationHintOptions;
  workspaceId?: number;
  maxDepth: number;
  scheduler: TraversalScopeScheduler;
  queue: TraceQueueScope[];
  pendingRoots: PendingTraceRootScope[];
  diagnostics: Array<Record<string, unknown>>;
  nodes: Map<string, Record<string, unknown>>;
  recorder: TraceEdgeRecorder;
}

function includeCall(type: string, options: TraceOptions): boolean {
  if (!options.includeDb && type === 'local_db_query') return false;
  if (!options.includeExternal && type === 'external_http') return false;
  if (!options.includeAsync && type.startsWith('async_')) return false;
  return true;
}

function nextTraceScope(
  runtime: TraceExecutionRuntime,
): TraceQueueScope | undefined {
  const depth = runtime.queue[0]?.depth ?? Number.POSITIVE_INFINITY;
  if (depth > 1 && runtime.workspaceId !== undefined) {
    const root = nextPendingRoot(
      runtime.pendingRoots, runtime.scheduler, runtime.workspaceId,
    );
    if (root) runtime.queue.unshift(root);
  }
  return runtime.queue.shift();
}

export function executeTraceScopes(runtime: TraceExecutionRuntime): void {
  while (runtime.queue.length > 0 || runtime.pendingRoots.length > 0) {
    const current = nextTraceScope(runtime);
    if (!current || current.depth > runtime.maxDepth) continue;
    if (!runtime.scheduler.markExpanded(current.state)) continue;
    processTraceScope(runtime, current);
  }
}

function processTraceScope(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
): void {
  const calls = callsForScope(runtime, current);
  const bindings = callerBindings(runtime.db, current, calls);
  processLocalCalls(runtime, current, bindings);
  const graph = graphForCalls(
    runtime.db, calls.map((call) => Number(call.id)),
  );
  for (const call of calls)
    processOutboundCall(runtime, current, bindings, call,
      graph.get(Number(call.id)) ?? []);
}

function callsForScope(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
): CallRow[] {
  const rows = runtime.db.prepare(`SELECT c.*,r.name repoName,
      r.workspace_id workspaceId,r.graph_generation graphGeneration
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE (? IS NULL OR c.repo_id=?) AND (? IS NULL OR r.workspace_id=?)
    ORDER BY c.source_file COLLATE BINARY,c.call_site_start_offset,
      c.call_site_end_offset,c.source_line,c.id`).all(
    current.repoId, current.repoId,
    runtime.workspaceId, runtime.workspaceId,
  ) as CallRow[];
  const symbols = outboundScopeSymbolIds(
    runtime.db, current.symbolIds, Boolean(runtime.options.includeAsync),
  );
  return rows.filter((call) =>
    callInScope(call, current, symbols)
    && includeCall(String(call.call_type), runtime.options));
}

function callInScope(
  call: CallRow,
  current: TraceQueueScope,
  symbols: ReadonlySet<number> | undefined,
): boolean {
  const ownerMatches = current.unownedOnly
    ? call.source_symbol_id == null
    : !symbols || symbols.has(Number(call.source_symbol_id));
  return ownerMatches
    && (!current.files || current.files.has(String(call.source_file)));
}

function callerBindings(
  db: Db,
  current: TraceQueueScope,
  calls: CallRow[],
): Map<string, ContextBinding> {
  return new Map<string, ContextBinding>([
    ...current.context,
    ...knownBindingsForScope(
      db, current.repoId, current.symbolIds, current.files,
    ),
    ...knownBindingsForCalls(db, calls),
  ]);
}

function localCallRows(
  db: Db,
  symbolIds: ReadonlySet<number>,
): Array<Record<string, unknown>> {
  const ids = [...symbolIds];
  return db.prepare(`SELECT sc.*,s.repo_id calleeRepoId,
      s.source_file calleeFile FROM symbol_calls sc
    LEFT JOIN symbols s ON s.id=sc.callee_symbol_id
    WHERE sc.call_role='ordinary_call'
      AND sc.caller_symbol_id IN (${ids.map(() => '?').join(',')})
    ORDER BY sc.source_file COLLATE BINARY,sc.call_site_start_offset,
      sc.call_site_end_offset,sc.source_line,sc.id`).all(
    ...ids,
  ) as Array<Record<string, unknown>>;
}

function processLocalCalls(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  bindings: Map<string, ContextBinding>,
): void {
  if (current.rootObservationOnly || !current.symbolIds
    || current.symbolIds.size === 0 || current.depth >= runtime.maxDepth) return;
  for (const row of localCallRows(runtime.db, current.symbolIds))
    processLocalCall(runtime, current, bindings, row);
}

function processLocalCall(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  bindings: Map<string, ContextBinding>,
  row: Record<string, unknown>,
): void {
  const symbolId = row.callee_symbol_id
    ? Number(row.callee_symbol_id) : undefined;
  const node = symbolId === undefined
    ? undefined : symbolNode(runtime.db, symbolId);
  if (node) runtime.nodes.set(String(node.id), node);
  const evidence = localCallEvidence(row, node);
  const unresolvedReason = localCallUnresolvedReason(row);
  const edge = localTraceEdge(current.depth, row, node, evidence, unresolvedReason);
  const target = recordLocalCallObservation(runtime.recorder, edge, {
    symbolCall: row, evidence, unresolvedReason,
  });
  if (symbolId === undefined || row.status !== 'resolved' || !node) return;
  const { repoId, files, symbols, context, scheduling } =
    planLocalCallExpansion(
      runtime.db, runtime.scheduler, runtime.workspaceId, current.state,
      row, bindings, symbolId,
    );
  if (scheduling.kind === 'cycle')
    recordLocalCycle(runtime, current, row, target, scheduling.state,
      repoId, files, symbols);
  if (scheduling.kind === 'scheduled')
    enqueueCausalScope(runtime.queue, runtime.pendingRoots, {
      repoId, files, symbolIds: symbols, depth: current.depth + 1,
      context, state: scheduling.state,
    });
}

function localCallEvidence(
  row: Record<string, unknown>,
  node: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...parseTraceEvidence(row.evidence_json),
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    calleeSymbolId: row.callee_symbol_id,
    calleeSymbolName: node?.symbolName,
    calleeSymbolFile: node?.sourceFile,
    resolutionStatus: row.status,
  };
}

function localCallUnresolvedReason(
  row: Record<string, unknown>,
): string | undefined {
  if (String(row.status) === 'resolved') return undefined;
  return row.unresolved_reason ? String(row.unresolved_reason) : undefined;
}

function localTraceEdge(
  depth: number,
  row: Record<string, unknown>,
  node: Record<string, unknown> | undefined,
  evidence: Record<string, unknown>,
  unresolvedReason: string | undefined,
): TraceEdge {
  return {
    step: depth,
    type: 'local_symbol_call',
    from: String(row.callee_expression),
    to: node?.label
      ? String(node.label)
      : `${String(row.status)}:${String(row.callee_expression)}`,
    evidence,
    confidence: Number(row.confidence ?? 0.8),
    unresolvedReason,
  };
}

function recordLocalCycle(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  row: Record<string, unknown>,
  target: CompactSemanticEndpoint,
  state: TraversalScopeState,
  repoId: number,
  files: Set<string>,
  symbols: Set<number>,
): void {
  const evidence = {
    cycle: true,
    cycleReason: 'structural_ancestry_cycle',
    symbolCallId: row.id,
  };
  const edge: TraceEdge = {
    step: current.depth,
    type: 'cycle',
    from: String(row.callee_expression),
    to: state.structuralKey,
    evidence,
    confidence: 1,
    unresolvedReason:
      'Cycle detected in structural ancestry; downstream symbol was not expanded',
  };
  recordCycleObservation(runtime.recorder, edge, target, {
    workspaceId: runtime.workspaceId,
    repositoryId: repoId,
    sourceFiles: files,
    symbolIds: symbols,
    structuralKey: state.structuralKey,
  }, { symbolCallId: row.id, symbolId: row.callee_symbol_id }, row);
}

function processOutboundCall(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  bindings: Map<string, ContextBinding>,
  call: CallRow,
  persistedRows: TraceGraphEdgeRow[],
): void {
  recordCallNode(runtime.nodes, call);
  const receiver = receiverFromTraceEvidence(call.evidence_json) ?? '';
  const contextual = contextualRuntimeResolution(
    runtime.db, call, bindings.get(receiver), call.workspaceId, persistedRows,
  );
  const rows = contextual.row
    ? [contextual.row]
    : visibleEventShapeRows(persistedRows, runtime.options);
  for (const row of rows)
    processOutboundRow(runtime, current, call, { ...row }, contextual);
}

function recordCallNode(
  nodes: Map<string, Record<string, unknown>>,
  call: CallRow,
): void {
  const id = `call:${call.id}`;
  nodes.set(id, {
    id,
    kind: 'outbound_call',
    repo: call.repoName,
    file: call.source_file,
    line: call.source_line,
    callType: call.call_type,
  });
}

function processOutboundRow(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  row: TraceGraphRow | ContextualGraphRow,
  contextual: ContextualRuntimeResolution,
): void {
  const graphRow: TraceGraphRow = { ...row };
  const effective = recordEffectiveOutbound(
    runtime, current, call, graphRow, contextual,
  );
  processEventTransitions(runtime, current, call, effective);
  recordDynamicBranches(runtime, current, call, effective);
  if (effective.row.to_kind === 'operation')
    processOperationTarget(runtime, current, call, effective);
}

function recordEffectiveOutbound(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  row: TraceGraphRow,
  contextual: ContextualRuntimeResolution,
): EffectiveOutbound {
  const persisted = parseTraceEvidence(row.evidence_json);
  const raw = baseTraceEvidence(row, call, persisted, contextual.evidence);
  const resolved = runtimeEventResolution(row, raw, runtime.options.vars)
    ?? runtimeResolution(runtime.db, row, raw, {
      vars: runtime.options.vars,
      dynamicMode: runtime.options.dynamicMode ?? 'strict',
      maxDynamicCandidates: runtime.options.maxDynamicCandidates,
    }, call.workspaceId, contextual.state);
  const effective = {
    ...resolved,
    evidence: eventShapeRuntimeEvidence(
      runtime.db, call.workspaceId, call.id, call.call_type,
      resolved.evidence, runtime.options.vars,
    ),
  };
  const target = `${effective.row.to_kind}:${effective.row.to_id}`;
  runtime.nodes.set(
    target, outboundTraceTargetNode(runtime.db, target, effective.row),
  );
  const to = edgeTarget(effective.row, effective.evidence);
  const edge = outboundTraceEdge(
    current.depth, call, effective.row, to,
    effective.evidence, effective.unresolvedReason,
  );
  const semanticWorkspaceId = runtime.workspaceId ?? call.workspaceId;
  const semantic = recordOutboundObservation(runtime.recorder, edge, {
    call,
    row: effective.row,
    evidence: effective.evidence,
    workspaceId: semanticWorkspaceId,
    dynamicMode: runtime.options.dynamicMode,
    unresolvedReason: effective.unresolvedReason,
  });
  return {
    evidence: effective.evidence,
    row: effective.row,
    to,
    semanticWorkspaceId,
    semantic,
  };
}

function outboundTraceEdge(
  depth: number,
  call: CallRow,
  row: TraceGraphRow,
  to: string,
  evidence: Record<string, unknown>,
  unresolvedReason: string | undefined,
): TraceEdge {
  return {
    step: depth,
    type: outboundTraceEdgeType(call, row),
    from: `${call.repoName}:${call.source_file}:${call.source_line}`,
    to,
    evidence,
    confidence: Number(row.confidence ?? call.confidence),
    unresolvedReason,
  };
}

function processEventTransitions(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
): void {
  if (!runtime.options.includeAsync || call.call_type !== 'async_emit'
    || effective.row.edge_type !== 'HANDLER_EMITS_EVENT'
    || effective.row.to_kind !== 'event') return;
  const planned = runtimeEventSubscriberPlans(
    runtime.db, {
      workspaceId: runtime.workspaceId ?? call.workspaceId,
      graphGeneration: call.graphGeneration,
      eventName: effective.row.to_id,
      vars: runtime.options.vars ?? {},
    }, runtime.scheduler, current.state, current.depth, runtime.maxDepth,
  );
  if (planned.diagnostic) runtime.diagnostics.push(planned.diagnostic);
  for (const plan of planned.plans)
    recordEventTransition(runtime, current, plan,
      effective.semanticWorkspaceId, planned.plans.length);
}

function recordEventTransition(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  plan: PlannedEventSubscriberTransition,
  workspaceId: number,
  subscriptionCount: number,
): void {
  const nodeId = String(plan.node.id);
  const targetLabel = String(plan.node.label ?? nodeId);
  runtime.nodes.set(nodeId, plan.node);
  const bridge: TraceEdge = {
    step: current.depth,
    type: 'event_name_matches_subscription_handler',
    from: plan.transition.eventName,
    to: targetLabel,
    evidence: plan.evidence,
    confidence: plan.transition.confidence,
    unresolvedReason: plan.transition.unresolvedReason,
  };
  const target = recordEventBridgeObservation(
    runtime.recorder, bridge, plan, workspaceId, subscriptionCount,
  );
  if (plan.bodyExpansion === 'cycle_blocked' && plan.state)
    recordEventCycle(runtime, current, plan, target, targetLabel, workspaceId);
  if (plan.bodyExpansion === 'scheduled' && plan.state
    && plan.transition.handler)
    enqueueEventHandler(runtime, current, plan);
}

function recordEventCycle(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  plan: PlannedEventSubscriberTransition,
  target: CompactSemanticEndpoint,
  targetLabel: string,
  workspaceId: number,
): void {
  if (!plan.state) return;
  const evidence = {
    cycle: true,
    cycleReason: 'structural_ancestry_cycle',
    graphEdgeId: plan.transition.graphEdgeId,
  };
  const edge: TraceEdge = {
    step: current.depth,
    type: 'cycle',
    from: targetLabel,
    to: plan.state.structuralKey,
    evidence,
    confidence: 1,
    unresolvedReason:
      'Cycle detected across an event subscriber boundary; downstream symbol was not expanded',
  };
  recordEventCycleObservation(
    runtime.recorder, edge, plan, target, workspaceId,
  );
}

function enqueueEventHandler(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  plan: PlannedEventSubscriberTransition,
): void {
  const handler = plan.transition.handler;
  if (!handler || !plan.state) return;
  enqueueCausalScope(runtime.queue, runtime.pendingRoots, {
    repoId: handler.repoId,
    files: new Set([handler.sourceFile]),
    symbolIds: new Set([handler.symbolId]),
    depth: current.depth + 1,
    context: new Map(),
    state: plan.state,
  });
}

function recordDynamicBranches(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
): void {
  if ((runtime.options.dynamicMode ?? 'strict') !== 'candidates'
    || effective.row.status === 'resolved') return;
  for (const branch of dynamicCandidateBranches(
    current.depth, call, effective.evidence,
  )) {
    recordDynamicBranchObservation(
      runtime.recorder, branch, call, effective.semantic.source,
      effective.evidence, effective.semanticWorkspaceId,
    );
  }
}
