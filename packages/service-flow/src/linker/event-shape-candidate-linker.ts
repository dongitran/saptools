import type { Db } from '../db/connection.js';
import { parseEventSkeletonFact } from '../utils/event-skeleton.js';
import { boundCandidateLikeEvidence } from '../utils/bounded-projection.js';
import { resolveEventEnvironment } from './event-environment-link.js';
import { linkEventTemplate } from './event-template-link.js';

export interface EventShapeCandidateLinkSummary {
  edgeCount: number;
  omittedCount: number;
}

const EVENT_SHAPE_LINK_CAP_PER_EMIT = 100;

interface EventShapeRow extends Record<string, unknown> {
  id: number;
  repoId: number;
  repoName: string;
  signature: string;
  skeletonJson: string;
  evidenceJson: string;
  sourceFile: string;
  sourceLine: number;
  eventName: string;
  environmentJson: string | null;
}

interface SubscriberAssociation extends Record<string, unknown> {
  graphEdgeId: number;
  subscribeCallId: number;
  targetKind: string;
  targetId: string;
  status: string;
  evidenceJson: string;
  targetLabel?: string | null;
}

function eventRows(
  db: Db,
  workspaceId: number,
  callType: 'async_emit' | 'async_subscribe',
): EventShapeRow[] {
  return db.prepare(`SELECT c.id,c.repo_id repoId,r.name repoName,
    c.event_skeleton_signature signature,
    c.event_skeleton_json skeletonJson,c.evidence_json evidenceJson,
    c.source_file sourceFile,c.source_line sourceLine,
    c.event_name_expr eventName,
    r.environment_declarations_json environmentJson
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE r.workspace_id=? AND c.call_type=?
      AND c.event_skeleton_signature IS NOT NULL
      AND c.event_skeleton_json IS NOT NULL
    ORDER BY c.event_skeleton_signature COLLATE BINARY,
      r.name COLLATE BINARY,r.id,c.source_file COLLATE BINARY,
      c.call_site_start_offset,c.call_site_end_offset,c.id`).all(
    workspaceId, callType,
  ) as unknown as EventShapeRow[];
}

function associations(
  db: Db,
  workspaceId: number,
  generation: number,
): SubscriberAssociation[] {
  return db.prepare(`SELECT edge.id graphEdgeId,
    CAST(json_extract(edge.evidence_json,'$.subscribeCallId') AS INTEGER)
      subscribeCallId,
    edge.to_kind targetKind,edge.to_id targetId,edge.status,
    edge.evidence_json evidenceJson,
    target_repo.name || ':' || target.source_file || ':'
      || target.qualified_name targetLabel
    FROM graph_edges edge
    LEFT JOIN symbols target ON edge.to_kind='symbol'
      AND target.id=CAST(edge.to_id AS INTEGER)
    LEFT JOIN repositories target_repo ON target_repo.id=target.repo_id
    WHERE edge.workspace_id=? AND edge.generation=?
      AND edge.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND edge.to_kind='symbol'
    ORDER BY subscribeCallId,edge.id`).all(
    workspaceId, generation,
  ) as unknown as SubscriberAssociation[];
}

function parsedEvidence(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function candidateEligible(
  emit: EventShapeRow,
  subscribe: EventShapeRow,
): boolean {
  if (emit.signature !== subscribe.signature) return false;
  const left = parseEventSkeletonFact(emit.skeletonJson);
  const right = parseEventSkeletonFact(subscribe.skeletonJson);
  return Boolean(left?.candidateEligible && right?.candidateEligible
    && left.holeCount === right.holeCount
    && JSON.stringify(left.literalSpans) === JSON.stringify(right.literalSpans));
}

function deploymentCompatible(
  emit: EventShapeRow,
  subscribe: EventShapeRow,
  association: SubscriberAssociation,
): boolean {
  const emitSkeleton = parseEventSkeletonFact(emit.skeletonJson);
  const subscribeSkeleton = parseEventSkeletonFact(subscribe.skeletonJson);
  const emitKeys = new Set(emitSkeleton?.environmentBindings
    .map((binding) => binding.environmentKey).filter(Boolean));
  const sharedKey = subscribeSkeleton?.environmentBindings.some((binding) =>
    binding.environmentKey && emitKeys.has(binding.environmentKey));
  const evidence = parsedEvidence(association.evidenceJson);
  const subscriptionEnvironment = parsedEvidence(
    evidence.eventEnvironmentResolution,
  );
  if (subscriptionEnvironment.status === 'unresolved') return false;
  if (!sharedKey) return true;
  const environment = resolveEventEnvironment(
    emit.skeletonJson, emit.environmentJson, {},
  );
  if (environment.status !== 'resolved') return false;
  const event = linkEventTemplate(
    emit.eventName, environment.variables, undefined, emitSkeleton,
  );
  return subscriptionEnvironment.status === 'resolved'
    && evidence.effectiveEventName === event.targetId;
}

function candidateEvidence(
  emit: EventShapeRow,
  subscribe: EventShapeRow,
  association: SubscriberAssociation,
  total: number,
  shown: number,
): Record<string, unknown> {
  const evidence = parsedEvidence(association.evidenceJson);
  const parser = parsedEvidence(emit.evidenceJson);
  return {
    publishCallId: emit.id,
    subscribeCallId: subscribe.id,
    eventSkeletonSignature: emit.signature,
    dispatchScope: 'workspace_event_name_only',
    dispatchCertainty: 'skeleton_equivalent',
    subscriptionRepositoryId: subscribe.repoId,
    subscriptionRepositoryName: subscribe.repoName,
    subscriptionConsumerRepositoryId:
      evidence.subscriptionConsumerRepositoryId,
    subscriptionConsumerRepositoryName:
      evidence.subscriptionConsumerRepositoryName,
    deploymentScope: evidence.subscriptionConsumerRepositoryId === undefined
      ? 'subscription_repository'
      : 'same_consumer_repository',
    handlerSymbolId: Number(association.targetId),
    eventShapeCandidateTargetLabel: association.targetLabel,
    associationGraphEdgeId: association.graphEdgeId,
    outboundEvidence: boundCandidateLikeEvidence(parser),
    eventShapeLinkCandidateCount: total,
    shownEventShapeLinkCandidateCount: shown,
    omittedEventShapeLinkCandidateCount: Math.max(0, total - shown),
  };
}

function insertCandidate(
  db: Db,
  workspaceId: number,
  generation: number,
  emit: EventShapeRow,
  subscribe: EventShapeRow,
  association: SubscriberAssociation,
  total: number,
  shown: number,
): void {
  db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId,
    'EVENT_SHAPE_CANDIDATE_SUBSCRIBER',
    'dynamic',
    'call',
    String(emit.id),
    association.targetKind,
    association.targetId,
    0.3,
    JSON.stringify(candidateEvidence(
      emit, subscribe, association, total, shown,
    )),
    1,
    'event_skeleton_equivalent_non_authoritative',
    generation,
  );
}

interface ShapeCandidate {
  subscription: EventShapeRow;
  association: SubscriberAssociation;
}

function candidatesForEmit(
  emit: EventShapeRow,
  subscriptions: readonly EventShapeRow[],
  bySubscription: ReadonlyMap<number, SubscriberAssociation[]>,
): ShapeCandidate[] {
  return subscriptions.flatMap((subscription) =>
    !candidateEligible(emit, subscription) ? []
      : (bySubscription.get(subscription.id) ?? [])
          .filter((association) =>
            deploymentCompatible(emit, subscription, association))
          .map((association) => ({ subscription, association })));
}

function recordExpansionRefusal(
  db: Db,
  emit: EventShapeRow,
  candidateCount: number,
): void {
  db.prepare(`INSERT INTO diagnostics(
    repo_id,severity,code,message,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(
    emit.repoId,
    'warning',
    'event_shape_candidate_expansion_refused',
    `Event-shape expansion produced ${candidateCount} candidates and was refused instead of being silently truncated.`,
    emit.sourceFile,
    emit.sourceLine,
  );
}

export function linkEventShapeCandidates(
  db: Db,
  workspaceId: number,
  generation: number,
): EventShapeCandidateLinkSummary {
  db.prepare(`DELETE FROM diagnostics WHERE code=
    'event_shape_candidate_expansion_refused' AND repo_id IN (
      SELECT id FROM repositories WHERE workspace_id=?
    )`).run(workspaceId);
  const emits = eventRows(db, workspaceId, 'async_emit');
  const subscriptions = eventRows(db, workspaceId, 'async_subscribe');
  const bySubscription = new Map<number, SubscriberAssociation[]>();
  for (const association of associations(db, workspaceId, generation))
    bySubscription.set(association.subscribeCallId, [
      ...(bySubscription.get(association.subscribeCallId) ?? []),
      association,
    ]);
  let edgeCount = 0;
  let omittedCount = 0;
  for (const emit of emits) {
    const candidates = candidatesForEmit(
      emit, subscriptions, bySubscription,
    );
    if (candidates.length > EVENT_SHAPE_LINK_CAP_PER_EMIT) {
      recordExpansionRefusal(db, emit, candidates.length);
      omittedCount += candidates.length;
      continue;
    }
    for (const candidate of candidates) {
      insertCandidate(
        db, workspaceId, generation, emit, candidate.subscription,
        candidate.association, candidates.length, candidates.length,
      );
      edgeCount += 1;
    }
  }
  return { edgeCount, omittedCount };
}
