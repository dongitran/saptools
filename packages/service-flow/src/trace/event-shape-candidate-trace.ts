import type { Db } from '../db/connection.js';
import type { TraceOptions } from '../types.js';
import {
  operationNode,
  symbolNode,
  type TraceGraphEdgeRow,
} from './trace-graph-lookups.js';
import type { TraceGraphRow } from './evidence.js';
import {
  eventMissingVariableNames,
  eventTemplateVariables,
  parseEventSkeletonFact,
} from '../utils/event-skeleton.js';

const defaultEventShapeCandidateCap = 5;
const maximumEventShapeCandidateCap = 50;

function candidateCap(options: TraceOptions): number {
  const value = options.maxDynamicCandidates
    ?? defaultEventShapeCandidateCap;
  if (!Number.isSafeInteger(value) || value < 1)
    return defaultEventShapeCandidateCap;
  return Math.min(value, maximumEventShapeCandidateCap);
}

function withCandidateCounts(
  row: TraceGraphEdgeRow,
  total: number,
  shown: number,
  cap: number,
): TraceGraphEdgeRow {
  let evidence: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.evidence_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      evidence = parsed as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    ...row,
    evidence_json: JSON.stringify({
      ...evidence,
      eventShapeCandidateCount: total,
      shownEventShapeCandidateCount: shown,
      omittedEventShapeCandidateCount: Math.max(0, total - shown),
      maxDynamicCandidates: cap,
    }),
  };
}

export function visibleEventShapeRows(
  rows: readonly TraceGraphEdgeRow[],
  options: TraceOptions,
): TraceGraphEdgeRow[] {
  const regular = rows.filter((row) =>
    row.edge_type !== 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER');
  if ((options.dynamicMode ?? 'strict') !== 'candidates') return regular;
  const candidates = rows.filter((row) =>
    row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER');
  const cap = candidateCap(options);
  const shown = candidates.slice(0, cap);
  return [
    ...regular,
    ...shown.map((row) =>
      withCandidateCounts(row, candidates.length, shown.length, cap)),
  ];
}

function recordCandidateOmission(
  diagnostics: Array<Record<string, unknown>>,
  count: number,
  shown: number,
  cap: number,
): void {
  const omitted = Math.max(0, count - shown);
  if (omitted === 0) return;
  const existing = diagnostics.find((item) =>
    item.code === 'event_shape_candidates_omitted');
  if (existing) {
    existing.candidateCount = Number(existing.candidateCount ?? 0) + count;
    existing.shownCandidateCount =
      Number(existing.shownCandidateCount ?? 0) + shown;
    existing.omittedCandidateCount =
      Number(existing.omittedCandidateCount ?? 0) + omitted;
    return;
  }
  diagnostics.push({
    severity: 'info',
    code: 'event_shape_candidates_omitted',
    message: 'Event-shape candidates exceeded the requested trace display cap.',
    candidateCount: count,
    shownCandidateCount: shown,
    omittedCandidateCount: omitted,
    maxDynamicCandidates: cap,
    remediation:
      'Increase --max-dynamic-candidates to inspect more candidates.',
  });
}

export function recordHiddenEventShapeCandidates(
  diagnostics: Array<Record<string, unknown>>,
  rows: readonly TraceGraphEdgeRow[],
  renderedRows: ReadonlyArray<{ edge_type: string }>,
  options: TraceOptions,
): void {
  if (!options.includeAsync) return;
  const count = rows.filter((row) =>
    row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER').length;
  if (count === 0) return;
  const shown = renderedRows.filter((row) =>
    row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER').length;
  const cap = candidateCap(options);
  if ((options.dynamicMode ?? 'strict') === 'candidates') {
    recordCandidateOmission(diagnostics, count, shown, cap);
    return;
  }
  const existing = diagnostics.find((item) =>
    item.code === 'event_shape_candidates_hidden');
  if (existing) {
    existing.candidateCount = Number(existing.candidateCount ?? 0) + count;
    existing.omittedCandidateCount =
      Number(existing.omittedCandidateCount ?? 0) + count;
    return;
  }
  diagnostics.push({
    severity: 'info',
    code: 'event_shape_candidates_hidden',
    message:
      'Non-authoritative event-shape candidates were excluded from strict traversal.',
    candidateCount: count,
    shownCandidateCount: 0,
    omittedCandidateCount: count,
    maxDynamicCandidates: cap,
    dynamicMode: options.dynamicMode ?? 'strict',
    remediation:
      'Use --dynamic-mode candidates to inspect bounded subscriber candidates.',
  });
}

export function outboundTraceEdgeType(
  call: { call_type: string },
  row: { edge_type: string; to_kind: string },
): string {
  if (row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER')
    return 'event_shape_candidate_subscriber';
  if (row.to_kind === 'operation'
    && row.edge_type === 'REMOTE_CALL_RESOLVES_TO_OPERATION')
    return 'remote_action';
  if (row.to_kind === 'operation'
    && row.edge_type === 'LOCAL_CALL_RESOLVES_TO_OPERATION')
    return 'local_service_call';
  return call.call_type;
}

export function outboundTraceTargetNode(
  db: Db,
  row: TraceGraphRow,
  displayTarget = row.to_id,
  repository?: { id?: number; name?: string },
): Record<string, unknown> {
  const operation = row.to_kind === 'operation'
    ? operationNode(db, row.to_id) : undefined;
  const candidate = row.edge_type === 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
    ? repositoryQualifiedCandidateNode(db, Number(row.to_id)) : undefined;
  const resolved = operation ?? candidate;
  return resolved
    ? { ...resolved, aliases: [displayTarget] }
    : {
        id: targetNodeId(row, repository),
        kind: row.to_kind,
        label: displayTarget,
        qualifiedLabel: qualifiedTargetLabel(
          displayTarget, repository?.name,
        ),
        repoId: repository?.id,
        repoName: repository?.name,
      };
}

function targetNodeId(
  row: TraceGraphRow,
  repository: { id?: number; name?: string } | undefined,
): string {
  const scope = repository?.id ?? repository?.name ?? 'workspace';
  return row.to_kind === 'event'
    ? `event:${row.to_id}`
    : `target:${scope}:${row.to_kind}:${row.to_id}`;
}

function qualifiedTargetLabel(
  label: string,
  repository: string | undefined,
): string {
  return repository && !label.startsWith(`${repository}:`)
    ? `${repository}:${label}` : label;
}

function repositoryQualifiedCandidateNode(
  db: Db,
  symbolId: number,
): Record<string, unknown> | undefined {
  const node = symbolNode(db, symbolId);
  if (!node) return undefined;
  const sourceFile = String(node.sourceFile ?? '');
  const fileName = sourceFile.split('/').at(-1) ?? sourceFile;
  return {
    ...node,
    label: `${String(node.repoName)}:${fileName}:${String(
      node.qualifiedName ?? node.symbolName,
    )}`,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
}

function subscriberSkeletons(
  db: Db,
  workspaceId: number,
  publishCallId: number,
): unknown[] {
  return db.prepare(`SELECT subscription.event_skeleton_json skeleton
    FROM outbound_calls publication
    JOIN repositories publication_repo ON publication_repo.id=publication.repo_id
    JOIN outbound_calls subscription
      ON subscription.call_type='async_subscribe'
      AND subscription.event_skeleton_signature
        =publication.event_skeleton_signature
    JOIN repositories subscription_repo
      ON subscription_repo.id=subscription.repo_id
      AND subscription_repo.workspace_id=publication_repo.workspace_id
    WHERE publication.id=? AND publication_repo.workspace_id=?
      AND publication.event_skeleton_signature IS NOT NULL
    ORDER BY subscription_repo.name COLLATE BINARY,
      subscription.repo_id,subscription.source_file COLLATE BINARY,
      subscription.call_site_start_offset,subscription.id`).all(
    publishCallId, workspaceId,
  ).map((row) => row.skeleton);
}

export function eventShapeMissingVariableEvidence(
  db: Db,
  workspaceId: number,
  publishCallId: number,
  evidence: Record<string, unknown>,
  variables: Record<string, string> | undefined,
): Record<string, unknown> {
  const current = stringArray(evidence.missingRuntimeVariables);
  if (current.length === 0) return evidence;
  const names = new Set(current);
  let matchingSubscriptions = 0;
  for (const value of subscriberSkeletons(db, workspaceId, publishCallId)) {
    const skeleton = parseEventSkeletonFact(value);
    if (!skeleton?.candidateEligible) continue;
    matchingSubscriptions += 1;
    const expanded = eventTemplateVariables(skeleton, variables ?? {});
    const missing = skeleton.sourceKeys.filter((key) =>
      !Object.hasOwn(expanded, key));
    for (const name of eventMissingVariableNames(skeleton, missing))
      names.add(name);
  }
  const missing = [...names].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  return {
    ...evidence,
    missingRuntimeVariables: missing,
    missingVariableCount: missing.length,
    eventShapeMatchingSubscriptionCount: matchingSubscriptions,
  };
}

export function eventShapeRuntimeEvidence(
  db: Db,
  workspaceId: number,
  callId: number,
  callType: string,
  evidence: Record<string, unknown>,
  variables: Record<string, string> | undefined,
): Record<string, unknown> {
  return callType === 'async_emit'
    ? eventShapeMissingVariableEvidence(
        db, workspaceId, callId, evidence, variables,
      )
    : evidence;
}
