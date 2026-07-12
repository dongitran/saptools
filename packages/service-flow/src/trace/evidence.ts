import type { Db } from '../db/connection.js';
import { extractPlaceholders, substituteVariables, type RuntimeSubstitution } from '../linker/dynamic-edge-resolver.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { resolveOperation, type OperationTarget } from '../linker/service-resolver.js';
import type { DynamicMode } from '../types.js';
import { analyzeDynamicTargetCandidates, type DynamicTargetAnalysis, type DynamicTargetCandidate } from './dynamic-targets.js';
import { boundCandidateLikeEvidence } from '../utils/000-bounded-projection.js';
import {
  dynamicMissingReason,
  isStructuralContextualBlocker,
  type ContextualRuntimeState,
} from './008-contextual-runtime-state.js';

export interface TraceGraphRow extends Record<string, unknown> {
  id: number;
  edge_type: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  confidence: number;
  evidence_json: string;
  unresolved_reason?: string;
  status?: string;
}

interface Candidate {
  servicePath?: string;
  operationPath?: string;
  repoName?: string;
  operationName?: string;
  score?: number;
}
interface RuntimeDiagnosticTotals {
  missing: Set<string>;
  candidateCount: number;
  viableCandidateCount: number;
  rejectedCandidateCount: number;
  maxCandidates: number;
  candidateSuggestions: Record<string, unknown>[];
  rejectedCandidates: Record<string, unknown>[];
  suggestedVarSets: Record<string, unknown>[];
}
interface RuntimeResolutionResult {
  row: TraceGraphRow;
  evidence: Record<string, unknown>;
  target?: OperationTarget;
  unresolvedReason?: string;
}

export function baseTraceEvidence(
  row: TraceGraphRow,
  call: Record<string, unknown>,
  persistedEvidence: Record<string, unknown>,
  contextualEvidence: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const evidence = { ...persistedEvidence, ...(contextualEvidence ?? {}) };
  return {
    ...evidence,
    graphEdgeId: row.id,
    persistedGraphEdgeId: row.id > 0 ? row.id : undefined,
    outboundCallId: call.id,
    callSite: { sourceFile: call.source_file, sourceLine: call.source_line },
    callType: call.call_type,
    repoId: call.repo_id,
    sourceFile: call.source_file,
    sourceLine: call.source_line,
    file: call.source_file,
    line: call.source_line,
    persistedTarget: { kind: row.to_kind, id: row.to_id },
    contextualResolutionParticipated: Boolean(contextualEvidence?.contextualServiceBindingAttempted),
    persistedResolution: persistedResolution(row),
  };
}

export function runtimeResolution(
  db: Db,
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  options: { vars?: Record<string, string>; dynamicMode?: DynamicMode; maxDynamicCandidates?: number },
  workspaceId: number | undefined,
  contextualState?: ContextualRuntimeState,
): RuntimeResolutionResult {
  const dynamicMode = options.dynamicMode ?? 'strict';
  const candidateCap = positiveCandidateCap(options.maxDynamicCandidates);
  const boundedEvidence = boundCandidateLikeEvidence(evidence, candidateCap);
  if (!isDynamicRemoteOperationEdge(row, evidence))
    return unchangedRuntimeResolution(
      row,
      boundDynamicEvidence(boundedEvidence, candidateCap),
      contextualState,
    );
  const substituted = evidenceWithRuntimeVariables(boundedEvidence, options.vars);
  const analysis = analyzeDynamicTargetCandidates(
    db, substituted, workspaceId, dynamicMode, candidateCap,
  );
  const enriched = boundDynamicEvidence(
    analysis ? evidenceWithDynamicAnalysis(substituted, analysis) : substituted,
    candidateCap,
  );
  const appliedRuntimeValues = hasApplicableRuntimeVariables(evidence, options.vars);
  const analyzed = analyzedRuntimeResolution(
    row, enriched, analysis, dynamicMode, appliedRuntimeValues, contextualState,
  );
  if (analyzed) return analyzed;
  if (!appliedRuntimeValues) {
    const unresolvedReason = contextualReason(contextualState) ?? row.unresolved_reason;
    const withSections = withEffectiveResolution(
      enriched, row, unresolvedReason, undefined, contextualState,
    );
    return { row, evidence: withSections, unresolvedReason };
  }
  return resolveSuppliedRuntimeOperation(db, row, enriched, workspaceId, contextualState);
}

function analyzedRuntimeResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  analysis: DynamicTargetAnalysis | undefined,
  dynamicMode: DynamicMode,
  appliedRuntimeValues: boolean,
  contextualState: ContextualRuntimeState | undefined,
): RuntimeResolutionResult | undefined {
  if (analysis && analysis.viableCandidateCount === 0
    && Object.keys(analysis.appliedSuppliedVariables).length > 0)
    return noCandidateRuntimeResolution(row, evidence, contextualState);
  const inferred = dynamicMode === 'infer' ? inferredTarget(analysis) : undefined;
  if (inferred && !isStructuralContextualBlocker(contextualState))
    return resolvedRuntimeResolution(row, evidence, inferred, inferred.reasons);
  if (analysis && analysis.missingVariables.length > 0 && appliedRuntimeValues) {
    const unresolvedReason = dynamicMissingReason(analysis.missingVariables);
    return {
      row,
      evidence: withEffectiveResolution(
        evidence, row, unresolvedReason, undefined, contextualState,
      ),
      unresolvedReason,
    };
  }
  return isStructuralContextualBlocker(contextualState)
    ? unchangedRuntimeResolution(row, evidence, contextualState)
    : undefined;
}

function resolveSuppliedRuntimeOperation(
  db: Db,
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
  contextualState: ContextualRuntimeState | undefined,
): RuntimeResolutionResult {
  const resolution = resolveRuntimeOperation(db, evidence, workspaceId);
  if (resolution.target)
    return resolvedRuntimeResolution(
      row, evidence, resolution.target, resolution.reasons,
    );
  const unresolvedReason = runtimeUnresolvedReason(resolution);
  return {
    row,
    evidence: withEffectiveResolution(
      evidence, row, unresolvedReason, resolution, contextualState,
    ),
    unresolvedReason,
  };
}

function unchangedRuntimeResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  contextualState: ContextualRuntimeState | undefined,
): RuntimeResolutionResult {
  const unresolvedReason = contextualReason(contextualState) ?? row.unresolved_reason;
  return {
    row,
    evidence: withEffectiveResolution(
      evidence, row, unresolvedReason, undefined, contextualState,
    ),
    unresolvedReason,
  };
}

function noCandidateRuntimeResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  contextualState: ContextualRuntimeState | undefined,
): RuntimeResolutionResult {
  const unresolvedReason = 'No candidate remained after runtime substitution';
  return {
    row,
    evidence: withEffectiveResolution(
      evidence, row, unresolvedReason, undefined, contextualState,
    ),
    unresolvedReason,
  };
}

function resolvedRuntimeResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  target: OperationTarget,
  reasons: string[],
): RuntimeResolutionResult {
  const resolvedRow = {
    ...row,
    status: 'resolved',
    to_kind: 'operation',
    to_id: String(target.operationId),
    unresolved_reason: undefined,
    confidence: Math.max(0, Math.min(1, target.score)),
  };
  const resolution = {
    status: 'resolved' as const,
    target,
    candidates: [],
    reasons,
  };
  return {
    row: resolvedRow,
    evidence: withEffectiveResolution(evidence, resolvedRow, undefined, resolution),
    target,
  };
}

export function runtimeVariableDiagnostic(edges: Array<{ evidence: Record<string, unknown> }>): Record<string, unknown> | undefined {
  const totals = runtimeDiagnosticTotals(edges);
  const missingVariables = [...totals.missing].sort();
  if (missingVariables.length === 0) return undefined;
  const shownSuggestions = totals.candidateSuggestions.slice(0, totals.maxCandidates);
  const shownRejected = totals.rejectedCandidates.slice(0, totals.maxCandidates);
  const shownCandidateCount = shownSuggestions.length;
  return {
    severity: 'warning',
    code: 'trace_runtime_variables_missing',
    message: `Runtime variables are required to resolve dynamic trace targets: ${missingVariables.join(', ')}`,
    missingVariables,
    suggestions: missingVariables.map((key) => `--var ${key}=<value>`),
    candidateCount: totals.candidateCount,
    viableCandidateCount: totals.viableCandidateCount,
    rejectedCandidateCount: totals.rejectedCandidateCount,
    shownCandidateCount,
    omittedCandidateCount: Math.max(0, totals.viableCandidateCount - shownCandidateCount),
    maxDynamicCandidates: totals.maxCandidates,
    shownRejectedCandidateCount: shownRejected.length,
    omittedRejectedCandidateCount: Math.max(0, totals.rejectedCandidateCount - shownRejected.length),
    candidateSuggestions: shownSuggestions,
    rejectedCandidates: shownRejected,
    suggestedVarSets: uniqueCliRows(totals.suggestedVarSets).slice(0, totals.maxCandidates),
    copyableExamples: copyableExamples(totals.suggestedVarSets, totals.candidateCount, totals.maxCandidates),
  };
}

function runtimeDiagnosticTotals(
  edges: Array<{ evidence: Record<string, unknown> }>): RuntimeDiagnosticTotals {
  const missing = new Set<string>();
  let candidateCount = 0;
  let viableCandidateCount = 0;
  let rejectedCandidateCount = 0;
  let maxCandidates = 5;
  const candidateSuggestions: Record<string, unknown>[] = [];
  const rejectedCandidates: Record<string, unknown>[] = [];
  const suggestedVarSets: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const effective = parseObject(edge.evidence.effectiveResolution);
    if (!['dynamic', 'unresolved', 'ambiguous'].includes(String(effective.status ?? '')))
      continue;
    const substitutions = edge.evidence.runtimeSubstitutions;
    if (!substitutions || typeof substitutions !== 'object' || Array.isArray(substitutions)) continue;
    for (const value of Object.values(substitutions as Record<string, RuntimeSubstitution>))
      for (const key of value.missing ?? []) missing.add(key);
    const exploration = parseObject(edge.evidence.dynamicTargetExploration);
    maxCandidates = positiveCandidateCap(numeric(exploration.maxCandidates) || maxCandidates);
    candidateCount += numeric(exploration.candidateCount);
    viableCandidateCount += numeric(exploration.viableCandidateCount);
    rejectedCandidateCount += numeric(exploration.rejectedCandidateCount);
    appendBounded(
      candidateSuggestions,
      recordArray(edge.evidence.dynamicTargetCandidateSuggestions),
      maxCandidates,
    );
    appendBounded(
      rejectedCandidates,
      recordArray(exploration.rejectedCandidates),
      maxCandidates,
    );
    appendBounded(
      suggestedVarSets,
      recordArray(exploration.suggestedVarSets),
      maxCandidates,
    );
  }
  return {
    missing,
    candidateCount,
    viableCandidateCount,
    rejectedCandidateCount,
    maxCandidates,
    candidateSuggestions,
    rejectedCandidates,
    suggestedVarSets,
  };
}

export function runtimeNoCandidateDiagnostics(
  edges: Array<{ evidence: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return edges.flatMap((edge) => {
    const exploration = parseObject(edge.evidence.dynamicTargetExploration);
    const suppliedVariables = parseObject(exploration.suppliedVariables);
    const appliedSuppliedVariables = parseObject(
      exploration.appliedSuppliedVariables,
    );
    if (numeric(exploration.viableCandidateCount) !== 0
      || Object.keys(appliedSuppliedVariables).length === 0) return [];
    const callSite = parseObject(edge.evidence.callSite);
    const key = JSON.stringify([callSite, suppliedVariables]);
    if (seen.has(key)) return [];
    seen.add(key);
    const maxCandidates = positiveCandidateCap(numeric(exploration.maxCandidates));
    return [{
      severity: 'warning',
      code: 'no_candidate_after_runtime_substitution',
      message: 'No dynamic target candidate remained after applying runtime variables',
      suppliedVariables,
      appliedSuppliedVariables,
      substitutedSignals: parseObject(exploration.substitutedSignals),
      candidateCount: numeric(exploration.candidateCount),
      viableCandidateCount: 0,
      rejectedCandidateCount: numeric(exploration.rejectedCandidateCount),
      shownCandidateCount: numeric(exploration.shownCandidateCount),
      omittedCandidateCount: numeric(exploration.omittedCandidateCount),
      shownRejectedCandidateCount: numeric(
        exploration.shownRejectedCandidateCount,
      ),
      omittedRejectedCandidateCount: numeric(
        exploration.omittedRejectedCandidateCount,
      ),
      rejectedCandidates: recordArray(exploration.rejectedCandidates).slice(0, maxCandidates),
      callSite,
    }];
  });
}

export function edgeTarget(row: TraceGraphRow, evidence: Record<string, unknown>): string {
  const effective = parseObject(evidence.effectiveResolution);
  const targetServicePath = stringValue(effective.targetServicePath ?? evidence.targetServicePath);
  const targetOperationPath = stringValue(effective.targetOperationPath ?? evidence.targetOperationPath);
  if (targetServicePath && targetOperationPath) return `${targetServicePath}${targetOperationPath}`;
  const runtimeCandidate = evidence.runtimeResolvedCandidate as Candidate | undefined;
  if (runtimeCandidate?.servicePath && runtimeCandidate.operationPath) return `${runtimeCandidate.servicePath}${runtimeCandidate.operationPath}`;
  const servicePath = stringValue(evidence.servicePath);
  const operationPath = stringValue(evidence.operationPath);
  const targetOperation = stringValue(evidence.targetOperation);
  const targetRepo = stringValue(evidence.targetRepo) ?? '';
  if (row.edge_type === 'HANDLER_RUNS_DB_QUERY') return `Entity: ${row.to_id || 'unknown'}`;
  if (row.edge_type === 'HANDLER_RUNS_REMOTE_QUERY') return stringValue(evidence.remoteQueryTarget) ?? `Remote query: ${row.to_id || 'unknown'}`;
  if (row.edge_type === 'HANDLER_CALLS_EXTERNAL_HTTP') {
    const target = parseObject(evidence.externalTarget);
    return stringValue(target.label) ?? `External endpoint: ${row.to_id || 'unknown'}`;
  }
  if (servicePath && operationPath) return `${servicePath}${operationPath}`;
  return targetOperation ? `${targetRepo}:${targetOperation}` : row.to_id;
}

function persistedResolution(row: TraceGraphRow): Record<string, unknown> {
  return {
    status: row.status,
    targetKind: row.to_kind,
    targetId: row.to_id,
    edgeId: row.id > 0 ? row.id : undefined,
    confidence: row.confidence,
    unresolvedReason: row.unresolved_reason,
    edgeType: row.edge_type,
  };
}

function effectiveResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  unresolvedReason: string | undefined,
  resolution?: ReturnType<typeof resolveRuntimeOperation>,
  contextualState?: ContextualRuntimeState,
): Record<string, unknown> {
  const target = resolution?.target;
  return {
    status: target ? 'resolved' : row.status,
    targetKind: target ? 'operation' : row.to_kind,
    targetId: target ? String(target.operationId) : row.to_id,
    targetRepo: target?.repoName ?? evidence.targetRepo,
    targetServicePath: target?.servicePath ?? evidence.targetServicePath,
    targetOperationPath: target?.operationPath ?? evidence.targetOperationPath,
    targetOperation: target?.operationName ?? evidence.targetOperation,
    confidence: target?.score ?? row.confidence,
    reasons: resolution?.reasons ?? evidence.resolutionReasons,
    unresolvedReason,
    edgeType: target ? 'REMOTE_CALL_RESOLVES_TO_OPERATION' : row.edge_type,
    contextualBlocker: isStructuralContextualBlocker(contextualState)
      ? contextualState : undefined,
  };
}

function withEffectiveResolution(
  evidence: Record<string, unknown>,
  row: TraceGraphRow,
  unresolvedReason: string | undefined,
  resolution?: ReturnType<typeof resolveRuntimeOperation>,
  contextualState?: ContextualRuntimeState,
): Record<string, unknown> {
  const current = effectiveResolution(
    row, evidence, unresolvedReason, resolution, contextualState,
  );
  const rest = { ...evidence };
  delete rest.runtimeResolvedCandidate;
  return {
    ...rest,
    effectiveResolution: current,
    linker: {
      status: current.status,
      confidence: current.confidence,
      reason: unresolvedReason,
      edgeType: current.edgeType,
      contextualBlocker: current.contextualBlocker,
    },
  };
}

function contextualReason(
  state: ContextualRuntimeState | undefined,
): string | undefined {
  return state?.category === 'none' ? undefined : state?.message;
}

function resolveRuntimeOperation(db: Db, evidence: Record<string, unknown>, workspaceId: number | undefined): ReturnType<typeof resolveOperation> {
  const servicePath = stringValue(evidence.servicePath);
  const rawOperationPath = stringValue(evidence.operationPath);
  const normalized = normalizeODataOperationInvocationPath(rawOperationPath);
  const operationPath = normalized?.wasInvocation
    ? normalized.normalizedOperationPath
    : stringValue(evidence.normalizedOperationPath) ?? rawOperationPath;
  const alias = stringValue(evidence.serviceAliasExpr ?? evidence.serviceAlias);
  const destination = stringValue(evidence.destination);
  return resolveOperation(db, { servicePath, operationPath, alias, destination, hasExplicitOverride: true, isDynamic: true }, workspaceId);
}

function evidenceWithRuntimeVariables(evidence: Record<string, unknown>, vars: Record<string, string> | undefined): Record<string, unknown> {
  const substitutions = runtimeSubstitutions(evidence, vars ?? {});
  const suppliedRuntimeVariables = Object.fromEntries(
    Object.entries(vars ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const next: Record<string, unknown> = {
    ...evidence,
    runtimeSubstitutions: substitutions,
    suppliedRuntimeVariables,
  };
  for (const [key, value] of Object.entries(substitutions)) if (value.effective) next[key] = value.effective;
  const missing = Object.values(substitutions).flatMap((value) => value.missing);
  if (missing.length > 0) next.missingRuntimeVariables = [...new Set(missing)].sort();
  if (Object.keys(suppliedRuntimeVariables).length > 0) next.runtimeVariablesApplied = true;
  return next;
}

function evidenceWithDynamicAnalysis(
  evidence: Record<string, unknown>,
  analysis: DynamicTargetAnalysis,
): Record<string, unknown> {
  const persistedCandidates = recordArray(evidence.candidates);
  const persistedScores = recordArray(evidence.candidateScores);
  const persistedCandidateCount = numeric(evidence.persistedCandidateCount)
    || numeric(evidence.candidateCount)
    || persistedCandidates.length;
  const persistedScoreCount = numeric(evidence.candidateScoreCount)
    || persistedScores.length;
  return {
    ...evidence,
    candidates: persistedCandidates.slice(0, analysis.maxCandidates),
    candidateScores: persistedScores.slice(0, analysis.maxCandidates),
    persistedCandidateCount,
    persistedCandidateOmittedCount: Math.max(
      0,
      persistedCandidateCount - Math.min(persistedCandidates.length, analysis.maxCandidates),
    ),
    persistedCandidateScoreCount: persistedScoreCount,
    persistedCandidateScoreOmittedCount: Math.max(
      0, persistedScoreCount - Math.min(persistedScores.length, analysis.maxCandidates),
    ),
    dynamicTargetExploration: {
      mode: analysis.mode,
      maxCandidates: analysis.maxCandidates,
      missingVariables: analysis.missingVariables,
      requiredVariables: analysis.requiredVariables,
      suppliedVariables: analysis.suppliedVariables,
      appliedSuppliedVariables: analysis.appliedSuppliedVariables,
      substitutedSignals: analysis.substitutedSignals,
      candidateCount: analysis.candidateCount,
      viableCandidateCount: analysis.viableCandidateCount,
      rejectedCandidateCount: analysis.rejectedCandidateCount,
      shownCandidateCount: analysis.shownCandidateCount,
      omittedCandidateCount: analysis.omittedCandidateCount,
      shownRejectedCandidateCount: analysis.shownRejectedCandidateCount,
      omittedRejectedCandidateCount: analysis.omittedRejectedCandidateCount,
      rejectedCandidates: analysis.rejectedCandidates,
      suggestedVarSets: analysis.suggestedVarSets,
      suggestedVarSetCount: analysis.suggestedVarSetCount,
      shownSuggestedVarSetCount: analysis.shownSuggestedVarSetCount,
      omittedSuggestedVarSetCount: analysis.omittedSuggestedVarSetCount,
      routingContext: analysis.routingContext,
    },
    dynamicTargetCandidates: analysis.candidates,
    dynamicTargetCandidateSuggestions: analysis.shownCandidates,
    dynamicTargetCandidateSuggestionCount: analysis.viableCandidateCount,
    shownDynamicTargetCandidateSuggestionCount: analysis.shownCandidateCount,
    omittedDynamicTargetCandidateSuggestionCount: analysis.omittedCandidateCount,
    rejectedCandidates: analysis.rejectedCandidates,
    dynamicTargetInference: analysis.inference,
  };
}

const boundedDynamicListKeys = new Set([
  'candidates',
  'candidateScores',
  'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions',
  'candidateSuggestions',
  'suggestedVarSets',
  'rejectedCandidates',
  'rejectedCandidateSuggestions',
  'copyableExamples',
  'conflicts',
  'bindingAlternatives',
]);

function boundDynamicEvidence(
  evidence: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const candidateCount = numeric(evidence.persistedCandidateCount)
    || numeric(evidence.candidateCount)
    || (Array.isArray(evidence.candidates) ? evidence.candidates.length : 0);
  const projected = boundDynamicValue(evidence, limit);
  const next = parseObject(projected);
  if (candidateCount === 0) return next;
  return {
    ...next,
    persistedCandidateCount: candidateCount,
    persistedCandidateOmittedCount: Math.max(0, candidateCount - limit),
  };
}

function boundDynamicValue(
  value: unknown,
  limit: number,
  key?: string,
  parentKey?: string,
): unknown {
  if (Array.isArray(value)) {
    const bounded = Boolean(key && (boundedDynamicListKeys.has(key)
      || parentKey === 'derivationProvenance'
      || parentKey === 'conflicts' && key === 'sources'));
    const input = bounded ? value.slice(0, limit) : value;
    const projected = input.map((item) =>
      boundDynamicValue(item, limit, undefined, key ?? parentKey));
    return projected;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    boundDynamicValue(child, limit, childKey, key ?? parentKey),
  ]));
}

function runtimeSubstitutions(evidence: Record<string, unknown>, vars: Record<string, string>): Record<string, RuntimeSubstitution> {
  const substitutions: Record<string, RuntimeSubstitution> = {};
  for (const key of ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination']) {
    const substitution = substituteVariables(substitutionValue(evidence, key), vars);
    if (substitution.placeholders.length > 0) substitutions[key] = substitution;
  }
  return substitutions;
}

function substitutionValue(
  evidence: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringValue(evidence[key]);
  if (key !== 'operationPath') return value;
  const normalized = normalizeODataOperationInvocationPath(value);
  return normalized?.wasInvocation ? normalized.normalizedOperationPath : value;
}

function isDynamicRemoteOperationEdge(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
): boolean {
  if (evidence.callType !== 'remote_action') return false;
  if (!['dynamic', 'ambiguous', 'unresolved'].includes(String(row.status ?? ''))) return false;
  return ['DYNAMIC_EDGE_CANDIDATE', 'UNRESOLVED_EDGE', 'REMOTE_CALL_RESOLVES_TO_OPERATION']
    .includes(row.edge_type);
}

function hasApplicableRuntimeVariables(
  evidence: Record<string, unknown>,
  vars: Record<string, string> | undefined,
): boolean {
  if (!vars || Object.keys(vars).length === 0) return false;
  return ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination'].some((key) => hasRuntimeVariable(evidence[key], vars));
}

function inferredTarget(analysis: DynamicTargetAnalysis | undefined): OperationTarget | undefined {
  if (analysis?.inference.status !== 'resolved') return undefined;
  const id = Number(analysis.inference.candidateOperationId);
  const candidate = analysis.candidates.find((item) => item.candidateOperationId === id);
  if (!candidate) return undefined;
  return targetFromCandidate(candidate);
}

function targetFromCandidate(candidate: DynamicTargetCandidate): OperationTarget {
  return {
    operationId: candidate.candidateOperationId,
    repoName: candidate.repoName,
    serviceName: '',
    qualifiedName: '',
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    operationName: candidate.operationName,
    repoId: candidate.repoId,
    packageName: candidate.packageName,
    score: candidate.score,
    reasons: candidate.reasons,
    sourceFile: candidate.sourceFile,
    sourceLine: candidate.sourceLine,
  };
}

function hasRuntimeVariable(value: unknown, vars: Record<string, string>): boolean {
  return typeof value === 'string' && extractPlaceholders(value).some((key) => Object.hasOwn(vars, key));
}

function runtimeUnresolvedReason(resolution: ReturnType<typeof resolveRuntimeOperation>): string {
  if (resolution.status === 'dynamic') return `Dynamic target is missing runtime variables: ${resolution.reasons.join(', ')}`;
  if (resolution.status === 'ambiguous') return 'Ambiguous runtime operation candidates';
  return 'No runtime operation candidate matched substituted service and operation path';
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function appendBounded<T>(target: T[], values: T[], limit: number): void {
  const remaining = Math.max(0, limit - target.length);
  if (remaining > 0) target.push(...values.slice(0, remaining));
}

function uniqueCliRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const cli = typeof row.cli === 'string' ? row.cli : JSON.stringify(row);
    if (seen.has(cli)) return false;
    seen.add(cli);
    return true;
  });
}

function copyableExamples(
  suggestedVarSets: Record<string, unknown>[],
  candidateCount: number,
  limit: number,
): string[] {
  const variableExamples = uniqueCliRows(suggestedVarSets).flatMap((row) =>
    typeof row.cli === 'string' ? [row.cli] : []);
  const exploration = candidateCount > 0
    ? ['--dynamic-mode candidates --max-dynamic-candidates 20']
    : [];
  return [...variableExamples, ...exploration].slice(0, limit);
}

function positiveCandidateCap(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 5;
}
