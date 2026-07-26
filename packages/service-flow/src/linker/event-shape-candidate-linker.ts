import type { Db } from '../db/connection.js';
import { parseEventSkeletonFact } from '../utils/event-skeleton.js';

export interface EventShapeCandidateLinkSummary {
  edgeCount: number;
}

interface EventShapeRow extends Record<string, unknown> {
  id: number;
  repoId: number;
  repoName: string;
  signature: string;
  skeletonJson: string;
}

interface SubscriberAssociation extends Record<string, unknown> {
  graphEdgeId: number;
  subscribeCallId: number;
  targetKind: string;
  targetId: string;
  status: string;
  evidenceJson: string;
}

function eventRows(
  db: Db,
  workspaceId: number,
  callType: 'async_emit' | 'async_subscribe',
): EventShapeRow[] {
  return db.prepare(`SELECT c.id,c.repo_id repoId,r.name repoName,
    c.event_skeleton_signature signature,
    c.event_skeleton_json skeletonJson
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
  return db.prepare(`SELECT id graphEdgeId,
    CAST(json_extract(evidence_json,'$.subscribeCallId') AS INTEGER)
      subscribeCallId,
    to_kind targetKind,to_id targetId,status,evidence_json evidenceJson
    FROM graph_edges
    WHERE workspace_id=? AND generation=?
      AND edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND to_kind='symbol'
    ORDER BY subscribeCallId,id`).all(
    workspaceId, generation,
  ) as unknown as SubscriberAssociation[];
}

function parsedEvidence(value: string): Record<string, unknown> {
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

function candidateEvidence(
  emit: EventShapeRow,
  subscribe: EventShapeRow,
  association: SubscriberAssociation,
): Record<string, unknown> {
  const evidence = parsedEvidence(association.evidenceJson);
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
    handlerSymbolId: Number(association.targetId),
    associationGraphEdgeId: association.graphEdgeId,
  };
}

function insertCandidate(
  db: Db,
  workspaceId: number,
  generation: number,
  emit: EventShapeRow,
  subscribe: EventShapeRow,
  association: SubscriberAssociation,
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
      emit, subscribe, association,
    )),
    1,
    'event_skeleton_equivalent_non_authoritative',
    generation,
  );
}

export function linkEventShapeCandidates(
  db: Db,
  workspaceId: number,
  generation: number,
): EventShapeCandidateLinkSummary {
  const emits = eventRows(db, workspaceId, 'async_emit');
  const subscriptions = eventRows(db, workspaceId, 'async_subscribe');
  const bySubscription = new Map<number, SubscriberAssociation[]>();
  for (const association of associations(db, workspaceId, generation))
    bySubscription.set(association.subscribeCallId, [
      ...(bySubscription.get(association.subscribeCallId) ?? []),
      association,
    ]);
  let edgeCount = 0;
  for (const emit of emits)
    for (const subscription of subscriptions) {
      if (!candidateEligible(emit, subscription)) continue;
      for (const association of bySubscription.get(subscription.id) ?? []) {
        insertCandidate(
          db, workspaceId, generation, emit, subscription, association,
        );
        edgeCount += 1;
      }
    }
  return { edgeCount };
}
