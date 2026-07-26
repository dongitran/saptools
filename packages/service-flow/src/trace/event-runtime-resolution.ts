import {
  substituteVariables,
  type RuntimeSubstitution,
} from '../linker/dynamic-edge-resolver.js';
import type { Db } from '../db/connection.js';
import {
  eventSubscriberMissingVariables,
  planEventSubscriberTransitions,
  type EventSubscriberTransitionQuery,
  type PlannedEventSubscriberTransition,
} from './event-subscriber-traversal.js';
import type {
  TraversalScopeScheduler,
  TraversalScopeState,
} from './traversal-scope.js';
import type { TraceGraphRow } from './evidence.js';
import {
  eventMissingVariableNames,
  eventTemplateVariables,
  parseEventSkeletonFact,
  type EventSkeletonFact,
} from '../utils/event-skeleton.js';

export interface EventRuntimeResolution {
  row: TraceGraphRow;
  evidence: Record<string, unknown>;
  unresolvedReason?: string;
}

export interface EventSubscriberRuntimePlan {
  plans: PlannedEventSubscriberTransition[];
  diagnostic?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function eventTemplate(evidence: Record<string, unknown>): string | undefined {
  const resolution = record(evidence.eventTemplateResolution);
  return typeof resolution?.original === 'string'
    ? resolution.original : undefined;
}

function eventSkeleton(
  evidence: Record<string, unknown>,
): EventSkeletonFact | undefined {
  return parseEventSkeletonFact(evidence.eventSkeleton);
}

function missingReason(substitution: RuntimeSubstitution): string {
  return `Dynamic target requires runtime variable overrides: ${
    substitution.missing.join(', ')}`;
}

function missingSubscriberDiagnostic(
  missing: readonly string[],
): Record<string, unknown> | undefined {
  if (missing.length === 0) return undefined;
  return {
    severity: 'warning',
    code: 'trace_runtime_variables_missing',
    message: `Runtime variables are required to resolve dynamic event subscribers: ${
      missing.join(', ')}`,
    missingVariables: missing,
    suggestions: missing.map((key) => `--var ${key}=<value>`),
    source: 'event_subscription',
  };
}

export function runtimeEventSubscriberPlans(
  db: Db,
  query: EventSubscriberTransitionQuery,
  scheduler: TraversalScopeScheduler,
  parent: TraversalScopeState,
  depth: number,
  maxDepth: number,
): EventSubscriberRuntimePlan {
  const missing = eventSubscriberMissingVariables(db, query);
  return {
    plans: planEventSubscriberTransitions(
      db, query, scheduler, parent, depth, maxDepth,
    ),
    diagnostic: missingSubscriberDiagnostic(missing),
  };
}

function eventEvidence(
  evidence: Record<string, unknown>,
  substitution: RuntimeSubstitution,
  row: TraceGraphRow,
  unresolvedReason?: string,
): Record<string, unknown> {
  const effectiveResolution = {
    status: unresolvedReason ? 'dynamic' : 'terminal',
    targetKind: row.to_kind,
    targetId: row.to_id,
    confidence: row.confidence,
    unresolvedReason,
    edgeType: row.edge_type,
  };
  const skeleton = eventSkeleton(evidence);
  const missing = eventMissingVariableNames(
    skeleton, substitution.missing,
  );
  return {
    ...evidence,
    runtimeSubstitutions: { eventName: substitution },
    suppliedRuntimeVariables: Object.fromEntries(
      substitution.supplied.map((key) => [key, true]),
    ),
    ...(substitution.supplied.length > 0
      ? { runtimeVariablesApplied: true } : {}),
    ...(missing.length > 0 ? {
      missingRuntimeVariables: missing,
      missingVariableCount: missing.length,
    } : {}),
    effectiveResolution,
    linker: {
      status: effectiveResolution.status,
      confidence: row.confidence,
      reason: unresolvedReason,
      edgeType: row.edge_type,
    },
  };
}

function runtimeEventRow(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  substitution: RuntimeSubstitution,
  template: string,
): TraceGraphRow {
  const missing = substitution.missing.length > 0;
  const eventName = substitution.effective ?? template;
  const callType = evidence.callType;
  const edgeType = callType === 'async_emit'
    ? 'HANDLER_EMITS_EVENT' : 'EVENT_CONSUMED_BY_HANDLER';
  return {
    ...row,
    edge_type: missing ? 'DYNAMIC_EDGE_CANDIDATE' : edgeType,
    status: missing ? 'dynamic' : 'terminal',
    to_kind: missing ? 'event_candidate' : 'event',
    to_id: missing ? `Event: ${eventName}` : eventName,
    unresolved_reason: missing ? missingReason(substitution) : undefined,
  };
}

export function runtimeEventResolution(
  row: TraceGraphRow,
  evidence: Record<string, unknown>,
  variables: Record<string, string> | undefined,
): EventRuntimeResolution | undefined {
  const template = eventTemplate(evidence);
  if (!template || row.to_kind === 'event' && variables === undefined)
    return undefined;
  const skeleton = eventSkeleton(evidence);
  const substitution = substituteVariables(
    template, eventTemplateVariables(skeleton, variables ?? {}),
  );
  const effectiveRow = runtimeEventRow(
    row, evidence, substitution, template,
  );
  return {
    row: effectiveRow,
    evidence: eventEvidence(
      evidence, substitution, effectiveRow, effectiveRow.unresolved_reason,
    ),
    unresolvedReason: effectiveRow.unresolved_reason,
  };
}
