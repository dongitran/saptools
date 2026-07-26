import type { Db } from '../db/connection.js';

type Diagnostic = Record<string, unknown>;

const eventNameReason = `COALESCE(
  json_extract(c.evidence_json,'$.eventNameUnresolvedReason'),
  CASE WHEN c.unresolved_reason GLOB 'dynamic_event_name_*'
    OR c.unresolved_reason GLOB 'event_name_*'
    THEN c.unresolved_reason END
)`;

function workspacePredicate(alias: string): string {
  return `(? IS NULL OR ${alias}.workspace_id=?)`;
}

function count(value: unknown): number {
  return Number(value ?? 0);
}

function unresolvedEventNameExamples(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT r.name repositoryName,
    c.source_file sourceFile,c.source_line sourceLine,
    c.event_name_expr eventName,${eventNameReason} reason
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type='async_emit' AND ${workspacePredicate('r')}
      AND ${eventNameReason} IS NOT NULL
    ORDER BY r.name COLLATE BINARY,c.source_file COLLATE BINARY,
      c.source_line,c.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function eventNameResolutionQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN reason IS NOT NULL THEN 1 ELSE 0 END) unresolved
    FROM (SELECT ${eventNameReason} reason
      FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
      WHERE c.call_type='async_emit' AND ${workspacePredicate('r')})`).get(
    workspaceId, workspaceId,
  );
  const reasons = db.prepare(`SELECT ${eventNameReason} reason,COUNT(*) count
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type='async_emit' AND ${workspacePredicate('r')}
      AND ${eventNameReason} IS NOT NULL
    GROUP BY reason ORDER BY count DESC,reason COLLATE BINARY LIMIT 16`).all(
    workspaceId, workspaceId,
  );
  const unresolved = count(aggregate?.unresolved);
  return {
    severity: unresolved > 0 ? 'warning' : 'info',
    code: 'strict_event_name_resolution_quality',
    message: 'Event publication name-resolution aggregate',
    publicationTotal: count(aggregate?.total),
    unresolvedPublicationCount: unresolved,
    reasonBuckets: reasons,
    examples: unresolvedEventNameExamples(db, workspaceId),
    exampleCount: unresolved,
  };
}

function dynamicEventExamples(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT r.name repositoryName,c.call_type callType,
    c.source_file sourceFile,c.source_line sourceLine,
    e.to_kind targetKind,e.to_id targetId,e.unresolved_reason reason
    FROM graph_edges e JOIN outbound_calls c
      ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER)
    JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
      AND ${workspacePredicate('r')}
      AND (e.to_kind='event_candidate'
        OR e.edge_type='DYNAMIC_EDGE_CANDIDATE')
    ORDER BY r.name COLLATE BINARY,c.source_file COLLATE BINARY,
      c.source_line,c.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function dynamicEventQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const row = db.prepare(`SELECT
    COUNT(DISTINCT CASE WHEN e.to_kind='event_candidate'
      THEN e.workspace_id || ':' || e.to_id END) eventCandidateNodeCount,
    COUNT(*) dynamicEventEdgeCount,
    SUM(CASE WHEN json_array_length(e.evidence_json,
      '$.eventTemplateResolution.placeholders')>0 THEN 1 ELSE 0 END)
      variableRecoverableCount
    FROM graph_edges e JOIN outbound_calls c
      ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER)
    JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
      AND ${workspacePredicate('r')}
      AND (e.to_kind='event_candidate'
        OR e.edge_type='DYNAMIC_EDGE_CANDIDATE')`).get(
    workspaceId, workspaceId,
  );
  const total = count(row?.dynamicEventEdgeCount);
  const recoverable = count(row?.variableRecoverableCount);
  return {
    severity: total > 0 ? 'warning' : 'info',
    code: 'strict_event_dynamic_candidate_quality',
    message: 'Dynamic event candidate aggregate',
    eventCandidateNodeCount: count(row?.eventCandidateNodeCount),
    dynamicEventEdgeCount: total,
    eventCandidateCount: total,
    variableRecoverableCount: recoverable,
    nonVariableRecoverableCount: Math.max(0, total - recoverable),
    examples: dynamicEventExamples(db, workspaceId),
    exampleCount: total,
  };
}

function unmatchedPublicationRows(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT r.name repositoryName,c.source_file sourceFile,
    c.source_line sourceLine,e.to_id eventName
    FROM graph_edges e JOIN outbound_calls c
      ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER)
    JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type='async_emit' AND e.edge_type='HANDLER_EMITS_EVENT'
      AND e.to_kind='event' AND ${workspacePredicate('r')}
      AND NOT EXISTS (SELECT 1 FROM graph_edges subscription
        WHERE subscription.workspace_id=e.workspace_id
          AND subscription.generation=e.generation
          AND subscription.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
          AND subscription.from_kind='event'
          AND subscription.from_id=e.to_id)
    ORDER BY r.name COLLATE BINARY,c.source_file COLLATE BINARY,
      c.source_line,c.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function unmatchedPublicationQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const row = db.prepare(`SELECT COUNT(*) count
    FROM graph_edges e JOIN outbound_calls c
      ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER)
    JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type='async_emit' AND e.edge_type='HANDLER_EMITS_EVENT'
      AND e.to_kind='event' AND ${workspacePredicate('r')}
      AND NOT EXISTS (SELECT 1 FROM graph_edges subscription
        WHERE subscription.workspace_id=e.workspace_id
          AND subscription.generation=e.generation
          AND subscription.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
          AND subscription.from_kind='event'
          AND subscription.from_id=e.to_id)`).get(workspaceId, workspaceId);
  const total = count(row?.count);
  return {
    severity: total > 0 ? 'warning' : 'info',
    code: 'strict_event_publication_without_subscription_quality',
    message: 'Resolved event publications without a matching subscription',
    unmatchedPublicationCount: total,
    examples: unmatchedPublicationRows(db, workspaceId),
    exampleCount: total,
  };
}

function unmatchedSubscriptionRows(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT COALESCE(json_extract(e.evidence_json,
      '$.subscriptionConsumerRepositoryName'),
      json_extract(e.evidence_json,'$.repositoryName')) repositoryName,
    json_extract(e.evidence_json,'$.sourceFile') sourceFile,
    json_extract(e.evidence_json,'$.sourceLine') sourceLine,
    e.from_id eventName,
    json_extract(c.evidence_json,'$.subscriptionLoopRegistrationStatus')
      loopRegistrationStatus,
    json_extract(c.evidence_json,'$.subscriptionLoopRegistrationCount')
      loopRegistrationCount
    FROM graph_edges e LEFT JOIN outbound_calls c
      ON c.id=CAST(json_extract(e.evidence_json,'$.subscribeCallId') AS INTEGER)
    WHERE e.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND ${workspacePredicate('e')}
      AND NOT EXISTS (SELECT 1 FROM graph_edges publication
        WHERE publication.workspace_id=e.workspace_id
          AND publication.generation=e.generation
          AND publication.edge_type='HANDLER_EMITS_EVENT'
          AND publication.to_kind='event'
          AND publication.to_id=e.from_id)
    ORDER BY repositoryName COLLATE BINARY,sourceFile COLLATE BINARY,
      sourceLine,e.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function unmatchedSubscriptionQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const row = db.prepare(`SELECT COUNT(*) siteCount,
    SUM(CASE
      WHEN json_extract(c.evidence_json,
        '$.subscriptionLoopRegistrationStatus')='enumerated'
        THEN CAST(json_extract(c.evidence_json,
          '$.subscriptionLoopRegistrationCount') AS INTEGER)
      WHEN json_extract(c.evidence_json,
        '$.subscriptionLoopRegistrationStatus')='unresolved' THEN 0
      ELSE 1 END) count,
    SUM(CASE WHEN json_extract(c.evidence_json,
      '$.subscriptionLoopRegistrationStatus')='unresolved'
      THEN 1 ELSE 0 END) unknownMultiplicitySiteCount
    FROM graph_edges e LEFT JOIN outbound_calls c
      ON c.id=CAST(json_extract(e.evidence_json,'$.subscribeCallId') AS INTEGER)
    WHERE e.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND ${workspacePredicate('e')}
      AND NOT EXISTS (SELECT 1 FROM graph_edges publication
        WHERE publication.workspace_id=e.workspace_id
          AND publication.generation=e.generation
          AND publication.edge_type='HANDLER_EMITS_EVENT'
          AND publication.to_kind='event'
          AND publication.to_id=e.from_id)`).get(workspaceId, workspaceId);
  const total = count(row?.count);
  const siteCount = count(row?.siteCount);
  return {
    severity: siteCount > 0 ? 'warning' : 'info',
    code: 'strict_event_subscription_without_publication_quality',
    message: 'Event subscriptions without a matching publication',
    unmatchedSubscriptionCount: total,
    unmatchedSubscriptionSiteCount: siteCount,
    unknownMultiplicitySiteCount: count(row?.unknownMultiplicitySiteCount),
    examples: unmatchedSubscriptionRows(db, workspaceId),
    exampleCount: siteCount,
  };
}

function receiverProofQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const row = db.prepare(`SELECT COUNT(*) eventTotal,
    SUM(CASE WHEN json_extract(c.evidence_json,
      '$.receiverClassification')='cap_evidence' THEN 1 ELSE 0 END) proven,
    SUM(CASE WHEN json_extract(c.evidence_json,
      '$.receiverClassification')='name_fallback' THEN 1 ELSE 0 END)
      nameFallback,
    SUM(CASE WHEN json_extract(c.evidence_json,
      '$.receiverClassification')='unproven' THEN 1 ELSE 0 END) unproven
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
      AND ${workspacePredicate('r')}`).get(workspaceId, workspaceId);
  const buckets = db.prepare(`SELECT CASE
      WHEN json_extract(c.evidence_json,
        '$.receiverClassification')='name_fallback' THEN 'name_fallback'
      WHEN json_extract(c.evidence_json,
        '$.receiverClassification')='unproven'
        THEN COALESCE(c.unresolved_reason,'unproven')
      ELSE 'missing' END reason,COUNT(*) count
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
      AND ${workspacePredicate('r')}
      AND json_extract(c.evidence_json,'$.receiverClassification')
        <>'cap_evidence'
    GROUP BY reason ORDER BY count DESC,reason COLLATE BINARY LIMIT 16`).all(
    workspaceId, workspaceId,
  );
  const questionable = count(row?.nameFallback) + count(row?.unproven);
  return {
    severity: questionable > 0 ? 'warning' : 'info',
    code: 'strict_event_receiver_classification_quality',
    message: 'CAP event receiver proof aggregate',
    eventTotal: count(row?.eventTotal),
    proven: count(row?.proven),
    nameFallback: count(row?.nameFallback),
    unproven: count(row?.unproven),
    questionable,
    reasonBuckets: buckets,
    examples: receiverProofExamples(db, workspaceId),
    exampleCount: questionable,
  };
}

function receiverProofExamples(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT r.name repositoryName,c.call_type callType,
    c.source_file sourceFile,c.source_line sourceLine,
    json_extract(c.evidence_json,'$.receiverClassification')
      receiverClassification,
    c.unresolved_reason reason
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
      AND ${workspacePredicate('r')}
      AND json_extract(c.evidence_json,'$.receiverClassification')
        <>'cap_evidence'
    ORDER BY r.name COLLATE BINARY,c.source_file COLLATE BINARY,
      c.source_line,c.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function shapeEnvironmentExamples(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return db.prepare(`SELECT e.edge_type edgeType,e.from_id fromId,
    e.to_kind toKind,e.to_id toId,
    json_extract(e.evidence_json,
      '$.eventEnvironmentResolution.status') environmentStatus,
    json_extract(e.evidence_json,
      '$.eventEnvironmentResolution.collisionCount') collisionCount
    FROM graph_edges e WHERE ${workspacePredicate('e')}
      AND (e.edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
        OR json_extract(e.evidence_json,
          '$.eventEnvironmentResolution.status')='ambiguous'
        OR CAST(json_extract(e.evidence_json,
          '$.eventEnvironmentResolution.collisionCount') AS INTEGER)>1)
    ORDER BY e.edge_type COLLATE BINARY,e.from_id COLLATE BINARY,
      e.to_id COLLATE BINARY,e.id LIMIT 5`).all(
    workspaceId, workspaceId,
  ) as Diagnostic[];
}

function shapeEnvironmentQuality(
  db: Db,
  workspaceId?: number,
): Diagnostic {
  const row = db.prepare(`SELECT
    SUM(CASE WHEN e.edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
      THEN 1 ELSE 0 END) shapeCandidates,
    SUM(CASE WHEN json_extract(e.evidence_json,
      '$.eventEnvironmentResolution.status')='ambiguous'
      OR CAST(json_extract(e.evidence_json,
        '$.eventEnvironmentResolution.collisionCount') AS INTEGER)>1
      THEN 1 ELSE 0 END) environmentAmbiguities
    FROM graph_edges e WHERE ${workspacePredicate('e')}`).get(
    workspaceId, workspaceId,
  );
  const shapes = count(row?.shapeCandidates);
  const ambiguous = count(row?.environmentAmbiguities);
  return {
    severity: shapes + ambiguous > 0 ? 'warning' : 'info',
    code: 'strict_event_shape_environment_quality',
    message: 'Event skeleton candidate and environment ambiguity aggregate',
    skeletonCandidateCount: shapes,
    environmentBindingAmbiguityCount: ambiguous,
    examples: shapeEnvironmentExamples(db, workspaceId),
    exampleCount: shapes + ambiguous,
  };
}

export function eventSurfaceQualityDiagnostics(
  db: Db,
  workspaceId?: number,
): Diagnostic[] {
  return [
    eventNameResolutionQuality(db, workspaceId),
    dynamicEventQuality(db, workspaceId),
    unmatchedPublicationQuality(db, workspaceId),
    unmatchedSubscriptionQuality(db, workspaceId),
    receiverProofQuality(db, workspaceId),
    shapeEnvironmentQuality(db, workspaceId),
  ];
}
