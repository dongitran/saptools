import type { Db } from '../db/connection.js';

export interface SubscriptionHandlerLinkSummary {
  edgeCount: number;
  resolvedCount: number;
  ambiguousCount: number;
  unresolvedCount: number;
  missingAssociationCount: number;
}

interface SubscriptionRow {
  id: number;
  workspaceId: number;
  repoId: number;
  repoName: string;
  sourceSymbolId?: number | null;
  eventName: string;
  sourceFile: string;
  sourceLine: number;
  startOffset?: number | null;
  endOffset?: number | null;
  confidence: number;
}

interface HandlerCallRow {
  id: number;
  callerSymbolId: number;
  calleeSymbolId?: number | null;
  status: string;
  unresolvedReason?: string | null;
  confidence: number;
  sourceLine: number;
  factOrigin?: string | null;
  wrapperFunction?: string | null;
  strategy?: string | null;
  candidateCount?: number | null;
  targetSourceFile?: string | null;
  targetSourceLine?: number | null;
  targetWorkspaceId?: number | null;
}

interface HandlerAssociation {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  toKind: 'symbol' | 'symbol_reference' | 'subscription_handler';
  toId: string;
  reasonCode?: string;
  call?: HandlerCallRow;
  matchCount: number;
  missing: boolean;
  factOrigin?: string;
  symbolCallResolutionStatus?: string;
}

const symbolCallReasonLimit = 512;

function subscriptionRows(db: Db, workspaceId: number): SubscriptionRow[] {
  return db.prepare(`SELECT c.id,r.workspace_id workspaceId,c.repo_id repoId,r.name repoName,
    c.source_symbol_id sourceSymbolId,c.event_name_expr eventName,
    c.source_file sourceFile,c.source_line sourceLine,
    c.call_site_start_offset startOffset,c.call_site_end_offset endOffset,
    c.confidence
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE r.workspace_id=? AND c.call_type='async_subscribe'
    ORDER BY r.name COLLATE BINARY,r.id,c.source_file COLLATE BINARY,
      c.call_site_start_offset,c.call_site_end_offset,c.id`).all(
    workspaceId,
  ) as unknown as SubscriptionRow[];
}

function roleSiteRows(db: Db, subscription: SubscriptionRow): HandlerCallRow[] {
  if (typeof subscription.startOffset !== 'number'
    || typeof subscription.endOffset !== 'number') return [];
  return db.prepare(`SELECT sc.id,sc.caller_symbol_id callerSymbolId,
    sc.callee_symbol_id calleeSymbolId,sc.status,
    sc.unresolved_reason unresolvedReason,sc.confidence,sc.source_line sourceLine,
    json_extract(sc.evidence_json,'$.factOrigin') factOrigin,
    json_extract(sc.evidence_json,'$.wrapperFunction') wrapperFunction,
    json_extract(sc.evidence_json,'$.candidateStrategy') strategy,
    json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
    target.source_file targetSourceFile,target.start_line targetSourceLine,
    target_repo.workspace_id targetWorkspaceId
    FROM symbol_calls sc LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
    LEFT JOIN repositories target_repo ON target_repo.id=target.repo_id
    WHERE sc.repo_id=? AND sc.source_file=?
      AND sc.call_site_start_offset=? AND sc.call_site_end_offset=?
      AND sc.call_role='event_subscribe_handler'
    ORDER BY sc.id`).all(
    subscription.repoId,
    subscription.sourceFile,
    subscription.startOffset,
    subscription.endOffset,
  ) as unknown as HandlerCallRow[];
}

function invalidSpan(subscription: SubscriptionRow): boolean {
  return typeof subscription.startOffset !== 'number'
    || typeof subscription.endOffset !== 'number'
    || subscription.startOffset < 0
    || subscription.endOffset <= subscription.startOffset;
}

function associationFor(
  subscription: SubscriptionRow,
  matches: HandlerCallRow[],
): HandlerAssociation {
  if (invalidSpan(subscription)) return missingAssociation(
    subscription.id, matches.length, 'subscription_call_span_missing',
  );
  if (matches.length === 0) return missingAssociation(
    subscription.id, 0, 'subscription_handler_role_site_missing',
  );
  if (matches.length > 1) return ambiguousRoleSiteAssociation(
    subscription.id, matches,
  );
  const call = matches[0];
  return call
    ? singleCallAssociation(subscription, call)
    : missingAssociation(
      subscription.id, 0, 'subscription_handler_role_site_missing',
    );
}

function ambiguousRoleSiteAssociation(
  subscriptionId: number,
  matches: HandlerCallRow[],
): HandlerAssociation {
  return {
    status: 'ambiguous', toKind: 'subscription_handler',
    toId: String(subscriptionId), reasonCode: 'multiple_handler_role_site_matches',
    matchCount: matches.length, missing: false,
    factOrigin: agreedOrMixed(matches.map((match) => match.factOrigin)),
    symbolCallResolutionStatus: agreedOrMixed(
      matches.map((match) => match.status),
    ),
  };
}

function singleCallAssociation(
  subscription: SubscriptionRow,
  call: HandlerCallRow,
): HandlerAssociation {
  const mismatch = associationMismatch(subscription, call);
  if (mismatch) return missingAssociation(subscription.id, 1, mismatch, call);
  return handlerReferenceAssociation(call);
}

function associationMismatch(
  subscription: SubscriptionRow,
  call: HandlerCallRow,
): string | undefined {
  if (subscription.sourceSymbolId != null
    && call.callerSymbolId !== subscription.sourceSymbolId)
    return 'subscription_handler_caller_mismatch';
  if (call.sourceLine !== subscription.sourceLine)
    return 'subscription_handler_source_line_mismatch';
  if (call.targetWorkspaceId != null
    && call.targetWorkspaceId !== subscription.workspaceId)
    return 'subscription_handler_target_workspace_mismatch';
  return undefined;
}

function handlerReferenceAssociation(call: HandlerCallRow): HandlerAssociation {
  if (call.status === 'resolved' && typeof call.calleeSymbolId === 'number')
    return { status: 'resolved', toKind: 'symbol', toId: String(call.calleeSymbolId), call, matchCount: 1, missing: false };
  if (call.status === 'ambiguous') return {
    status: 'ambiguous', toKind: 'symbol_reference', toId: String(call.id),
    reasonCode: 'subscription_handler_reference_ambiguous', call,
    matchCount: 1, missing: false,
  };
  return {
    status: 'unresolved', toKind: 'symbol_reference', toId: String(call.id),
    reasonCode: call.status === 'resolved'
      ? 'resolved_handler_symbol_missing'
      : 'subscription_handler_reference_unresolved',
    call, matchCount: 1, missing: false,
  };
}

function agreedOrMixed(
  values: Array<string | null | undefined>,
): string | undefined {
  const distinct = new Set(values.map((value) => value ?? 'missing'));
  if (distinct.size > 1) return 'mixed';
  const value = distinct.values().next().value;
  return value === 'missing' ? undefined : value;
}

function missingAssociation(
  subscriptionId: number,
  matchCount: number,
  reasonCode: string,
  call?: HandlerCallRow,
): HandlerAssociation {
  return {
    status: 'unresolved', toKind: 'subscription_handler',
    toId: String(subscriptionId), reasonCode, call, matchCount, missing: true,
  };
}

function evidenceFor(
  subscription: SubscriptionRow,
  association: HandlerAssociation,
): Record<string, unknown> {
  const call: Partial<HandlerCallRow> = association.call ?? {};
  const symbolCallReason = boundedSymbolCallReason(call.unresolvedReason);
  return {
    eventName: subscription.eventName,
    associationBasis: 'exact_subscription_call_span',
    dispatchScope: 'workspace_event_name_only',
    subscribeCallId: subscription.id,
    symbolCallId: call.id,
    roleSiteMatchCount: association.matchCount,
    callRole: association.matchCount > 0 ? 'event_subscribe_handler' : undefined,
    factOrigin: association.factOrigin ?? call.factOrigin,
    repositoryId: subscription.repoId,
    repositoryName: subscription.repoName,
    sourceFile: subscription.sourceFile,
    sourceLine: subscription.sourceLine,
    callSiteStartOffset: subscription.startOffset,
    callSiteEndOffset: subscription.endOffset,
    handlerSymbolId: call.calleeSymbolId,
    handlerSourceFile: call.targetSourceFile,
    handlerSourceLine: call.targetSourceLine,
    wrapperFunction: call.wrapperFunction,
    associationStatus: association.status,
    symbolCallResolutionStatus:
      association.symbolCallResolutionStatus ?? call.status,
    resolutionStatus: association.status,
    resolutionStrategy: call.strategy,
    candidateCount: call.candidateCount,
    reasonCode: association.reasonCode,
    ...symbolCallReason,
  };
}

function boundedSymbolCallReason(
  reason: string | null | undefined,
): Record<string, unknown> {
  if (!reason) return {};
  const value = reason.slice(0, symbolCallReasonLimit);
  return {
    symbolCallUnresolvedReason: value,
    omittedSymbolCallUnresolvedReasonCharacterCount:
      Math.max(0, reason.length - value.length),
  };
}

function insertAssociationEdge(
  db: Db,
  workspaceId: number,
  generation: number,
  subscription: SubscriptionRow,
  association: HandlerAssociation,
): void {
  db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,unresolved_reason,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId,
    'EVENT_SUBSCRIPTION_HANDLED_BY',
    association.status,
    'event',
    subscription.eventName,
    association.toKind,
    association.toId,
    association.call?.confidence ?? subscription.confidence,
    JSON.stringify(evidenceFor(subscription, association)),
    0,
    association.reasonCode ?? association.call?.unresolvedReason ?? null,
    generation,
  );
}

export function linkEventSubscriptionHandlers(
  db: Db,
  workspaceId: number,
  generation: number,
): SubscriptionHandlerLinkSummary {
  const summary: SubscriptionHandlerLinkSummary = {
    edgeCount: 0,
    resolvedCount: 0,
    ambiguousCount: 0,
    unresolvedCount: 0,
    missingAssociationCount: 0,
  };
  for (const subscription of subscriptionRows(db, workspaceId)) {
    const association = associationFor(
      subscription, roleSiteRows(db, subscription),
    );
    insertAssociationEdge(
      db, workspaceId, generation, subscription, association,
    );
    summary.edgeCount += 1;
    summary.resolvedCount += association.status === 'resolved' ? 1 : 0;
    summary.ambiguousCount += association.status === 'ambiguous' ? 1 : 0;
    summary.unresolvedCount += association.status === 'unresolved' ? 1 : 0;
    summary.missingAssociationCount += association.missing ? 1 : 0;
  }
  return summary;
}
