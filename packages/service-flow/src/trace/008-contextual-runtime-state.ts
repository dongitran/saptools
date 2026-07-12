import type { Db } from '../db/connection.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { resolveOperation, type OperationResolution } from '../linker/service-resolver.js';
import { boundedContextCandidates } from './006-contextual-projection.js';

export interface ContextBinding {
  bindingId?: number;
  alias?: string;
  aliasExpr?: string;
  destinationExpr?: string;
  servicePathExpr?: string;
  requireServicePath?: string;
  requireDestination?: string;
  effectiveServicePath?: string;
  effectiveDestination?: string;
  sourceFile?: string;
  sourceLine?: number;
  source: string;
  callerArgument?: string;
  callerProperty?: string;
  calleeParameter?: string;
  calleeObjectProperty?: string;
  calleeLocalDestructuredIdentifier?: string;
  parameterPropertyAliasKind?: unknown;
  parameterPropertyAliasLine?: unknown;
  calleeReceiver: string;
  callerSite?: { sourceFile?: string; sourceLine?: number };
  calleeSite?: { sourceFile?: string; sourceLine?: number };
  resolutionStatus?: 'selected' | 'ambiguous';
  bindingCandidates?: Array<Record<string, unknown>>;
}

interface ContextualCall {
  id: number;
  call_type: string;
  operation_path_expr?: unknown;
}

interface PersistedGraphRow {
  status?: string;
}

export interface ContextualGraphRow {
  id: number;
  edge_type: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  confidence: number;
  evidence_json: string;
  status: 'resolved';
}

export type ContextualResolutionCategory =
  | 'none'
  | 'dynamic_missing'
  | 'ambiguous_binding'
  | 'ambiguous_operation'
  | 'no_matching_operation'
  | 'other_blocker';

export interface ContextualRuntimeState {
  category: ContextualResolutionCategory;
  message?: string;
  missingVariables?: string[];
  resolutionStatus?: string;
  phase?: 'before_runtime_substitution';
}

export interface ContextualRuntimeResolution {
  row?: ContextualGraphRow;
  evidence?: Record<string, unknown>;
  state: ContextualRuntimeState;
}

export function dynamicMissingReason(keys: readonly string[]): string {
  const missing = normalizedKeys(keys);
  return missing.length > 0
    ? `Dynamic target is missing runtime variables: ${missing.join(', ')}`
    : 'Dynamic target still requires runtime variables';
}

export function isStructuralContextualBlocker(
  state: ContextualRuntimeState | undefined,
): boolean {
  return state?.category === 'ambiguous_binding'
    || state?.category === 'ambiguous_operation'
    || state?.category === 'no_matching_operation'
    || state?.category === 'other_blocker';
}

export function contextualRuntimeResolution(
  db: Db,
  call: ContextualCall,
  binding: ContextBinding | undefined,
  workspaceId: number | undefined,
  persistedRows: PersistedGraphRow[] = [],
): ContextualRuntimeResolution {
  if (!binding || call.call_type !== 'remote_action'
    || call.operation_path_expr === undefined || call.operation_path_expr === null)
    return { state: { category: 'none' } };
  if (binding.resolutionStatus === 'ambiguous')
    return ambiguousBindingResolution(binding);
  return selectedBindingResolution(db, call, binding, workspaceId, persistedRows);
}

function ambiguousBindingResolution(
  binding: ContextBinding,
): ContextualRuntimeResolution {
  const candidates = boundedContextCandidates(binding.bindingCandidates ?? []);
  const state: ContextualRuntimeState = {
    category: 'ambiguous_binding',
    message: 'Ambiguous contextual service binding candidates',
    resolutionStatus: 'ambiguous',
  };
  return {
    evidence: {
      contextualServiceBindingAttempted: true,
      contextualBinding: {
        source: binding.source,
        status: 'tied',
        candidates: candidates.candidates,
        candidateCount: candidates.candidateCount,
        shownCandidateCount: candidates.shownCandidateCount,
        omittedCandidateCount: candidates.omittedCandidateCount,
      },
      contextualResolutionStatus: 'ambiguous',
      contextualCandidateCount: candidates.candidateCount,
      contextualPreSubstitutionState: historicalState(state),
    },
    state,
  };
}

function selectedBindingResolution(
  db: Db,
  call: ContextualCall,
  binding: ContextBinding,
  workspaceId: number | undefined,
  persistedRows: PersistedGraphRow[],
): ContextualRuntimeResolution {
  const normalized = normalizeODataOperationInvocationPath(
    String(call.operation_path_expr),
  );
  const operationPath = normalized?.normalizedOperationPath
    ?? withLeadingSlash(String(call.operation_path_expr));
  const servicePath = binding.effectiveServicePath
    ?? binding.servicePathExpr ?? binding.requireServicePath;
  const destination = binding.effectiveDestination
    ?? binding.destinationExpr ?? binding.requireDestination;
  const resolution = resolveOperation(db, {
    servicePath,
    operationPath,
    alias: binding.aliasExpr ?? binding.alias,
    destination,
    hasExplicitOverride: true,
    isDynamic: false,
  }, workspaceId);
  const state = stateForResolution(resolution);
  const evidence = contextualEvidence(
    binding, normalized, operationPath, servicePath, destination, resolution, state,
  );
  if (!resolution.target) return { evidence, state };
  const resolvedEvidence = {
    ...evidence,
    contextualServiceBindingSelected: true,
    targetRepo: resolution.target.repoName,
    targetServicePath: resolution.target.servicePath,
    targetOperationPath: resolution.target.operationPath,
    targetOperation: resolution.target.operationName,
  };
  if (persistedRows.some((row) => row.status === 'resolved'))
    return { evidence: { ...resolvedEvidence, contextualPreservedPersistedResolvedEdge: true }, state };
  return {
    row: {
      id: -call.id,
      edge_type: 'REMOTE_CALL_RESOLVES_TO_OPERATION',
      from_id: String(call.id),
      to_kind: 'operation',
      to_id: String(resolution.target.operationId),
      confidence: resolution.target.score,
      evidence_json: JSON.stringify(resolvedEvidence),
      status: 'resolved',
    },
    evidence: resolvedEvidence,
    state,
  };
}

function contextualEvidence(
  binding: ContextBinding,
  normalized: ReturnType<typeof normalizeODataOperationInvocationPath>,
  operationPath: string,
  servicePath: string | undefined,
  destination: string | undefined,
  resolution: OperationResolution,
  state: ContextualRuntimeState,
): Record<string, unknown> {
  const candidates = boundedContextCandidates(resolution.candidates);
  return {
    contextualServiceBindingAttempted: true,
    contextualBinding: bindingEvidence(binding),
    operationPath,
    rawOperationPath: normalized?.rawOperationPath,
    normalizedOperationPath: normalized?.wasInvocation
      ? normalized.normalizedOperationPath : undefined,
    invocationArgumentPlaceholderKeys: normalized?.invocationArgumentPlaceholderKeys.length
      ? normalized.invocationArgumentPlaceholderKeys : undefined,
    servicePath,
    serviceAlias: binding.alias,
    serviceAliasExpr: binding.aliasExpr,
    destination,
    requireServicePath: binding.requireServicePath,
    requireDestination: binding.requireDestination,
    effectiveServicePath: binding.effectiveServicePath,
    effectiveDestination: binding.effectiveDestination,
    contextualResolutionStatus: resolution.status,
    contextualCandidateCount: candidates.candidateCount,
    shownContextualCandidateCount: candidates.shownCandidateCount,
    omittedContextualCandidateCount: candidates.omittedCandidateCount,
    candidates: candidates.candidates,
    contextualResolutionReasons: resolution.reasons,
    resolutionReasons: resolution.reasons,
    contextualPreSubstitutionState: historicalState(state),
  };
}

function bindingEvidence(binding: ContextBinding): Record<string, unknown> {
  return {
    source: binding.source,
    callerArgument: binding.callerArgument,
    callerProperty: binding.callerProperty,
    calleeParameter: binding.calleeParameter,
    calleeReceiver: binding.calleeReceiver,
    callerSite: binding.callerSite,
    calleeSite: binding.calleeSite,
    bindingSourceFile: binding.sourceFile,
    bindingSourceLine: binding.sourceLine,
    alias: binding.alias,
    aliasExpr: binding.aliasExpr,
    requireServicePath: binding.requireServicePath,
    requireDestination: binding.requireDestination,
    effectiveServicePath: binding.effectiveServicePath,
    effectiveDestination: binding.effectiveDestination,
  };
}

function stateForResolution(
  resolution: OperationResolution,
): ContextualRuntimeState {
  if (resolution.status === 'resolved') return { category: 'none' };
  if (resolution.status === 'dynamic') {
    const missingVariables = missingVariableKeys(resolution.reasons);
    return {
      category: 'dynamic_missing',
      message: dynamicMissingReason(missingVariables),
      missingVariables,
      resolutionStatus: resolution.status,
    };
  }
  if (resolution.status === 'ambiguous') return {
    category: 'ambiguous_operation',
    message: 'Ambiguous contextual operation candidates',
    resolutionStatus: resolution.status,
  };
  return {
    category: resolution.status === 'unresolved'
      ? 'no_matching_operation' : 'other_blocker',
    message: resolution.status === 'unresolved'
      ? 'No contextual operation candidate matched'
      : 'Contextual operation resolution is blocked',
    resolutionStatus: resolution.status,
  };
}

function historicalState(
  state: ContextualRuntimeState,
): ContextualRuntimeState {
  return { ...state, phase: 'before_runtime_substitution' };
}

function missingVariableKeys(reasons: string[]): string[] {
  return normalizedKeys(reasons.flatMap((reason) =>
    reason.startsWith('missing_variable:')
      ? [reason.slice('missing_variable:'.length)] : []));
}

function normalizedKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => key.length > 0))].sort();
}

function withLeadingSlash(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}
