import type { Db } from '../db/connection.js';
import { extractPlaceholders, substituteVariables, type RuntimeSubstitution } from '../linker/dynamic-edge-resolver.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { resolveOperation, type OperationTarget } from '../linker/service-resolver.js';

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
  vars: Record<string, string> | undefined,
  workspaceId: number | undefined,
): { row: TraceGraphRow; evidence: Record<string, unknown>; target?: OperationTarget; unresolvedReason?: string } {
  const substituted = evidenceWithRuntimeVariables(evidence, vars);
  if (!isRemoteRuntimeCandidate(row, evidence, vars)) {
    const withSections = withEffectiveResolution(substituted, row, row.unresolved_reason);
    return { row, evidence: withSections, unresolvedReason: row.unresolved_reason };
  }
  const resolution = resolveRuntimeOperation(db, substituted, workspaceId);
  if (resolution.target) {
    const resolvedRow = { ...row, status: 'resolved', to_kind: 'operation', to_id: String(resolution.target.operationId), unresolved_reason: undefined, confidence: Math.max(0, Math.min(1, resolution.target.score)) };
    return { row: resolvedRow, evidence: withEffectiveResolution(substituted, resolvedRow, undefined, resolution), target: resolution.target };
  }
  const unresolvedReason = runtimeUnresolvedReason(resolution);
  return { row, evidence: withEffectiveResolution(substituted, row, unresolvedReason, resolution), unresolvedReason };
}

export function runtimeVariableDiagnostic(edges: Array<{ evidence: Record<string, unknown> }>): Record<string, unknown> | undefined {
  const missing = new Set<string>();
  for (const edge of edges) {
    const substitutions = edge.evidence.runtimeSubstitutions;
    if (!substitutions || typeof substitutions !== 'object' || Array.isArray(substitutions)) continue;
    for (const value of Object.values(substitutions as Record<string, RuntimeSubstitution>))
      for (const key of value.missing ?? []) missing.add(key);
  }
  const missingVariables = [...missing].sort();
  if (missingVariables.length === 0) return undefined;
  return {
    severity: 'warning',
    code: 'trace_runtime_variables_missing',
    message: `Runtime variables are required to resolve dynamic trace targets: ${missingVariables.join(', ')}`,
    missingVariables,
    suggestions: missingVariables.map((key) => `--var ${key}=<value>`),
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

function runtimeSubstitutions(evidence: Record<string, unknown>, vars: Record<string, string>): Record<string, RuntimeSubstitution> {
  const substitutions: Record<string, RuntimeSubstitution> = {};
  for (const key of ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination']) {
    const substitution = substituteVariables(stringValue(evidence[key]), vars);
    if (substitution.placeholders.length > 0) substitutions[key] = substitution;
  }
  return substitutions;
}

function isRemoteRuntimeCandidate(row: TraceGraphRow, evidence: Record<string, unknown>, vars: Record<string, string> | undefined): boolean {
  if (!vars || Object.keys(vars).length === 0) return false;
  if (!['dynamic', 'ambiguous', 'unresolved'].includes(String(row.status ?? ''))) return false;
  if (!['DYNAMIC_EDGE_CANDIDATE', 'UNRESOLVED_EDGE', 'REMOTE_CALL_RESOLVES_TO_OPERATION'].includes(row.edge_type)) return false;
  return ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination'].some((key) => hasRuntimeVariable(evidence[key], vars));
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
