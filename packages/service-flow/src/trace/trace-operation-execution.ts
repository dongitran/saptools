import type { Db } from '../db/connection.js';
import type { TraceEdge } from '../types.js';
import { implementationHintDiagnostic } from './implementation-hints.js';
import { contextualImplementationSelection } from './implementation-selection.js';
import type { ContextBinding } from './contextual-runtime-state.js';
import {
  handlerMethodNode,
  withSelectedHandlerProvenance,
  type SelectedHandlerEvidence,
} from './selected-handler-provenance.js';
import type { TraversalScopeState } from './traversal-scope.js';
import type { TraceGraphEdgeRow } from './trace-graph-lookups.js';
import {
  enqueueCausalScope,
  type TraceQueueScope,
} from './trace-root-scopes.js';
import { parseTraceEvidence } from './trace-context.js';
import {
  recordCycleObservation,
  recordImplementationObservation,
} from './trace-edge-semantics.js';
import {
  handlerFilesForOperation,
  handlerScope,
  implementationScope,
} from './trace-implementation-scope.js';
import type {
  CallRow,
  EffectiveOutbound,
  TraceExecutionRuntime,
} from './trace-scope-execution.js';

interface OperationSelection {
  implementation: ReturnType<typeof implementationScope>;
  contextMethodId?: string;
  selectedHandlerAvailable: boolean;
}

export function processOperationTarget(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
): void {
  const selection = selectOperation(runtime, current, effective);
  if (current.depth >= runtime.maxDepth) return;
  scheduleOperation(runtime, current, call, effective, selection);
}

function selectOperation(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  effective: EffectiveOutbound,
): OperationSelection {
  const implementation = implementationScope(
    runtime.db, effective.row.to_id,
  );
  const context = contextualImplementationSelection(
    runtime.db, implementation.edge, effective.row.to_id,
    current.repoId, effective.evidence, runtime.hintOptions,
  );
  const available = implementation.edge
    ? recordOperationImplementation(runtime, current, effective,
      implementation.edge, context)
    : true;
  return {
    implementation,
    contextMethodId: context.methodId,
    selectedHandlerAvailable: available,
  };
}

function recordOperationImplementation(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  effective: EffectiveOutbound,
  edge: TraceGraphEdgeRow,
  context: ReturnType<typeof contextualImplementationSelection>,
): boolean {
  const evidence = parseTraceEvidence(edge.evidence_json);
  const hintDiagnostic = implementationHintDiagnostic(context, evidence);
  if (hintDiagnostic) runtime.diagnostics.unshift(hintDiagnostic);
  const methodId = edge.status === 'resolved' ? edge.to_id : context.methodId;
  const selectionEvidence = contextualSelectionEvidence(evidence, context);
  const selected = methodId
    ? withSelectedHandlerProvenance(
      selectionEvidence, methodId, handlerMethodNode(runtime.db, methodId),
    )
    : { evidence: selectionEvidence };
  recordSelectedOperation(
    runtime, current, effective, edge, context, methodId, selected,
  );
  return !selected.unresolvedReason;
}

function recordSelectedOperation(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  effective: EffectiveOutbound,
  edge: TraceGraphEdgeRow,
  context: ReturnType<typeof contextualImplementationSelection>,
  methodId: string | undefined,
  selected: SelectedHandlerEvidence,
): void {
  retainSelectedHandler(runtime, selected);
  const unresolvedReason = operationUnresolvedReason(edge, context, selected);
  const traceEdge = implementationTraceEdge(
    current.depth, effective.to, edge, selected, unresolvedReason,
  );
  const scope = methodId ? handlerScope(runtime.db, methodId) : undefined;
  recordImplementationObservation(runtime.recorder, traceEdge, {
    operationId: effective.row.to_id,
    handlerMethodId: methodId,
    handlerSymbolId: scope?.symbolId,
    graphEdgeId: edge.id,
    persistedStatus: edge.status,
    persistedTargetKind: edge.to_kind,
    persistedTargetId: edge.to_id,
    effectiveStatus: context.methodId ? 'resolved' : String(edge.status),
    strategy: implementationStrategy(context),
    guided: context.evidence.guided === true,
    contextual: contextualSelection(context),
    unresolvedReason,
    evidence: selected.evidence,
    site: effective.evidence,
  });
}

function retainSelectedHandler(
  runtime: TraceExecutionRuntime,
  selected: SelectedHandlerEvidence,
): void {
  if (selected.diagnostic) runtime.diagnostics.unshift(selected.diagnostic);
  if (selected.handler)
    runtime.nodes.set(String(selected.handler.id), selected.handler);
}

function operationUnresolvedReason(
  edge: TraceGraphEdgeRow,
  context: ReturnType<typeof contextualImplementationSelection>,
  selected: SelectedHandlerEvidence,
): string | undefined {
  if (selected.unresolvedReason) return selected.unresolvedReason;
  if (edge.status === 'resolved' || context.methodId) return undefined;
  return String(edge.unresolved_reason ?? edge.status);
}

function contextualSelection(
  context: ReturnType<typeof contextualImplementationSelection>,
): boolean {
  return Boolean(context.methodId)
    && context.evidence.strategy !== 'implementation_repo_hint';
}

function implementationStrategy(
  context: ReturnType<typeof contextualImplementationSelection>,
): string {
  return String(context.evidence.strategy
    ?? (context.methodId
      ? 'contextual_implementation_selection' : 'indexed_operation_graph'));
}

function contextualSelectionEvidence(
  evidence: Record<string, unknown>,
  context: ReturnType<typeof contextualImplementationSelection>,
): Record<string, unknown> {
  return context.methodId ? {
    ...evidence,
    contextualImplementationSelected:
      context.evidence.strategy !== 'implementation_repo_hint',
    contextualImplementation: context.evidence,
    implementationSelection: context.evidence,
  } : {
    ...evidence,
    contextualImplementation: context.evidence,
    implementationSelection: context.evidence,
  };
}

function implementationTraceEdge(
  depth: number,
  from: string,
  edge: TraceGraphEdgeRow,
  selected: SelectedHandlerEvidence,
  unresolvedReason: string | undefined,
): TraceEdge {
  return {
    step: depth,
    type: 'operation_implemented_by_handler',
    from,
    to: selected.handler?.label
      ? String(selected.handler.label) : `${edge.to_kind}:${edge.to_id}`,
    evidence: selected.evidence,
    confidence: Number(edge.confidence ?? 0),
    unresolvedReason,
  };
}

function scheduleOperation(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
  selection: OperationSelection,
): void {
  const contextScope = operationContextScope(runtime.db, selection);
  const files = operationFiles(runtime.db, effective, selection, contextScope);
  const symbols = operationSymbols(selection, contextScope);
  if (!operationCanSchedule(selection, contextScope, files)) return;
  scheduleOperationScope(
    runtime, current, call, effective, selection, contextScope, files, symbols,
  );
}

function operationContextScope(
  db: Db,
  selection: OperationSelection,
): ReturnType<typeof handlerScope> {
  return selection.contextMethodId
    ? handlerScope(db, selection.contextMethodId) : undefined;
}

function operationFiles(
  db: Db,
  effective: EffectiveOutbound,
  selection: OperationSelection,
  contextScope: ReturnType<typeof handlerScope>,
): Set<string> {
  if (contextScope) return contextScope.files;
  if (selection.implementation.files.size > 0)
    return selection.implementation.files;
  return handlerFilesForOperation(db, effective.row.to_id);
}

function operationSymbols(
  selection: OperationSelection,
  contextScope: ReturnType<typeof handlerScope>,
): Set<number> | undefined {
  if (contextScope?.symbolId) return new Set([contextScope.symbolId]);
  const symbolId = selection.implementation.symbolId;
  return symbolId ? new Set([symbolId]) : undefined;
}

function operationCanSchedule(
  selection: OperationSelection,
  contextScope: ReturnType<typeof handlerScope>,
  files: ReadonlySet<string>,
): boolean {
  if (!selection.selectedHandlerAvailable || files.size === 0) return false;
  const edge = selection.implementation.edge;
  if (!edge) return false;
  return edge.status === 'resolved' || contextScope !== undefined;
}

function scheduleOperationScope(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
  selection: OperationSelection,
  contextScope: ReturnType<typeof handlerScope>,
  files: Set<string>,
  symbols: Set<number> | undefined,
): void {
  const repoId = contextScope?.repoId ?? selection.implementation.repoId
    ?? operationRepositoryId(runtime.db, effective.row.to_id);
  const context = new Map<string, ContextBinding>();
  const scheduling = runtime.scheduler.schedule({
    workspaceId: runtime.workspaceId ?? call.workspaceId,
    repoId,
    files,
    symbolIds: symbols,
    context,
  }, current.state);
  if (scheduling.kind === 'cycle')
    recordOperationCycle(
      runtime, current, call, effective, scheduling.state,
      repoId, files, symbols,
    );
  if (scheduling.kind === 'scheduled')
    enqueueCausalScope(runtime.queue, runtime.pendingRoots, {
      repoId,
      files,
      symbolIds: symbols,
      depth: current.depth + 1,
      context,
      state: scheduling.state,
    });
}

function operationRepositoryId(
  db: Db,
  operationId: string,
): number | undefined {
  return db.prepare(`SELECT s.repo_id repoId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    WHERE o.id=?`).get(operationId)?.repoId as number | undefined;
}

function recordOperationCycle(
  runtime: TraceExecutionRuntime,
  current: TraceQueueScope,
  call: CallRow,
  effective: EffectiveOutbound,
  state: TraversalScopeState,
  repoId: number | undefined,
  files: Set<string>,
  symbols: Set<number> | undefined,
): void {
  const evidence = {
    ...effective.evidence,
    cycle: true,
    cycleReason: 'structural_ancestry_cycle',
  };
  const edge: TraceEdge = {
    step: current.depth,
    type: 'cycle',
    from: effective.to,
    to: state.structuralKey,
    evidence,
    confidence: 1,
    unresolvedReason:
      'Cycle detected in structural ancestry; downstream scope was not expanded',
  };
  recordCycleObservation(runtime.recorder, edge, effective.semantic.target, {
    workspaceId: effective.semanticWorkspaceId,
    repositoryId: repoId,
    sourceFiles: files,
    symbolIds: symbols,
    structuralKey: state.structuralKey,
  }, {
    graphEdgeId: effective.evidence.persistedGraphEdgeId,
    outboundCallId: call.id,
    operationId: effective.row.to_id,
  }, call);
}
