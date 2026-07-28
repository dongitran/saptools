import type { Db } from '../db/connection.js';
import {
  substituteVariables,
  type RuntimeSubstitution,
} from './dynamic-edge-resolver.js';
import {
  resolveEventEnvironment,
} from './event-environment-link.js';
import {
  eventTemplateVariables,
  parseEventSkeletonFact,
  type EventSkeletonFact,
} from '../utils/event-skeleton.js';

export interface LinkedEventTemplate {
  targetId: string;
  targetKind: 'event' | 'event_candidate';
  status: 'terminal' | 'dynamic';
  isDynamic: boolean;
  unresolvedReason?: string;
  substitution: RuntimeSubstitution;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function receiverEvidence(
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  const nested = evidence.outboundEvidence;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : evidence;
}

export function eventReceiverUnprovenReason(
  evidence: Record<string, unknown>,
): string | undefined {
  const receiver = receiverEvidence(evidence);
  if (receiver.receiverClassification !== 'unproven') return undefined;
  return stringField(receiver, 'receiverUnresolvedReason')
    ?? 'event_receiver_unproven_binding';
}

export function applyEventReceiverProof(
  event: LinkedEventTemplate,
  evidence: Record<string, unknown>,
): LinkedEventTemplate {
  const reason = eventReceiverUnprovenReason(evidence);
  if (event.isDynamic || reason === undefined) return event;
  return {
    ...event,
    targetId: `Event: ${event.targetId}`,
    targetKind: 'event_candidate',
    status: 'dynamic',
    isDynamic: true,
    unresolvedReason: reason,
  };
}

export function linkEventTemplate(
  template: string,
  variables: Record<string, string>,
  parserReason?: string,
  skeleton?: EventSkeletonFact,
): LinkedEventTemplate {
  const substitution = substituteVariables(
    template, eventTemplateVariables(skeleton, variables),
  );
  const missing = substitution.missing.length > 0;
  const unsupportedDynamic = substitution.placeholders.length === 0
    && parserReason !== undefined;
  const dynamic = missing || unsupportedDynamic;
  return {
    targetId: dynamic
      ? `Event: ${substitution.effective ?? template}`
      : substitution.effective ?? template,
    targetKind: dynamic ? 'event_candidate' : 'event',
    status: dynamic ? 'dynamic' : 'terminal',
    isDynamic: dynamic,
    unresolvedReason: missing
      ? `Dynamic target requires runtime variable overrides: ${
          substitution.missing.join(', ')}`
      : unsupportedDynamic ? parserReason : undefined,
    substitution,
  };
}

export function insertEventCallEdge(
  db: Db,
  workspaceId: number,
  generation: number,
  call: Record<string, unknown>,
  variables: Record<string, string>,
  evidence: Record<string, unknown>,
): { status: string; callType: string } {
  const callType = String(call.call_type);
  const skeleton = parseEventSkeletonFact(call.event_skeleton_json);
  const environment = resolveEventEnvironment(
    call.event_skeleton_json,
    call.environmentDeclarationsJson,
    variables,
  );
  const published = linkEventTemplate(
    String(call.event_name_expr ?? ''), environment.variables,
    typeof call.unresolved_reason === 'string'
      ? call.unresolved_reason : undefined,
    skeleton,
  );
  const receiverUnprovenReason = published.isDynamic
    ? undefined : eventReceiverUnprovenReason(evidence);
  const receiverUnproven = receiverUnprovenReason !== undefined;
  // Keeping a statically named publication terminal is a deliberate
  // compatibility trade: it recovers CAP emitters whose client propagation
  // cannot be proven, while dispatchCertainty preserves the weaker proof.
  // Subscriptions retain the stricter receiver gate so stream listeners cannot
  // become event consumers.
  const event = callType === 'async_emit'
    ? published : applyEventReceiverProof(published, evidence);
  const edgeType = event.isDynamic
    ? 'DYNAMIC_EDGE_CANDIDATE'
    : callType === 'async_emit'
      ? 'HANDLER_EMITS_EVENT' : 'EVENT_CONSUMED_BY_HANDLER';
  const eventEvidence = {
    ...evidence,
    dispatchScope: 'workspace_event_name_only',
    dispatchCertainty: receiverUnproven
      ? 'receiver_unproven'
      : environment.status === 'resolved'
      ? 'environment_declaration_exact'
      : event.isDynamic ? 'runtime_variables_required' : 'static_name_only',
    ...(skeleton ? { eventSkeleton: skeleton } : {}),
    ...(event.substitution.placeholders.length > 0
      ? { eventTemplateResolution: event.substitution } : {}),
    ...(environment.status === 'not_applicable' ? {} : {
      eventEnvironmentResolution: {
        status: environment.status,
        reason: environment.reason,
        provenance: environment.provenance,
      },
    }),
  };
  const unresolvedReason = environment.reason
    ?? event.unresolvedReason
    ?? receiverUnprovenReason;
  db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId, edgeType, event.status, 'call', String(call.id),
    event.targetKind, event.targetId, Number(call.confidence ?? 0.2),
    JSON.stringify(eventEvidence), event.isDynamic ? 1 : 0,
    unresolvedReason ?? null, generation,
  );
  return { status: event.status, callType };
}
