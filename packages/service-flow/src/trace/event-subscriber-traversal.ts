import type { Db } from '../db/connection.js';
import {
  matchRuntimeTemplate,
  substituteVariables,
} from '../linker/dynamic-edge-resolver.js';
import {
  compareBinary,
  type TraversalScopeScheduler,
  type TraversalScopeState,
} from './traversal-scope.js';
import {
  eventTemplateVariables,
  parseEventSkeletonFact,
} from '../utils/event-skeleton.js';

export type EventSubscriberTransitionStatus =
  | 'resolved'
  | 'ambiguous'
  | 'unresolved';

export interface EventSubscriberSymbolTarget {
  symbolId: number;
  kind: string;
  qualifiedName: string;
  repoId: number;
  repoName: string;
  packageName?: string;
  sourceFile: string;
  sourceLine: number;
  endLine: number;
  startOffset?: number;
  endOffset?: number;
}

export interface EventSubscriberTransition {
  graphEdgeId: number;
  graphGeneration: number;
  eventName: string;
  status: EventSubscriberTransitionStatus;
  targetKind: 'symbol' | 'symbol_reference' | 'subscription_handler';
  targetId: string;
  confidence: number;
  unresolvedReason?: string;
  reasonCode?: string;
  subscribeCallId?: number;
  symbolCallId?: number;
  roleSiteMatchCount: number;
  callRole?: string;
  factOrigin?: string;
  associationBasis?: string;
  dispatchScope?: string;
  subscriptionRepoId?: number;
  subscriptionRepoName?: string;
  sourceFile?: string;
  sourceLine?: number;
  callSiteStartOffset?: number;
  callSiteEndOffset?: number;
  wrapperFunction?: string;
  resolutionStrategy?: string;
  associationStatus?: string;
  symbolCallResolutionStatus?: string;
  candidateCount: number;
  symbolCallUnresolvedReason?: string;
  omittedSymbolCallUnresolvedReasonCharacterCount?: number;
  matchStrategy?: string;
  dispatchCertainty?: string;
  handler?: EventSubscriberSymbolTarget;
}

export interface EventSubscriberTransitionQuery {
  workspaceId: number;
  graphGeneration: number;
  eventName: string;
  vars?: Record<string, string>;
}

export type EventBodyExpansion =
  | 'scheduled'
  | 'already_scheduled'
  | 'already_expanded'
  | 'cycle_blocked'
  | 'depth_limited'
  | 'not_resolved';

export interface PlannedEventSubscriberTransition {
  transition: EventSubscriberTransition;
  node: Record<string, unknown>;
  evidence: Record<string, unknown>;
  bodyExpansion: EventBodyExpansion;
  state?: TraversalScopeState;
}

export function planEventSubscriberTransitions(
  db: Db,
  query: EventSubscriberTransitionQuery,
  scheduler: TraversalScopeScheduler,
  parent: TraversalScopeState,
  depth: number,
  maxDepth: number,
): PlannedEventSubscriberTransition[] {
  return loadEventSubscriberTransitions(db, query).map((transition) => {
    const handler = transition.handler;
    if (transition.status !== 'resolved' || !handler)
      return plannedTransition(transition, 'not_resolved');
    if (depth >= maxDepth)
      return plannedTransition(transition, 'depth_limited');
    const state = scheduler.schedule({
      workspaceId: query.workspaceId,
      repoId: handler.repoId,
      files: new Set([handler.sourceFile]),
      symbolIds: new Set([handler.symbolId]),
      context: new Map(),
    }, parent);
    const bodyExpansion: EventBodyExpansion = state.kind === 'scheduled'
      ? 'scheduled'
      : state.kind === 'cycle' ? 'cycle_blocked'
        : state.alreadyExpanded ? 'already_expanded' : 'already_scheduled';
    return plannedTransition(transition, bodyExpansion, state.state);
  });
}

function plannedTransition(
  transition: EventSubscriberTransition,
  bodyExpansion: EventBodyExpansion,
  state?: TraversalScopeState,
): PlannedEventSubscriberTransition {
  return {
    transition,
    node: eventSubscriberNode(transition),
    evidence: eventTransitionEvidence(transition, bodyExpansion),
    bodyExpansion,
    state,
  };
}

export function eventSubscriberNode(
  transition: EventSubscriberTransition,
): Record<string, unknown> {
  const handler = transition.handler;
  if (!handler) return {
    id: `event_subscription:${transition.graphEdgeId}`,
    kind: transition.targetKind,
    label: `${transition.targetKind}:${transition.targetId}`,
    graphEdgeId: transition.graphEdgeId,
  };
  const fileName = handler.sourceFile.split('/').at(-1) ?? handler.sourceFile;
  return {
    id: `symbol:${handler.symbolId}`,
    kind: 'symbol',
    label: `${fileName}:${handler.qualifiedName}`,
    symbolId: handler.symbolId,
    symbolName: handler.qualifiedName,
    qualifiedName: handler.qualifiedName,
    sourceFile: handler.sourceFile,
    startLine: handler.sourceLine,
    endLine: handler.endLine,
    repoName: handler.repoName,
    repoId: handler.repoId,
  };
}

export function eventTransitionEvidence(
  transition: EventSubscriberTransition,
  bodyExpansion: EventBodyExpansion,
): Record<string, unknown> {
  return {
    graphEdgeId: transition.graphEdgeId,
    graphGeneration: transition.graphGeneration,
    subscribeCallId: transition.subscribeCallId,
    symbolCallId: transition.symbolCallId,
    eventName: transition.eventName,
    matchStrategy: transition.matchStrategy ?? 'workspace_exact_event_name',
    dispatchCertainty: transition.dispatchCertainty ?? 'static_name_only',
    associationBasis: transition.associationBasis,
    dispatchScope: transition.dispatchScope,
    roleSiteMatchCount: transition.roleSiteMatchCount,
    callRole: transition.callRole,
    factOrigin: transition.factOrigin,
    repositoryId: transition.subscriptionRepoId,
    repositoryName: transition.subscriptionRepoName,
    sourceFile: transition.sourceFile,
    sourceLine: transition.sourceLine,
    callSiteStartOffset: transition.callSiteStartOffset,
    callSiteEndOffset: transition.callSiteEndOffset,
    wrapperFunction: transition.wrapperFunction,
    handlerSymbolId: transition.handler?.symbolId,
    handlerSourceFile: transition.handler?.sourceFile,
    handlerSourceLine: transition.handler?.sourceLine,
    associationStatus: transition.associationStatus ?? transition.status,
    symbolCallResolutionStatus: transition.symbolCallResolutionStatus,
    resolutionStatus: transition.status,
    resolutionStrategy: transition.resolutionStrategy,
    candidateCount: transition.candidateCount,
    symbolCallUnresolvedReason: transition.symbolCallUnresolvedReason,
    omittedSymbolCallUnresolvedReasonCharacterCount:
      transition.omittedSymbolCallUnresolvedReasonCharacterCount,
    reasonCode: transition.reasonCode,
    bodyExpansion,
    cycle: bodyExpansion === 'cycle_blocked' || undefined,
    cycleReason: bodyExpansion === 'cycle_blocked'
      ? 'structural_ancestry_cycle' : undefined,
  };
}

export function loadEventSubscriberTransitions(
  db: Db,
  query: EventSubscriberTransitionQuery,
): EventSubscriberTransition[] {
  const rows = db.prepare(`SELECT ge.id graphEdgeId,ge.generation graphGeneration,
      ge.from_kind fromKind,ge.from_id eventName,ge.status,
      ge.to_kind targetKind,ge.to_id targetId,
      ge.confidence,ge.unresolved_reason unresolvedReason,ge.evidence_json evidenceJson,
      subscribe.id subscribeCallId,subscribe.repo_id subscriptionRepoId,
      subscribe.source_file sourceFile,subscribe.source_line sourceLine,
      subscribe.call_site_start_offset callSiteStartOffset,
      subscribe.call_site_end_offset callSiteEndOffset,
      subscription_repo.name subscriptionRepoName,
      handler.id handlerSymbolId,handler.kind handlerKind,
      handler.qualified_name handlerQualifiedName,handler.source_file handlerSourceFile,
      handler.start_line handlerSourceLine,handler.end_line handlerEndLine,
      handler.start_offset handlerStartOffset,handler.end_offset handlerEndOffset,
      handler_repo.id handlerRepoId,handler_repo.name handlerRepoName,
      handler_repo.package_name handlerPackageName
    FROM graph_edges ge
    LEFT JOIN outbound_calls subscribe
      ON subscribe.id=CAST(json_extract(ge.evidence_json,'$.subscribeCallId') AS INTEGER)
    LEFT JOIN repositories subscription_repo
      ON subscription_repo.id=subscribe.repo_id
      AND subscription_repo.workspace_id=ge.workspace_id
    LEFT JOIN symbols handler
      ON ge.to_kind='symbol' AND handler.id=CAST(ge.to_id AS INTEGER)
    LEFT JOIN repositories handler_repo
      ON handler_repo.id=handler.repo_id AND handler_repo.workspace_id=ge.workspace_id
    WHERE ge.workspace_id=? AND ge.generation=?
      AND ge.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND ge.from_kind IN ('event','event_candidate')
    ORDER BY COALESCE(subscription_repo.name,'') COLLATE BINARY,
      COALESCE(subscription_repo.id,0),COALESCE(subscribe.source_file,'') COLLATE BINARY,
      subscribe.call_site_start_offset,subscribe.call_site_end_offset,ge.id`).all(
    query.workspaceId, query.graphGeneration,
  );
  return rows.flatMap((raw) => {
    const row = eventRowForQuery(raw, query);
    const transition = row ? transitionFromRow(row) : undefined;
    return transition ? [transition] : [];
  });
}

function eventRowForQuery(
  row: Record<string, unknown>,
  query: EventSubscriberTransitionQuery,
): Record<string, unknown> | undefined {
  const exact = exactPersistedEventRow(row, query);
  if (exact) return exact;
  const variables = query.vars;
  if (variables === undefined) return undefined;
  const evidence = parseEvidence(row.evidenceJson);
  const resolution = isRecord(evidence.eventTemplateResolution)
    ? evidence.eventTemplateResolution : {};
  if (typeof resolution.original !== 'string')
    return undefined;
  return runtimeMatchedEventRow(
    row, query, evidence, resolution.original, variables,
  );
}

function exactPersistedEventRow(
  row: Record<string, unknown>,
  query: EventSubscriberTransitionQuery,
): Record<string, unknown> | undefined {
  return row.fromKind === 'event' && row.eventName === query.eventName
    ? row : undefined;
}

function runtimeMatchedEventRow(
  row: Record<string, unknown>,
  query: EventSubscriberTransitionQuery,
  evidence: Record<string, unknown>,
  template: string,
  variables: Record<string, string>,
): Record<string, unknown> | undefined {
  const skeleton = parseEventSkeletonFact(evidence.eventSkeleton);
  const substitution = substituteVariables(
    template, eventTemplateVariables(skeleton, variables),
  );
  if (substitution.missing.length > 0
    || substitution.effective !== query.eventName) return undefined;
  const resolvedAssociation = evidence.associationStatus === 'resolved';
  return {
    ...row,
    eventName: query.eventName,
    status: typeof evidence.associationStatus === 'string'
      ? evidence.associationStatus : row.status,
    unresolvedReason: resolvedAssociation ? null : row.unresolvedReason,
    evidenceJson: JSON.stringify({
      ...evidence,
      eventSubscriptionRuntimeSubstitution: substitution,
      matchStrategy: 'workspace_exact_event_name_after_runtime_substitution',
      dispatchCertainty: 'runtime_variables_exact',
    }),
  };
}

export function eventSubscriberMissingVariables(
  db: Db,
  query: EventSubscriberTransitionQuery,
): string[] {
  const variables = query.vars ?? {};
  const rows = db.prepare(`SELECT ge.from_id eventName,
    ge.evidence_json evidenceJson FROM graph_edges ge
    WHERE ge.workspace_id=? AND ge.generation=?
      AND ge.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND ge.from_kind='event_candidate'`).all(
    query.workspaceId, query.graphGeneration,
  );
  const missing = rows.flatMap((row) => {
    const evidence = parseEvidence(row.evidenceJson);
    const resolution = isRecord(evidence.eventTemplateResolution)
      ? evidence.eventTemplateResolution : {};
    const template = typeof resolution.original === 'string'
      ? resolution.original : undefined;
    if (!template) return [];
    const skeleton = parseEventSkeletonFact(evidence.eventSkeleton);
    const substitution = substituteVariables(
      template, eventTemplateVariables(skeleton, variables),
    );
    if (substitution.missing.length === 0
      || matchRuntimeTemplate(
        substitution.effective, query.eventName,
      ) === undefined) return [];
    return substitution.missing;
  });
  return [...new Set(missing)].sort(compareBinary);
}

function transitionFromRow(
  row: Record<string, unknown>,
): EventSubscriberTransition | undefined {
  const graphEdgeId = numberValue(row.graphEdgeId);
  const graphGeneration = numberValue(row.graphGeneration);
  const eventName = stringValue(row.eventName);
  const targetId = stringValue(row.targetId);
  if (graphEdgeId === undefined || graphGeneration === undefined
    || eventName === undefined || targetId === undefined) return undefined;
  const evidence = parseEvidence(row.evidenceJson);
  const handler = symbolTarget(row);
  const status = transitionStatus(stringValue(row.status), handler);
  const reasonCode = status === 'resolved'
    ? undefined
    : stringValue(evidence.reasonCode) ?? missingTargetReason(row, handler);
  return {
    graphEdgeId, graphGeneration, eventName, status,
    targetKind: targetKind(row.targetKind), targetId,
    confidence: numberValue(row.confidence) ?? 0,
    unresolvedReason: status === 'resolved'
      ? undefined : stringValue(row.unresolvedReason) ?? reasonCode,
    reasonCode,
    ...associationEvidence(row, evidence),
    handler,
  };
}

function associationEvidence(
  row: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Omit<EventSubscriberTransition,
  'graphEdgeId' | 'graphGeneration' | 'eventName' | 'status' | 'targetKind'
  | 'targetId' | 'confidence' | 'unresolvedReason' | 'reasonCode' | 'handler'> {
  const symbolCallUnresolvedReason = stringValue(
    evidence.symbolCallUnresolvedReason,
  );
  return {
    subscribeCallId: numberValue(row.subscribeCallId),
    symbolCallId: numberValue(evidence.symbolCallId),
    roleSiteMatchCount: nonNegativeCount(evidence.roleSiteMatchCount),
    callRole: stringValue(evidence.callRole),
    factOrigin: stringValue(evidence.factOrigin),
    associationBasis: stringValue(evidence.associationBasis),
    dispatchScope: stringValue(evidence.dispatchScope),
    subscriptionRepoId: numberValue(row.subscriptionRepoId),
    subscriptionRepoName: stringValue(row.subscriptionRepoName),
    sourceFile: stringValue(row.sourceFile),
    sourceLine: numberValue(row.sourceLine),
    callSiteStartOffset: numberValue(row.callSiteStartOffset),
    callSiteEndOffset: numberValue(row.callSiteEndOffset),
    wrapperFunction: stringValue(evidence.wrapperFunction),
    resolutionStrategy: stringValue(evidence.resolutionStrategy),
    associationStatus: stringValue(evidence.associationStatus),
    symbolCallResolutionStatus: stringValue(evidence.symbolCallResolutionStatus),
    candidateCount: nonNegativeCount(evidence.candidateCount),
    symbolCallUnresolvedReason,
    omittedSymbolCallUnresolvedReasonCharacterCount: symbolCallUnresolvedReason
      ? nonNegativeCount(evidence.omittedSymbolCallUnresolvedReasonCharacterCount)
      : undefined,
    matchStrategy: stringValue(evidence.matchStrategy),
    dispatchCertainty: stringValue(evidence.dispatchCertainty),
  };
}

function symbolTarget(
  row: Record<string, unknown>,
): EventSubscriberSymbolTarget | undefined {
  const symbolId = numberValue(row.handlerSymbolId);
  const repoId = numberValue(row.handlerRepoId);
  const repoName = stringValue(row.handlerRepoName);
  const sourceFile = stringValue(row.handlerSourceFile);
  const sourceLine = numberValue(row.handlerSourceLine);
  const endLine = numberValue(row.handlerEndLine);
  const kind = stringValue(row.handlerKind);
  const qualifiedName = stringValue(row.handlerQualifiedName);
  if (symbolId === undefined || repoId === undefined || !repoName || !sourceFile
    || sourceLine === undefined || endLine === undefined || !kind || !qualifiedName)
    return undefined;
  return {
    symbolId, repoId, repoName, sourceFile, sourceLine, endLine, kind, qualifiedName,
    packageName: stringValue(row.handlerPackageName),
    startOffset: numberValue(row.handlerStartOffset),
    endOffset: numberValue(row.handlerEndOffset),
  };
}

function transitionStatus(
  value: string | undefined,
  handler: EventSubscriberSymbolTarget | undefined,
): EventSubscriberTransitionStatus {
  if (value === 'resolved' && handler) return 'resolved';
  return value === 'ambiguous' ? 'ambiguous' : 'unresolved';
}

function missingTargetReason(
  row: Record<string, unknown>,
  handler: EventSubscriberSymbolTarget | undefined,
): string | undefined {
  return stringValue(row.status) === 'resolved' && !handler
    ? 'subscription_handler_target_missing'
    : undefined;
}

function targetKind(
  value: unknown,
): EventSubscriberTransition['targetKind'] {
  return value === 'symbol' || value === 'symbol_reference'
    || value === 'subscription_handler' ? value : 'subscription_handler';
}

function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '{}'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonNegativeCount(value: unknown): number {
  const count = numberValue(value);
  return count === undefined ? 0 : Math.max(0, Math.floor(count));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
