import type { TraceEdge } from '../types.js';
import type {
  CompactDecisionInput,
  CompactEdgeObservation,
  CompactReferenceInput,
  CompactSemanticEndpoint,
  CompactSourceSite,
  CompactStatus,
  CompactTraceObserver,
} from './014-compact-contract.js';

export interface TraceEdgeSemantics {
  source: CompactSemanticEndpoint;
  target: CompactSemanticEndpoint;
  status: CompactStatus;
  decision?: CompactDecisionInput;
  refs?: CompactReferenceInput;
  site?: CompactSourceSite;
}

export interface SemanticCallRow extends Record<string, unknown> {
  id: number;
  repo_id: number;
  repoName: string;
  source_file: string;
  source_line: number;
  source_symbol_id?: number;
}

export interface SemanticTargetRow extends Record<string, unknown> {
  to_kind: string;
  to_id: string;
  status?: string;
}

const nonResolvedGraphStatuses: Readonly<Record<string, CompactStatus>> = {
  ambiguous: 'ambiguous', dynamic: 'dynamic', terminal: 'terminal',
};

export class TraceEdgeRecorder {
  constructor(
    private readonly edges: TraceEdge[],
    private readonly observer?: CompactTraceObserver,
  ) {}

  record(edge: TraceEdge, semantics: TraceEdgeSemantics): number {
    const ordinal = this.edges.length;
    this.edges.push(edge);
    this.observer?.record(observation(ordinal, edge, semantics));
    return ordinal;
  }

  unavailable(
    side: 'source' | 'target',
    endpointKind: string,
  ): CompactSemanticEndpoint {
    return { kind: 'unavailable', side, endpointKind,
      detailedEdgeIndex: this.edges.length };
  }
}

export function semanticCallSource(
  call: SemanticCallRow,
  workspaceId: number,
): CompactSemanticEndpoint {
  const symbolId = positiveNumber(call.source_symbol_id);
  if (symbolId !== undefined) return { kind: 'symbol', symbolId };
  return {
    kind: 'call_site', workspaceId, repositoryId: call.repo_id,
    repositoryName: call.repoName, sourceFile: call.source_file,
    sourceLine: call.source_line,
    startOffset: finiteNumber(call.call_site_start_offset),
    endOffset: finiteNumber(call.call_site_end_offset), callId: call.id,
  };
}

export function semanticOperation(
  value: unknown,
  unavailable: () => CompactSemanticEndpoint,
): CompactSemanticEndpoint {
  const operationId = positiveNumber(value);
  return operationId === undefined ? unavailable()
    : { kind: 'operation', operationId };
}

export function semanticSymbol(
  value: unknown,
  unavailable: () => CompactSemanticEndpoint,
): CompactSemanticEndpoint {
  const symbolId = positiveNumber(value);
  return symbolId === undefined ? unavailable() : { kind: 'symbol', symbolId };
}

export function semanticHandler(
  methodIdValue: unknown,
  symbolIdValue: unknown,
  unavailable: () => CompactSemanticEndpoint,
): CompactSemanticEndpoint {
  const symbolId = positiveNumber(symbolIdValue);
  if (symbolId !== undefined) return { kind: 'symbol', symbolId };
  const handlerMethodId = positiveNumber(methodIdValue);
  return handlerMethodId === undefined ? unavailable()
    : { kind: 'handler_method', handlerMethodId };
}

export function semanticGraphTarget(
  row: SemanticTargetRow,
  call: Record<string, unknown>,
  workspaceId: number,
  unavailable: () => CompactSemanticEndpoint,
): CompactSemanticEndpoint {
  if (row.to_kind === 'event') return {
    kind: 'event', workspaceId,
    eventName: typeof call.event_name_expr === 'string'
      ? call.event_name_expr : row.to_id,
  };
  const id = positiveNumber(row.to_id);
  if (row.to_kind === 'operation')
    return id === undefined ? unavailable() : { kind: 'operation', operationId: id };
  if (row.to_kind === 'symbol')
    return id === undefined ? unavailable() : { kind: 'symbol', symbolId: id };
  if (row.to_kind === 'handler_method') return id === undefined
    ? unavailable() : { kind: 'handler_method', handlerMethodId: id };
  return { kind: 'target', workspaceId,
    repositoryId: positiveNumber(call.repo_id), targetKind: row.to_kind,
    targetId: row.to_id };
}

export function semanticScopeTarget(
  workspaceId: number,
  repositoryId: number | undefined,
  sourceFiles: ReadonlySet<string> | undefined,
  symbolIds: ReadonlySet<number> | undefined,
  structuralKey: string,
): CompactSemanticEndpoint {
  return {
    kind: 'scope', workspaceId, repositoryId,
    sourceFiles: [...(sourceFiles ?? [])],
    symbolIds: [...(symbolIds ?? [])], structuralKey,
  };
}

export function compactGraphStatus(
  row: SemanticTargetRow,
  evidence: Record<string, unknown>,
  unresolvedReason: string | undefined,
  dynamicMode: string | undefined,
): CompactStatus {
  const effective = recordValue(evidence.effectiveResolution);
  const status = stringValue(effective.status) ?? row.status ?? 'unresolved';
  if (status !== 'resolved')
    return nonResolvedGraphStatuses[status] ?? 'unresolved';
  if (unresolvedReason) return 'unresolved';
  const inference = recordValue(evidence.dynamicTargetInference);
  if (isDynamicInference(dynamicMode, inference)) return 'dynamic';
  return traversableTargetKind(row.to_kind) ? 'resolved' : 'terminal';
}

function isDynamicInference(
  mode: string | undefined,
  evidence: Record<string, unknown>,
): boolean {
  return mode === 'infer' && evidence.status === 'resolved';
}

function traversableTargetKind(kind: string): boolean {
  return ['operation', 'symbol', 'handler_method'].includes(kind);
}

export function compactResolutionStatus(
  status: unknown,
  unresolvedReason?: string,
): CompactStatus {
  if (status === 'ambiguous') return 'ambiguous';
  if (status === 'dynamic') return 'dynamic';
  return status === 'resolved' && !unresolvedReason ? 'resolved' : 'unresolved';
}

export function compactEventStatus(
  status: unknown,
  bodyExpansion: unknown,
): CompactStatus {
  if (bodyExpansion === 'cycle_blocked') return 'cycle';
  if (status === 'ambiguous') return 'ambiguous';
  return status === 'resolved' ? 'inferred' : 'unresolved';
}

export function compactDecisionFromEvidence(
  evidence: Record<string, unknown>,
  overrides: CompactDecisionInput = {},
): CompactDecisionInput {
  const effective = recordValue(evidence.effectiveResolution);
  const persisted = recordValue(evidence.persistedResolution);
  const dynamic = recordValue(evidence.dynamicTargetExploration);
  const implementation = recordValue(evidence.implementationSelection);
  const missing = stringArray(dynamic.missingVariables
    ?? evidence.missingRuntimeVariables);
  const authoritativeMissingCount = finiteNumber(
    dynamic.missingVariableCount ?? evidence.missingVariableCount,
  );
  return {
    effectiveResolutionStatus: stringValue(effective.status),
    effectiveTarget: targetSummary(effective),
    persistedResolutionStatus: stringValue(persisted.status),
    persistedTarget: targetSummary(persisted),
    missingVariableNames: missing.length > 0 ? missing : undefined,
    missingVariableCount: authoritativeMissingCount
      ?? (missing.length > 0 ? missing.length : undefined),
    dynamicMode: dynamicMode(dynamic.mode),
    candidateCount: firstNumber(
      dynamic.candidateCount,
      implementation.candidateCount,
      implementation.candidateScoreCount,
      evidence.candidateCount,
      evidence.persistedCandidateCount,
    ),
    viableCandidateCount: finiteNumber(dynamic.viableCandidateCount),
    rejectedCandidateCount: finiteNumber(dynamic.rejectedCandidateCount),
    omittedCandidateCount: finiteNumber(dynamic.omittedCandidateCount),
    implementationStrategy: stringValue(implementation.strategy),
    implementationGuided: booleanValue(implementation.guided),
    implementationContextual: booleanValue(
      evidence.contextualImplementationSelected),
    reasonCode: stringValue(evidence.reasonCode ?? evidence.cycleReason),
    eventMatchStrategy: stringValue(evidence.matchStrategy),
    dispatchCertainty: stringValue(evidence.dispatchCertainty),
    associationStatus: stringValue(evidence.associationStatus),
    associationBasis: stringValue(evidence.associationBasis),
    eventScope: stringValue(evidence.dispatchScope),
    callRole: stringValue(evidence.callRole),
    factOrigin: stringValue(evidence.factOrigin),
    roleSiteMatchCount: finiteNumber(evidence.roleSiteMatchCount),
    bodyExpansion: stringValue(evidence.bodyExpansion),
    ...overrides,
  };
}

export function compactRefs(
  values: Record<string, unknown>,
): CompactReferenceInput {
  return {
    graphEdgeIds: reference(values.graphEdgeId),
    outboundCallIds: reference(values.outboundCallId),
    subscribeCallIds: reference(values.subscribeCallId),
    symbolCallIds: reference(values.symbolCallId),
    operationIds: reference(values.operationId),
    symbolIds: reference(values.symbolId),
    handlerMethodIds: reference(values.handlerMethodId),
  };
}

export function compactSite(
  values: Record<string, unknown>,
): CompactSourceSite {
  return {
    repository: stringValue(values.repository ?? values.repoName),
    sourceFile: stringValue(values.sourceFile ?? values.source_file),
    sourceLine: finiteNumber(values.sourceLine ?? values.source_line),
    startOffset: finiteNumber(values.startOffset ?? values.call_site_start_offset),
    endOffset: finiteNumber(values.endOffset ?? values.call_site_end_offset),
  };
}

function observation(
  ordinal: number,
  edge: TraceEdge,
  semantics: TraceEdgeSemantics,
): CompactEdgeObservation {
  return {
    ordinal, step: edge.step, type: edge.type,
    source: semantics.source, target: semantics.target,
    status: semantics.status, confidence: edge.confidence,
    decision: semantics.decision, refs: semantics.refs, site: semantics.site,
  };
}

function targetSummary(
  value: Record<string, unknown>,
): { kind: string; id: string } | undefined {
  const kind = stringValue(value.targetKind);
  const id = stringValue(value.targetId);
  return kind && id ? { kind, id } : undefined;
}

function reference(value: unknown): Array<number | string> | undefined {
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric > 0 ? [numeric] : undefined;
    return [value];
  }
  const number = finiteNumber(value);
  return number === undefined || number <= 0 ? undefined : [number];
}

function dynamicMode(value: unknown): 'strict' | 'candidates' | 'infer' | undefined {
  return value === 'strict' || value === 'candidates' || value === 'infer'
    ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}
