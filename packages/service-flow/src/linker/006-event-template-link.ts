import type { Db } from '../db/connection.js';
import {
  substituteVariables,
  type RuntimeSubstitution,
} from './dynamic-edge-resolver.js';

export interface LinkedEventTemplate {
  targetId: string;
  targetKind: 'event' | 'event_candidate';
  status: 'terminal' | 'dynamic';
  isDynamic: boolean;
  unresolvedReason?: string;
  substitution: RuntimeSubstitution;
}

export function linkEventTemplate(
  template: string,
  variables: Record<string, string>,
  parserReason?: string,
): LinkedEventTemplate {
  const substitution = substituteVariables(template, variables);
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
  const event = linkEventTemplate(
    String(call.event_name_expr ?? ''), variables,
    typeof call.unresolved_reason === 'string'
      ? call.unresolved_reason : undefined,
  );
  const edgeType = event.isDynamic
    ? 'DYNAMIC_EDGE_CANDIDATE'
    : callType === 'async_emit'
      ? 'HANDLER_EMITS_EVENT' : 'EVENT_CONSUMED_BY_HANDLER';
  const eventEvidence = event.substitution.placeholders.length > 0
    ? { ...evidence, eventTemplateResolution: event.substitution }
    : evidence;
  db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId, edgeType, event.status, 'call', String(call.id),
    event.targetKind, event.targetId, Number(call.confidence ?? 0.2),
    JSON.stringify(eventEvidence), event.isDynamic ? 1 : 0,
    event.unresolvedReason ?? null, generation,
  );
  return { status: event.status, callType };
}
