import type { Db } from '../db/connection.js';
import type { TraceEdge } from '../types.js';
import { hintedImplementationSelection } from './implementation-selection.js';
import {
  handlerMethodNode,
  withSelectedHandlerProvenance,
  type SelectedHandlerEvidence,
} from './selected-handler-provenance.js';
import {
  operationNode,
  type TraceGraphEdgeRow,
} from './trace-graph-lookups.js';
import { parseTraceEvidence } from './trace-context.js';
import { recordImplementationObservation } from './trace-edge-semantics.js';
import {
  handlerScope,
  implementationScope,
} from './trace-implementation-scope.js';
import type { TraceExecutionRuntime } from './trace-scope-execution.js';

interface StartImplementationSelection {
  edge: TraceGraphEdgeRow;
  operationNode?: Record<string, unknown>;
  selectedMethodId?: string;
  selected: SelectedHandlerEvidence;
  selectedSymbolId?: number;
  effectiveStatus: string;
  strategy: string;
  guided: boolean;
  unresolvedReason?: string;
}

function selectedStartImplementation(
  runtime: TraceExecutionRuntime,
  operationId: string,
): StartImplementationSelection | undefined {
  const operation = operationNode(runtime.db, operationId);
  if (operation) runtime.nodes.set(String(operation.id), operation);
  const implementation = implementationScope(runtime.db, operationId);
  const startSelection = hintedImplementationSelection(
    runtime.db, implementation.edge, operationId, runtime.hintOptions,
  );
  const edge = implementation.edge;
  if (!edge) return undefined;
  const selectedMethodId = startSelectedMethod(edge, startSelection.methodId);
  if (!selectedMethodId && edge.status !== 'resolved') return undefined;
  const evidence = startImplementationEvidence(
    edge, operationId, selectedMethodId, startSelection,
  );
  const selected = startSelectedHandler(
    runtime.db, evidence, selectedMethodId,
  );
  const scope = selectedMethodId
    ? handlerScope(runtime.db, selectedMethodId) : undefined;
  return {
    edge, operationNode: operation, selectedMethodId, selected,
    selectedSymbolId: scope?.symbolId,
    effectiveStatus: startEffectiveStatus(edge, startSelection.methodId),
    strategy: startStrategy(startSelection.evidence.strategy),
    guided: startSelection.evidence.guided === true,
    unresolvedReason: startUnresolvedReason(
      edge, selected, startSelection.methodId,
    ),
  };
}

function startSelectedMethod(
  edge: TraceGraphEdgeRow,
  hintedMethodId: string | undefined,
): string | undefined {
  return edge.status === 'resolved' ? edge.to_id : hintedMethodId;
}

function startSelectedHandler(
  db: Db,
  evidence: Record<string, unknown>,
  methodId: string | undefined,
): SelectedHandlerEvidence {
  if (!methodId) return { evidence };
  return withSelectedHandlerProvenance(
    evidence, methodId, handlerMethodNode(db, methodId),
  );
}

function startEffectiveStatus(
  edge: TraceGraphEdgeRow,
  hintedMethodId: string | undefined,
): string {
  return hintedMethodId ? 'resolved' : String(edge.status ?? 'unresolved');
}

function startStrategy(value: unknown): string {
  return typeof value === 'string' ? value : 'indexed_operation_graph';
}

function startUnresolvedReason(
  edge: TraceGraphEdgeRow,
  selected: SelectedHandlerEvidence,
  hintedMethodId: string | undefined,
): string | undefined {
  if (selected.unresolvedReason) return selected.unresolvedReason;
  if (edge.status === 'resolved' || hintedMethodId) return undefined;
  return String(edge.unresolved_reason ?? edge.status);
}

function startImplementationEvidence(
  edge: TraceGraphEdgeRow,
  operationId: string,
  selectedMethodId: string | undefined,
  selection: ReturnType<typeof hintedImplementationSelection>,
): Record<string, unknown> {
  return {
    ...parseTraceEvidence(edge.evidence_json),
    startResolution: {
      strategy: 'indexed_operation_graph',
      matchedOperationId: operationId,
      implementationEdgeId: edge.id,
      implementationStatus: edge.status,
      selectedHandlerMethodId: selectedMethodId,
    },
    implementationSelection: selection.methodId
      ? selection.evidence : undefined,
  };
}

export function recordTraceStartImplementation(
  runtime: TraceExecutionRuntime,
  operationId: string,
): void {
  const selection = selectedStartImplementation(runtime, operationId);
  if (!selection) return;
  const selected = selection.selected;
  if (selected.diagnostic)
    runtime.diagnostics.unshift(selected.diagnostic);
  if (selected.handler)
    runtime.nodes.set(String(selected.handler.id), selected.handler);
  const edge = startImplementationTraceEdge(operationId, selection);
  recordImplementationObservation(runtime.recorder, edge, {
    operationId,
    handlerMethodId: selection.selectedMethodId,
    handlerSymbolId: selection.selectedSymbolId,
    graphEdgeId: selection.edge.id,
    persistedStatus: selection.edge.status,
    persistedTargetKind: selection.edge.to_kind,
    persistedTargetId: selection.edge.to_id,
    effectiveStatus: selection.effectiveStatus,
    strategy: selection.strategy,
    guided: selection.guided,
    unresolvedReason: selection.unresolvedReason,
    evidence: selected.evidence,
    site: selection.operationNode ?? {},
  });
}

function startImplementationTraceEdge(
  operationId: string,
  selection: StartImplementationSelection,
): TraceEdge {
  const selected = selection.selected;
  return {
    step: 1,
    type: 'operation_implemented_by_handler',
    from: selection.operationNode?.label
      ? String(selection.operationNode.label) : `operation:${operationId}`,
    to: selected.handler?.label
      ? String(selected.handler.label)
      : `${selection.edge.to_kind}:${selection.edge.to_id}`,
    evidence: selected.evidence,
    confidence: Number(selection.edge.confidence ?? 0),
    unresolvedReason: selection.unresolvedReason,
  };
}
