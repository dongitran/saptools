import type { Db } from '../db/connection.js';
import { extractPlaceholders, substituteVariables, type RuntimeSubstitution } from '../linker/dynamic-edge-resolver.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { resolveOperation, type OperationTarget } from '../linker/service-resolver.js';
import type { DynamicMode } from '../types.js';
import { analyzeDynamicTargetCandidates, type DynamicTargetAnalysis, type DynamicTargetCandidate } from './dynamic-targets.js';

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
  contextualUnresolvedReason?: string,
): { row: TraceGraphRow; evidence: Record<string, unknown>; target?: OperationTarget; unresolvedReason?: string } {
  const substituted = evidenceWithRuntimeVariables(evidence, options.vars);
  const dynamicMode = options.dynamicMode ?? 'strict';
  const analysis = analyzeDynamicTargetCandidates(
    db,
    substituted,
    workspaceId,
    dynamicMode,
    positiveCandidateCap(options.maxDynamicCandidates),
  );
  const enriched = analysis ? evidenceWithDynamicAnalysis(substituted, analysis) : substituted;
  if (dynamicMode === 'infer') {
    const inferred = inferredTarget(analysis);
    if (inferred) {
      const resolvedRow = { ...row, status: 'resolved', to_kind: 'operation', to_id: String(inferred.operationId), unresolved_reason: undefined, confidence: inferred.score };
      const resolution = { status: 'resolved' as const, target: inferred, candidates: [], reasons: inferred.reasons };
      return { row: resolvedRow, evidence: withEffectiveResolution(enriched, resolvedRow, undefined, resolution), target: inferred };
    }
  }
  if (!isRemoteRuntimeCandidate(row, evidence, options.vars)) {
    const unresolvedReason = contextualUnresolvedReason ?? row.unresolved_reason;
    const withSections = withEffectiveResolution(enriched, row, unresolvedReason);
    return { row, evidence: withSections, unresolvedReason };
  }
  const resolution = resolveRuntimeOperation(db, enriched, workspaceId);
  if (resolution.target) {
    const resolvedRow = { ...row, status: 'resolved', to_kind: 'operation', to_id: String(resolution.target.operationId), unresolved_reason: undefined, confidence: Math.max(0, Math.min(1, resolution.target.score)) };
    return { row: resolvedRow, evidence: withEffectiveResolution(enriched, resolvedRow, undefined, resolution), target: resolution.target };
  }
  const unresolvedReason = runtimeUnresolvedReason(resolution);
  return { row, evidence: withEffectiveResolution(enriched, row, unresolvedReason, resolution), unresolvedReason };
}

export function runtimeVariableDiagnostic(edges: Array<{ evidence: Record<string, unknown> }>): Record<string, unknown> | undefined {
  const missing = new Set<string>();
  let candidateCount = 0;
  let shownCandidateCount = 0;
  let omittedCandidateCount = 0;
  const candidateSuggestions: Record<string, unknown>[] = [];
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
    candidateCount += numeric(exploration.candidateCount);
    shownCandidateCount += numeric(exploration.shownCandidateCount);
    omittedCandidateCount += numeric(exploration.omittedCandidateCount);
    candidateSuggestions.push(...recordArray(edge.evidence.dynamicTargetCandidateSuggestions));
    suggestedVarSets.push(...recordArray(exploration.suggestedVarSets));
  }
  const missingVariables = [...missing].sort();
  if (missingVariables.length === 0) return undefined;
  return {
    severity: 'warning',
    code: 'trace_runtime_variables_missing',
    message: `Runtime variables are required to resolve dynamic trace targets: ${missingVariables.join(', ')}`,
    missingVariables,
    suggestions: missingVariables.map((key) => `--var ${key}=<value>`),
    candidateCount,
    shownCandidateCount,
    omittedCandidateCount,
    candidateSuggestions: candidateSuggestions.slice(0, 5),
    suggestedVarSets: uniqueCliRows(suggestedVarSets).slice(0, 5),
    copyableExamples: [
      ...uniqueCliRows(suggestedVarSets).slice(0, 3).flatMap((row) =>
        typeof row.cli === 'string' ? [row.cli] : []),
      ...(candidateCount > 0 ? ['--dynamic-mode candidates --max-dynamic-candidates 20'] : []),
    ],
  };
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
  };
}

function withEffectiveResolution(
  evidence: Record<string, unknown>,
  row: TraceGraphRow,
  unresolvedReason: string | undefined,
  resolution?: ReturnType<typeof resolveRuntimeOperation>,
): Record<string, unknown> {
  const current = effectiveResolution(row, evidence, unresolvedReason, resolution);
  const rest = { ...evidence };
  delete rest.runtimeResolvedCandidate;
  return { ...rest, effectiveResolution: current, linker: { status: current.status, confidence: current.confidence, reason: unresolvedReason, edgeType: current.edgeType } };
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
  const next: Record<string, unknown> = { ...evidence, runtimeSubstitutions: substitutions };
  for (const [key, value] of Object.entries(substitutions)) if (value.effective) next[key] = value.effective;
  const missing = Object.values(substitutions).flatMap((value) => value.missing);
  if (missing.length > 0) next.missingRuntimeVariables = [...new Set(missing)].sort();
  if (Object.keys(vars ?? {}).length > 0) next.runtimeVariablesApplied = true;
  return next;
}

function evidenceWithDynamicAnalysis(
  evidence: Record<string, unknown>,
  analysis: DynamicTargetAnalysis,
): Record<string, unknown> {
  return {
    ...evidence,
    dynamicTargetExploration: {
      mode: analysis.mode,
      missingVariables: analysis.missingVariables,
      candidateCount: analysis.candidateCount,
      shownCandidateCount: analysis.shownCandidateCount,
      omittedCandidateCount: analysis.omittedCandidateCount,
      suggestedVarSets: analysis.suggestedVarSets,
    },
    dynamicTargetCandidates: analysis.candidates,
    dynamicTargetCandidateSuggestions: analysis.shownCandidates,
    dynamicTargetInference: analysis.inference,
  };
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

function isRemoteRuntimeCandidate(row: TraceGraphRow, evidence: Record<string, unknown>, vars: Record<string, string> | undefined): boolean {
  if (!vars || Object.keys(vars).length === 0) return false;
  if (!['dynamic', 'ambiguous', 'unresolved'].includes(String(row.status ?? ''))) return false;
  if (!['DYNAMIC_EDGE_CANDIDATE', 'UNRESOLVED_EDGE', 'REMOTE_CALL_RESOLVES_TO_OPERATION'].includes(row.edge_type)) return false;
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
    packageName: candidate.packageName,
    score: candidate.score,
    reasons: candidate.reasons,
    sourceFile: '',
    sourceLine: 0,
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

function uniqueCliRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const cli = typeof row.cli === 'string' ? row.cli : JSON.stringify(row);
    if (seen.has(cli)) return false;
    seen.add(cli);
    return true;
  });
}

function positiveCandidateCap(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 5;
}
