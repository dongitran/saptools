import type { TraceGraphRow } from './evidence.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function effectiveTarget(
  evidence: Record<string, unknown>,
): string | undefined {
  const effective = record(evidence.effectiveResolution);
  const service = text(
    effective.targetServicePath ?? evidence.targetServicePath,
  );
  const operation = text(
    effective.targetOperationPath ?? evidence.targetOperationPath,
  );
  return service && operation ? `${service}${operation}` : undefined;
}

function runtimeCandidateTarget(
  evidence: Record<string, unknown>,
): string | undefined {
  const candidate = record(evidence.runtimeResolvedCandidate);
  const service = text(candidate.servicePath);
  const operation = text(candidate.operationPath);
  return service && operation ? `${service}${operation}` : undefined;
}

function semanticEdgeTarget(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
): string | undefined {
  if (row.edge_type === 'HANDLER_RUNS_DB_QUERY')
    return `Entity: ${row.to_id || 'unknown'}`;
  if (row.edge_type === 'HANDLER_RUNS_REMOTE_QUERY')
    return text(evidence.remoteQueryTarget)
      ?? `Remote query: ${row.to_id || 'unknown'}`;
  if (row.edge_type === 'HANDLER_CALLS_EXTERNAL_HTTP') {
    const target = record(evidence.externalTarget);
    return text(target.label) ?? `External endpoint: ${row.to_id || 'unknown'}`;
  }
  return row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
    ? text(evidence.eventShapeCandidateTargetLabel) : undefined;
}

export function edgeTarget(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
): string {
  const exact = effectiveTarget(evidence) ?? runtimeCandidateTarget(evidence);
  if (exact) return exact;
  const semantic = semanticEdgeTarget(row, evidence);
  if (semantic) return semantic;
  const service = text(evidence.servicePath);
  const operation = text(evidence.operationPath);
  if (service && operation) return `${service}${operation}`;
  const targetOperation = text(evidence.targetOperation);
  const targetRepo = text(evidence.targetRepo) ?? '';
  return targetOperation ? `${targetRepo}:${targetOperation}` : row.to_id;
}
