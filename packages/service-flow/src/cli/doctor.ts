import type { Db } from '../db/connection.js';
import { classifyODataPathIntent, normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { implementationHintSuggestions } from '../trace/implementation-hints.js';
import { ANALYZER_VERSION } from '../version.js';

type Diagnostic = Record<string, unknown>;
interface DoctorOptions {
  detail?: boolean;
}

export function linkUpgradeWarnings(db: Db): Diagnostic[] {
  return [...schemaDriftDiagnostics(db, true), ...analyzerVersionDiagnostics(db, true)]
    .filter((item) => ['schema_legacy_columns_present', 'external_target_columns_missing_data', 'reindex_required_after_upgrade', 'reindex_required_after_analyzer_upgrade'].includes(String(item.code)));
}

export function doctorDiagnostics(db: Db, strict: boolean, options: DoctorOptions = {}): Diagnostic[] {
  const diagnostics = db.prepare('SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics ORDER BY id').all() as Diagnostic[];
  return [
    ...diagnostics,
    ...healthDiagnostics(db, strict),
    ...remoteTargetWithoutImplementationDiagnostics(db, strict, Boolean(options.detail)),
    ...localServiceDiagnostics(db, strict),
    ...schemaDriftDiagnostics(db, strict),
    ...analyzerVersionDiagnostics(db, strict),
    ...parserQualityDiagnostics(db, strict, options),
  ];
}

function healthDiagnostics(db: Db, strict: boolean): Diagnostic[] {
  return db.prepare(
    `SELECT 'info' severity,'entity_only_service' code,'CDS service has no action/function/event operations; this can be valid for entity-only services' message,s.source_file sourceFile,s.source_line sourceLine
     FROM cds_services s LEFT JOIN cds_operations o ON o.service_id=s.id WHERE o.id IS NULL AND ?
     UNION ALL
     SELECT 'warning','extend_service_unresolved_base','Extend service has no indexed local operations; verify base service resolution',s.source_file,s.source_line
     FROM cds_services s LEFT JOIN cds_operations o ON o.service_id=s.id WHERE o.id IS NULL AND s.is_extend=1 AND ?
     UNION ALL
     SELECT 'warning','handler_without_service','Repository has handlers but no CDS services',hc.source_file,hc.source_line
     FROM handler_classes hc JOIN repositories r ON r.id=hc.repo_id
     WHERE r.kind IN ('cap-service','mixed') AND NOT EXISTS (SELECT 1 FROM cds_services s WHERE s.repo_id=hc.repo_id)
     UNION ALL
     SELECT 'warning','search_index_empty','Search index is empty after indexing',NULL,NULL
     WHERE NOT EXISTS (SELECT 1 FROM search_index)
     UNION ALL
     SELECT 'error','foreign_key_violation','SQLite foreign_key_check reported integrity failures',NULL,NULL
     WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)
     UNION ALL
     SELECT 'warning','legacy_schema_weaker_foreign_keys','Legacy table lacks fresh-schema foreign-key metadata; rebuild the database or re-run init/index in a new database',NULL,NULL
     WHERE (SELECT COUNT(*) FROM pragma_foreign_key_list('graph_edges'))=0 OR (SELECT COUNT(*) FROM pragma_foreign_key_list('index_runs'))=0 OR (SELECT COUNT(*) FROM pragma_foreign_key_list('diagnostics'))=0
     UNION ALL
     SELECT CASE WHEN ? THEN 'warning' ELSE 'error' END,'local_service_calls_all_unresolved','All local service calls are unresolved; verify local service alias parsing and linking',NULL,NULL
     WHERE EXISTS (SELECT 1 FROM outbound_calls WHERE call_type='local_service_call') AND NOT EXISTS (SELECT 1 FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call' AND e.status='resolved')
     UNION ALL
     SELECT 'error','local_service_accessor_misclassified','Entity accessor calls were indexed as /entities operations',source_file,source_line
     FROM outbound_calls WHERE call_type='local_service_call' AND operation_path_expr='/entities' AND (? OR 1)
     UNION ALL
     SELECT 'warning','outbound_calls_without_source_symbol','Outbound calls lack source symbol ownership: ' || COUNT(*),NULL,NULL
     FROM outbound_calls WHERE source_symbol_id IS NULL AND ? HAVING COUNT(*) >= 1
     UNION ALL
     SELECT 'warning','trace_scope_fell_back_to_file','Trace may fall back to source-file scope for calls without symbols',NULL,NULL
     WHERE EXISTS (SELECT 1 FROM outbound_calls WHERE source_symbol_id IS NULL) AND ?
     UNION ALL
     SELECT 'warning','graph_stale','Graph is stale after repository fact changes; run service-flow link',NULL,NULL
     WHERE EXISTS (SELECT 1 FROM repositories WHERE graph_stale_reason IS NOT NULL)
     UNION ALL
     SELECT 'warning','index_run_abandoned','Index run ' || id || ' started at ' || started_at || ' is still running after the 60 minute abandonment threshold',NULL,NULL
     FROM index_runs WHERE status='running' AND datetime(started_at) < datetime('now','-60 minutes')`,
  ).all(strict, strict, strict, strict, strict, strict) as Diagnostic[];
}


function remoteTargetWithoutImplementationDiagnostics(db: Db, strict: boolean, detail: boolean): Diagnostic[] {
  if (!strict) return [];
  const groups = db.prepare(`SELECT s.service_path servicePath,o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,COUNT(*) callSiteCount
    FROM graph_edges remote JOIN cds_operations o ON o.id=CAST(remote.to_id AS INTEGER) JOIN cds_services s ON s.id=o.service_id
    WHERE remote.edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' AND remote.to_kind='operation'
      AND NOT EXISTS (SELECT 1 FROM graph_edges impl WHERE impl.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND impl.from_kind='operation' AND impl.from_id=remote.to_id)
    GROUP BY s.service_path,o.operation_path,o.source_file,o.source_line
    ORDER BY s.service_path,o.operation_path`).all() as Array<{ servicePath?: string; operationPath?: string; sourceFile?: string | null; sourceLine?: number | null; callSiteCount?: number }>;
  return groups.map((group) => {
    const examples = remoteTargetWithoutImplementationExamples(db, String(group.servicePath ?? ''), String(group.operationPath ?? ''));
    return {
      severity: 'warning',
      code: 'remote_target_without_implementation',
      message: `Remote target operation has no implementation edge: ${String(group.servicePath ?? '')}${String(group.operationPath ?? '')}`,
      sourceFile: group.sourceFile,
      sourceLine: group.sourceLine,
      servicePath: group.servicePath,
      operationPath: group.operationPath,
      callSiteCount: Number(group.callSiteCount ?? 0),
      examples: examples.slice(0, 3),
      expandedExamples: detail ? examples : undefined,
    };
  });
}

function remoteTargetWithoutImplementationExamples(db: Db, servicePath: string, operationPath: string): Diagnostic[] {
  return db.prepare(`SELECT r.name repo,c.source_file sourceFile,c.source_line sourceLine,c.operation_path_expr operationPathExpr
    FROM graph_edges remote JOIN cds_operations o ON o.id=CAST(remote.to_id AS INTEGER) JOIN cds_services s ON s.id=o.service_id
    LEFT JOIN outbound_calls c ON remote.from_kind='call' AND c.id=CAST(remote.from_id AS INTEGER)
    LEFT JOIN repositories r ON r.id=c.repo_id
    WHERE remote.edge_type='REMOTE_CALL_RESOLVES_TO_OPERATION' AND remote.to_kind='operation'
      AND s.service_path=? AND o.operation_path=?
      AND NOT EXISTS (SELECT 1 FROM graph_edges impl WHERE impl.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND impl.from_kind='operation' AND impl.from_id=remote.to_id)
    ORDER BY r.name,c.source_file,c.source_line`).all(servicePath, operationPath) as Diagnostic[];
}

function schemaDriftDiagnostics(db: Db, strict: boolean): Diagnostic[] {
  if (!strict) return [];
  const columns = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name?: string }>;
  const legacy = columns.filter((row) => ['external_target_kind', 'external_target_id', 'external_target_label', 'external_target_dynamic'].includes(String(row.name))).map((row) => row.name);
  const missing = db.prepare("SELECT id id,source_file sourceFile,source_line sourceLine FROM outbound_calls WHERE call_type='external_http' AND (external_target_id IS NULL OR external_target_label IS NULL OR external_target_kind IS NULL) LIMIT 20").all() as Diagnostic[];
  const out: Diagnostic[] = [];
  if (legacy.length > 0) out.push({ severity: 'warning', code: 'schema_legacy_columns_present', message: 'Legacy external-target columns are present on symbols; run service-flow clean --db-only, then init/index/link to rebuild with the current schema.', scope: 'workspace', affectedColumns: legacy, remediation: 'service-flow clean --db-only && service-flow init <workspace> && service-flow index && service-flow link' });
  if (missing.length > 0) out.push({ severity: 'warning', code: 'external_target_columns_missing_data', message: 'External HTTP calls are missing queryable external target metadata; reindex is required after upgrade.', scope: 'workspace', affectedRows: missing, remediation: 'service-flow index --force && service-flow link' });
  if (legacy.length > 0 || missing.length > 0) out.push({ severity: 'warning', code: 'reindex_required_after_upgrade', message: 'This database cannot be made equivalent to a fresh index by relink alone.', scope: 'workspace', remediation: 'Rebuild or force reindex the workspace, then run service-flow doctor --strict.' });
  return out;
}

function analyzerVersionDiagnostics(db: Db, strict: boolean): Diagnostic[] {
  if (!strict) return [];
  const rows = db.prepare("SELECT name,COALESCE(fact_analyzer_version,'legacy') factAnalyzerVersion FROM repositories WHERE index_status='indexed' AND COALESCE(fact_analyzer_version,'legacy')<>?").all(ANALYZER_VERSION) as Diagnostic[];
  if (rows.length === 0) return [];
  return [{ severity: 'warning', code: 'reindex_required_after_analyzer_upgrade', message: 'Repository facts were produced by an older or unknown analyzer; run service-flow index --force before relink to apply current parser semantics.', scope: 'workspace', affectedRepositoryCount: rows.length, currentAnalyzerVersion: ANALYZER_VERSION, repositories: rows, remediation: 'service-flow index --force && service-flow link' }];
}

function localServiceDiagnostics(db: Db, strict: boolean): Diagnostic[] {
  const rows = db.prepare("SELECT e.status status,e.unresolved_reason reason,e.evidence_json evidenceJson FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE c.call_type='local_service_call'").all() as Array<{ status?: string; reason?: string | null; evidenceJson?: string }>;
  const implementationContext = rows.filter((row) => row.status === 'resolved' && String(row.evidenceJson ?? '').includes('implementation_context_caller_ownership')).length;
  const withoutOwnership = rows.filter((row) => row.reason === 'local_service_candidate_without_caller_ownership' || String(row.evidenceJson ?? '').includes('local_service_candidate_without_caller_ownership')).length;
  const unresolved = rows.filter((row) => row.status === 'unresolved').length;
  const outsideScope = rows.filter((row) => row.status === 'unresolved' && candidateCount(row.evidenceJson) > 0).length;
  const out: Diagnostic[] = [];
  if (withoutOwnership > 0) out.push({ severity: 'warning', code: 'local_service_candidate_without_caller_ownership', message: `Local service calls have operation candidates but no caller ownership evidence: ${withoutOwnership}` });
  if (outsideScope > 0) out.push({ severity: 'warning', code: 'local_service_candidates_outside_local_scope', message: `Local service calls found candidates outside same-repository scope: ${outsideScope}` });
  if (strict && unresolved > 0) out.push({ severity: 'warning', code: 'local_service_calls_unresolved', message: `Unresolved local service calls: ${unresolved}` });
  if (strict && implementationContext > 0) out.push({ severity: 'info', code: 'local_service_calls_resolved_by_implementation_context', message: `Local service calls resolved by implementation-context ownership: ${implementationContext}` });
  return out;
}

function parserQualityDiagnostics(db: Db, strict: boolean, options: DoctorOptions): Diagnostic[] {
  if (!strict) return [];
  const symbol = symbolCallQuality(db);
  const dbq = dbQueryQuality(db);
  const outbound = outboundOwnershipQuality(db);
  return [
    identityAliasBindingQuality(db),
    remoteActionNoBindingQuality(db),
    contextualImplementationQuality(db),
    implementationCandidateQuality(db, Boolean(options.detail)),
    classInstanceNoiseQuality(db),
    contextualBindingPropagationQuality(db),
    serviceBindingQuality(db, Boolean(options.detail)),
    decoratorResolutionQuality(db),
    handlerRegistrationPairingQuality(db),
    nestedThisReceiverQuality(db),
    wrapperPathPropagationQuality(db),
    remoteQueryTargetQuality(db),
    remoteEntityOperationCollisionQuality(db),
    remoteEntityDynamicOperationFalsePositiveQuality(db),
    remoteActionTargetQuality(db),
    externalHttpTargetQuality(db),
    odataInvocationResolutionQuality(db),
    ...jsonEvidenceQuality(db),
    eventReceiverQuality(db),
    graphDynamicFlagQuality(db),
    symbol,
    dbq,
    outbound,
  ];
}

function jsonEvidenceQuality(db: Db): Diagnostic[] {
  const symbol = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN json_valid(evidence_json)=0 OR json_type(evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject FROM symbol_calls").get() as Record<string, unknown>;
  const outbound = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN evidence_json IS NULL THEN 1 ELSE 0 END) missing, SUM(CASE WHEN evidence_json IS NOT NULL AND json_valid(evidence_json)=0 THEN 1 ELSE 0 END) invalid, SUM(CASE WHEN evidence_json IS NOT NULL AND json_valid(evidence_json)=1 AND json_type(evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject FROM outbound_calls").get() as Record<string, unknown>;
  const graph = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_type(e.evidence_json) <> 'object' THEN 1 ELSE 0 END) nonObject, SUM(CASE WHEN e.evidence_json IS NOT NULL AND json_valid(e.evidence_json)=1 AND json_extract(e.evidence_json,'$.outboundEvidence.parser') IS NOT NULL THEN 1 ELSE 0 END) withOutboundEvidence FROM graph_edges e WHERE e.from_kind='call'").get() as Record<string, unknown>;
  const outboundExamples = db.prepare("SELECT call_type callType,source_file sourceFile,source_line sourceLine FROM outbound_calls WHERE evidence_json IS NULL OR json_valid(evidence_json)=0 OR json_type(evidence_json) <> 'object' ORDER BY source_file,source_line LIMIT 10").all() as Diagnostic[];
  const graphExamples = db.prepare("SELECT c.call_type callType,c.source_file sourceFile,c.source_line sourceLine,e.edge_type edgeType FROM graph_edges e JOIN outbound_calls c ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER) WHERE e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_type(e.evidence_json) <> 'object' OR json_extract(e.evidence_json,'$.outboundEvidence.parser') IS NULL ORDER BY c.source_file,c.source_line LIMIT 10").all() as Diagnostic[];
  return [
    { severity: Number(symbol.nonObject ?? 0) > 0 ? 'warning' : 'info', code: 'strict_symbol_call_evidence_quality', message: 'Symbol-call evidence JSON object aggregate', total: Number(symbol.total ?? 0), nonObject: Number(symbol.nonObject ?? 0) },
    { severity: Number(outbound.missing ?? 0) + Number(outbound.invalid ?? 0) + Number(outbound.nonObject ?? 0) > 0 ? 'warning' : 'info', code: 'strict_outbound_evidence_quality', message: 'Outbound parser evidence JSON object aggregate', total: Number(outbound.total ?? 0), missing: Number(outbound.missing ?? 0), invalid: Number(outbound.invalid ?? 0), nonObject: Number(outbound.nonObject ?? 0), examples: outboundExamples },
    { severity: Number(graph.nonObject ?? 0) > 0 || Number(graph.withOutboundEvidence ?? 0) < Number(graph.total ?? 0) ? 'warning' : 'info', code: 'strict_graph_evidence_quality', message: 'Call-derived graph evidence and parser-evidence propagation aggregate', total: Number(graph.total ?? 0), nonObject: Number(graph.nonObject ?? 0), withOutboundEvidence: Number(graph.withOutboundEvidence ?? 0), examples: graphExamples },
  ];
}

function symbolCallQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved, SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) unresolved FROM symbol_calls").get() as Record<string, unknown>;
  const top = db.prepare("SELECT callee_expression calleeExpression,COUNT(*) count FROM symbol_calls WHERE status='unresolved' GROUP BY callee_expression ORDER BY count DESC,callee_expression LIMIT 5").all() as Diagnostic[];
  const total = Number(row.total ?? 0);
  const unresolved = Number(row.unresolved ?? 0);
  const ratio = total === 0 ? 0 : Number((unresolved / total).toFixed(4));
  return { severity: ratio > 0.05 ? 'warning' : 'info', code: 'strict_symbol_call_quality', message: 'Symbol-call quality aggregate', total, resolved: Number(row.resolved ?? 0), unresolved, unresolvedRatio: ratio, unresolvedRatioThreshold: 0.05, topUnresolvedCallees: top };
}

function dbQueryQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN query_entity IS NOT NULL THEN 1 ELSE 0 END) known, SUM(CASE WHEN query_entity IS NULL THEN 1 ELSE 0 END) unknown FROM outbound_calls WHERE call_type='local_db_query'").get() as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const unknown = Number(row.unknown ?? 0);
  const ratio = total === 0 ? 0 : Number((unknown / total).toFixed(4));
  return { severity: ratio > 0.25 ? 'warning' : 'info', code: 'strict_db_query_quality', message: 'Local DB query quality aggregate', total, known: Number(row.known ?? 0), unknown, unknownRatio: ratio, unknownRatioThreshold: 0.25 };
}

function outboundOwnershipQuality(db: Db): Diagnostic {
  const row = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN source_symbol_id IS NULL THEN 1 ELSE 0 END) withoutOwnership FROM outbound_calls').get() as Record<string, unknown>;
  const byType = db.prepare('SELECT call_type callType, COUNT(*) count FROM outbound_calls WHERE source_symbol_id IS NULL GROUP BY call_type ORDER BY count DESC, call_type').all() as Diagnostic[];
  const examples = db.prepare('SELECT call_type callType,source_file sourceFile,source_line sourceLine,unresolved_reason unresolvedReason FROM outbound_calls WHERE source_symbol_id IS NULL ORDER BY source_file,source_line LIMIT 10').all() as Diagnostic[];
  const total = Number(row.total ?? 0);
  const without = Number(row.withoutOwnership ?? 0);
  const ratio = total === 0 ? 0 : Number((without / total).toFixed(4));
  return { severity: ratio > 0.01 ? 'warning' : 'info', code: 'strict_outbound_source_ownership_quality', message: 'Outbound call source-symbol ownership aggregate', total, withoutOwnership: without, withoutOwnershipRatio: ratio, withoutOwnershipRatioThreshold: 0.01, ownerlessByType: byType, ownerlessExamples: examples };
}

function eventReceiverQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT SUM(CASE WHEN call_type IN ('async_emit','async_subscribe') THEN 1 ELSE 0 END) eventTotal, SUM(CASE WHEN call_type IN ('async_emit','async_subscribe') AND (json_extract(evidence_json,'$.receiverClassification') IS NULL OR json_extract(evidence_json,'$.receiverClassification') <> 'cap_evidence') THEN 1 ELSE 0 END) questionable FROM outbound_calls").get() as Record<string, unknown>;
  return { severity: Number(row.questionable ?? 0) > 0 ? 'warning' : 'info', code: 'strict_event_receiver_classification_quality', message: 'CAP event receiver classification aggregate', eventTotal: Number(row.eventTotal ?? 0), questionable: Number(row.questionable ?? 0) };
}

function graphDynamicFlagQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) count FROM graph_edges WHERE status='terminal' AND is_dynamic=1").get() as Record<string, unknown>;
  return { severity: Number(row.count ?? 0) > 0 ? 'warning' : 'info', code: 'strict_graph_dynamic_flag_consistency', message: 'Graph dynamic flag consistency aggregate', dynamicTerminalEdges: Number(row.count ?? 0) };
}

function implementationCandidateQuality(db: Db, detail: boolean): Diagnostic {
  const categories = [...implementationEdgeCategories(db, detail), missingParameterMetadataCategory(db, detail), dynamicWrapperCategory(db, detail)].filter((item) => item.count > 0);
  const total = categories.reduce((sum, item) => sum + item.count, 0);
  return { severity: total > 0 ? 'warning' : 'info', code: 'strict_implementation_candidate_quality', message: 'Implementation candidate ambiguity and rejection aggregate', total, summary: implementationSummary(categories), categories };
}

function implementationEdgeCategories(db: Db, detail: boolean): Array<Diagnostic & { count: number }> {
  const rows = db.prepare(`SELECT e.status,e.unresolved_reason unresolvedReason,e.evidence_json evidenceJson,o.operation_name operationName,base.operation_name baseOperation,s.service_path servicePath
    FROM graph_edges e JOIN cds_operations o ON o.id=CAST(e.from_id AS INTEGER)
    JOIN cds_services s ON s.id=o.service_id LEFT JOIN cds_operations base ON base.id=o.base_operation_id
    WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND e.status IN ('ambiguous','unresolved') ORDER BY s.service_path,o.operation_name,e.id`).all() as Diagnostic[];
  const grouped = new Map<string, Diagnostic & { count: number; servicePaths: string[]; examples: Diagnostic[] }>();
  for (const row of rows) addImplementationCategory(grouped, row);
  return [...grouped.values()].map(({ servicePaths, ...item }) => ({
    ...item,
    servicePathPattern: pathPattern(servicePaths),
    suggestedAction: categoryAction(String(item.category)),
    suggestedHints: suggestedHints(item.examples),
    examples: item.examples.slice(0, 3),
    expandedExamples: detail ? item.examples : undefined,
  }));
}

function addImplementationCategory(grouped: Map<string, Diagnostic & { count: number; servicePaths: string[]; examples: Diagnostic[] }>, row: Diagnostic): void {
  const evidence = parseObject(row.evidenceJson);
  const category = implementationCategory(row, evidence);
  const family = candidateFamily(evidence);
  const reason = category === 'duplicate_package_name_candidates' ? 'duplicate_package_name_candidates' : String(row.unresolvedReason ?? category);
  const baseOperation = String(row.baseOperation ?? row.operationName ?? evidence.operationName ?? 'unknown');
  const key = [category, baseOperation, reason, family].join('\0');
  const current = grouped.get(key) ?? { category, baseOperation, reason, candidateFamily: family, count: 0, servicePaths: [], examples: [] };
  const hintSuggestions = implementationSuggestions(evidence);
  const candidates = asRecords(evidence.candidates);
  current.count += 1;
  current.servicePaths.push(String(row.servicePath ?? evidence.servicePath ?? ''));
  current.examples.push({
    servicePath: row.servicePath,
    operation: row.operationName,
    status: row.status,
    reason: row.unresolvedReason,
    candidateCount: candidates.length,
    candidateEvidence: candidates.slice(0, 3),
    implementationHintSuggestions: hintSuggestions,
  });
  grouped.set(key, current);
}

function implementationSuggestions(evidence: Diagnostic): Diagnostic[] | undefined {
  const persisted = asRecords(evidence.implementationHintSuggestions);
  const suggestions = persisted.length ? persisted : implementationHintSuggestions(evidence);
  return suggestions.length ? suggestions : undefined;
}

function suggestedHints(examples: Diagnostic[]): string[] | undefined {
  const hints = examples.flatMap((example) =>
    asRecords(example.implementationHintSuggestions)
      .flatMap((suggestion) => typeof suggestion.cli === 'string' ? [String(suggestion.cli)] : []));
  const unique = [...new Set(hints)].slice(0, 3);
  return unique.length ? unique : undefined;
}

function missingParameterMetadataCategory(db: Db, detail = false): Diagnostic & { count: number } {
  const examples = db.prepare(`SELECT sc.source_file sourceFile,sc.source_line sourceLine,sc.callee_expression calleeExpression
    FROM symbol_calls sc JOIN symbols s ON s.id=sc.callee_symbol_id
    WHERE sc.status='resolved' AND json_extract(sc.evidence_json,'$.callArguments[0].kind') IN ('identifier','object_literal')
      AND (s.evidence_json IS NULL OR json_extract(s.evidence_json,'$.parameterBindings') IS NULL)
    ORDER BY sc.source_file,sc.source_line`).all() as Diagnostic[];
  const row = db.prepare(`SELECT COUNT(*) count FROM symbol_calls sc JOIN symbols s ON s.id=sc.callee_symbol_id
    WHERE sc.status='resolved' AND json_extract(sc.evidence_json,'$.callArguments[0].kind') IN ('identifier','object_literal')
      AND (s.evidence_json IS NULL OR json_extract(s.evidence_json,'$.parameterBindings') IS NULL)`).get() as { count?: number };
  return { category: 'missing_parameter_metadata', reason: 'callee symbol is missing parameter binding metadata', candidateFamily: 'symbol_parameter_metadata', count: Number(row.count ?? 0), suggestedAction: categoryAction('missing_parameter_metadata'), examples: examples.slice(0, 3), expandedExamples: detail ? examples : undefined };
}

function dynamicWrapperCategory(db: Db, detail: boolean): Diagnostic & { count: number } {
  const rows = db.prepare(`SELECT source_file sourceFile,source_line sourceLine,
      json_extract(evidence_json,'$.receiver') receiverName,
      COALESCE(json_extract(evidence_json,'$.missingPathIdentifier'),json_extract(evidence_json,'$.operationPathExpression')) pathIdentifier
    FROM outbound_calls WHERE call_type='remote_action' AND unresolved_reason='dynamic_operation_path_identifier'
    ORDER BY source_file,source_line`).all() as Diagnostic[];
  return { category: 'dynamic_wrapper_paths', reason: 'wrapper path cannot be proven statically', candidateFamily: 'wrapper_path', count: rows.length, suggestedAction: categoryAction('dynamic_wrapper_paths'), examples: rows.slice(0, 3), expandedExamples: detail ? rows : undefined };
}

function implementationSummary(categories: Array<Diagnostic & { count: number }>): Diagnostic[] {
  const grouped = new Map<string, Diagnostic & { count: number }>();
  for (const category of categories) {
    const key = [category.category, category.candidateFamily, category.reason].join('\0');
    const current = grouped.get(key) ?? { category: category.category, candidateFamily: category.candidateFamily, reason: category.reason, severity: 'warning', suggestedAction: category.suggestedAction, count: 0 };
    current.count += category.count;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => String(left.category).localeCompare(String(right.category)) || String(left.candidateFamily).localeCompare(String(right.candidateFamily)));
}

function categoryAction(category: string): string {
  if (category === 'duplicate_package_name_candidates') return 'Use scoped --implementation-hint fields to select one repository for each ambiguous hop.';
  if (category === 'missing_strong_ownership_evidence') return 'Add an explicit package dependency, local service-path ownership, or registration ownership evidence.';
  if (category === 'missing_parameter_metadata') return 'Export a statically analyzable helper with named or destructured parameters.';
  if (category === 'dynamic_wrapper_paths') return 'Pass a literal path or provide the reported runtime identifier with --var key=value.';
  return 'Inspect the capped examples and add stronger implementation ownership evidence.';
}

function implementationCategory(row: Diagnostic, evidence: Diagnostic): string {
  const reasons = JSON.stringify([evidence.ambiguityReasons, evidence.candidateFamilies, evidence.candidates, row.unresolvedReason]);
  if (reasons.includes('duplicate_package_name_candidates')) return 'duplicate_package_name_candidates';
  if (reasons.includes('missing direct ownership')) return 'missing_strong_ownership_evidence';
  return String(row.status) === 'ambiguous' ? 'ambiguous_implementation_candidates' : 'rejected_implementation_candidates';
}

function candidateFamily(evidence: Diagnostic): string {
  const families = asRecords(evidence.candidateFamilies);
  const duplicate = families.find((row) => typeof row.packageName === 'string');
  if (duplicate?.packageName) return String(duplicate.packageName);
  const candidates = asRecords(evidence.candidates);
  const first = candidates.find((row) => parseObject(row.handlerPackage).packageName);
  return String(parseObject(first?.handlerPackage).packageName ?? 'unknown');
}

function pathPattern(paths: string[]): string {
  const values = [...new Set(paths.filter(Boolean))].sort();
  if (values.length <= 1) return values[0] ?? '';
  const prefix = commonPrefix(values);
  const suffix = commonSuffix(values.map((value) => value.slice(prefix.length)));
  return `${prefix}*${suffix}`;
}

function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

function commonSuffix(values: string[]): string {
  let suffix = values[0] ?? '';
  for (const value of values.slice(1)) while (!value.endsWith(suffix)) suffix = suffix.slice(1);
  return suffix;
}

function contextualImplementationQuality(db: Db): Diagnostic {
  const rows = db.prepare("SELECT status,COALESCE(unresolved_reason,status) reason,COUNT(*) count FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status IN ('ambiguous','unresolved') GROUP BY status,reason ORDER BY status,count DESC,reason").all() as Diagnostic[];
  const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  return { severity: total > 0 ? 'warning' : 'info', code: 'strict_contextual_implementation_quality', message: 'Implementation hops stopped by ambiguous or unresolved implementation edges', total, breakdown: rows };
}

function classInstanceNoiseQuality(db: Db): Diagnostic {
  const builtIns = ['Set', 'Map', 'WeakSet', 'WeakMap', 'Date', 'RegExp', 'URL', 'URLSearchParams', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Promise', 'AbortController'];
  const placeholders = builtIns.map(() => '?').join(',');
  const aggregate = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) unresolved,
      SUM(CASE WHEN status='unresolved' AND json_extract(evidence_json,'$.className') IN (${placeholders}) THEN 1 ELSE 0 END) unresolvedBuiltIn
    FROM symbol_calls WHERE json_extract(evidence_json,'$.relation')='class_instance_method'`).get(...builtIns) as Diagnostic;
  const byConstructor = db.prepare(`SELECT json_extract(evidence_json,'$.className') constructorName,COUNT(*) unresolvedCount
    FROM symbol_calls WHERE status='unresolved' AND json_extract(evidence_json,'$.relation')='class_instance_method'
    GROUP BY constructorName ORDER BY unresolvedCount DESC,constructorName LIMIT 10`).all() as Diagnostic[];
  return { severity: Number(aggregate.unresolvedBuiltIn ?? 0) > 0 ? 'warning' : 'info', code: 'strict_class_instance_noise_quality', message: 'Class-instance symbol-call aggregate with built-in constructor guard', totalClassInstanceCalls: Number(aggregate.total ?? 0), unresolvedClassInstanceCalls: Number(aggregate.unresolved ?? 0), unresolvedBuiltInClassInstanceCalls: Number(aggregate.unresolvedBuiltIn ?? 0), unresolvedByConstructor: byConstructor };
}

function contextualBindingPropagationQuality(db: Db): Diagnostic {
  const missing = missingParameterMetadataCategory(db);
  const opportunities = db.prepare("SELECT c.source_file sourceFile,c.source_line sourceLine,json_extract(c.evidence_json,'$.receiver') receiverName,c.operation_path_expr operationPath FROM outbound_calls c WHERE c.call_type='remote_action' AND json_extract(c.evidence_json,'$.receiver') IS NOT NULL AND c.service_binding_id IS NULL ORDER BY c.source_file,c.source_line LIMIT 8").all() as Diagnostic[];
  return { severity: missing.count + opportunities.length > 0 ? 'warning' : 'info', code: 'strict_contextual_binding_propagation_quality', message: 'Contextual service-client propagation opportunities for trace-time helper resolution', calleeSymbolsMissingParameterMetadata: missing.count, traceTimeContextualOpportunities: opportunities.length, examples: opportunities };
}

function serviceBindingQuality(db: Db, detail: boolean): Diagnostic {
  const rows = db.prepare(`
    SELECT c.source_file sourceFile,c.source_line sourceLine,
      c.unresolved_reason unresolvedReason,c.evidence_json evidenceJson,
      s.evidence_json symbolEvidenceJson
    FROM outbound_calls c
    LEFT JOIN symbols s ON s.id=c.source_symbol_id
    WHERE c.call_type='remote_action'
      AND c.operation_path_expr IS NOT NULL
      AND c.service_binding_id IS NULL
    ORDER BY c.source_file,c.source_line
  `).all() as Diagnostic[];
  const groups = new Map<string, Diagnostic[]>();
  for (const row of rows) {
    const category = bindingCategory(row);
    groups.set(category, [...(groups.get(category) ?? []), bindingExample(row)]);
  }
  const categories = [...groups.entries()].map(([category, examples]) => ({
    category,
    count: examples.length,
    severity: 'warning',
    suggestedAction: bindingCategoryAction(category),
    examples: examples.slice(0, 3),
    expandedExamples: detail ? examples : undefined,
  }));
  return {
    severity: rows.length > 0 ? 'warning' : 'info',
    code: 'strict_service_binding_quality',
    message: 'Remote service-client binding quality aggregate',
    total: rows.length,
    categories,
  };
}

function bindingCategory(row: Diagnostic): string {
  const evidence = parseObject(row.evidenceJson);
  const resolution = parseObject(evidence.serviceBindingResolution);
  if (resolution.status === 'rejected_future_binding') return 'direct_binding_missing';
  if (resolution.status === 'ambiguous') return 'ambiguous_binding_candidates';
  const receiver = evidence.receiver;
  const symbolEvidence = parseObject(row.symbolEvidenceJson);
  if (symbolHasReceiverParameter(symbolEvidence, receiver))
    return 'contextual_binding_recoverable';
  if (!Array.isArray(symbolEvidence.parameterBindings))
    return 'missing_symbol_parameter_metadata';
  return 'unrecoverable_binding';
}

function symbolHasReceiverParameter(evidence: Diagnostic, receiver: unknown): boolean {
  if (typeof receiver !== 'string' || !Array.isArray(evidence.parameterBindings))
    return false;
  return asRecords(evidence.parameterBindings).some((binding) => {
    if (binding.kind === 'identifier') return binding.name === receiver;
    if (binding.kind === 'object_pattern')
      return asRecords(binding.properties).some((property) => property.local === receiver);
    return asRecords(binding.elements).some((element) => element.local === receiver);
  });
}

function bindingExample(row: Diagnostic): Diagnostic {
  const evidence = parseObject(row.evidenceJson);
  return {
    sourceFile: row.sourceFile,
    sourceLine: row.sourceLine,
    receiver: evidence.receiver,
    unresolvedReason: row.unresolvedReason,
    bindingResolution: evidence.serviceBindingResolution,
  };
}

function bindingCategoryAction(category: string): string {
  if (category === 'direct_binding_missing')
    return 'Move the binding before the call or bind the call to an earlier immutable client.';
  if (category === 'contextual_binding_recoverable')
    return 'Trace from the caller so parameter binding evidence can be applied.';
  if (category === 'ambiguous_binding_candidates')
    return 'Split mutable client alternatives or add a statically unique client assignment.';
  if (category === 'missing_symbol_parameter_metadata')
    return 'Use named or destructured parameters on an indexed helper symbol.';
  return 'Add a direct CAP client binding or statically provable helper-return binding.';
}

function decoratorResolutionQuality(db: Db): Diagnostic {
  const aggregate = db.prepare(`SELECT
      SUM(CASE WHEN json_extract(decorator_resolution_json,'$.resolutionKind')
        IN ('const_identifier','enum_member','const_object_property','generated_constant_name') THEN 1 ELSE 0 END) resolvedFromConstants,
      SUM(CASE WHEN json_extract(decorator_resolution_json,'$.resolutionKind')
        ='unresolved' THEN 1 ELSE 0 END) unresolvedExpressions
    FROM handler_methods`).get() as Diagnostic;
  const unresolved = Number(aggregate.unresolvedExpressions ?? 0);
  const examples = db.prepare(`SELECT hm.method_name methodName,
      hm.decorator_raw_expression rawExpression,
      json_extract(hm.decorator_resolution_json,'$.unresolvedReason') unresolvedReason,
      hm.source_file sourceFile,hm.source_line sourceLine
    FROM handler_methods hm
    WHERE json_extract(hm.decorator_resolution_json,'$.resolutionKind')='unresolved'
    ORDER BY hm.source_file,hm.source_line LIMIT 5`).all() as Diagnostic[];
  return {
    severity: unresolved > 0 ? 'warning' : 'info',
    code: 'strict_decorator_resolution_quality',
    message: 'Handler decorator string-resolution aggregate',
    resolvedFromConstants: Number(aggregate.resolvedFromConstants ?? 0),
    unresolvedExpressions: unresolved,
    unresolvedExamples: examples,
  };
}

function handlerRegistrationPairingQuality(db: Db): Diagnostic {
  const mismatch = db.prepare(`SELECT COUNT(*) count
    FROM handler_registrations hr
    JOIN handler_classes hc ON hc.id=hr.handler_class_id
    WHERE hr.handler_class_id IS NOT NULL
      AND (hc.repo_id<>hr.repo_id OR hc.class_name<>hr.class_name)`).get() as Diagnostic;
  const prevented = db.prepare(`SELECT COUNT(*) count
    FROM handler_registrations hr
    JOIN handler_classes exactClass ON exactClass.id=hr.handler_class_id
    JOIN handler_classes otherClass ON otherClass.class_name=hr.class_name
      AND otherClass.repo_id<>hr.repo_id
    WHERE hr.handler_class_id IS NOT NULL AND hr.import_source IS NOT NULL`).get() as Diagnostic;
  const mismatched = Number(mismatch.count ?? 0);
  return {
    severity: mismatched > 0 ? 'error' : 'info',
    code: 'strict_handler_registration_pairing_quality',
    message: 'Handler registration and class ownership aggregate',
    mismatchedExactRegistrations: mismatched,
    preventedSyntheticCrossRepositoryPairs: Number(prevented.count ?? 0),
  };
}

function wrapperPathPropagationQuality(db: Db): Diagnostic {
  const examples = db.prepare("SELECT source_file sourceFile,source_line sourceLine,json_extract(evidence_json,'$.receiver') receiverName,json_extract(evidence_json,'$.operationPathExpression') pathIdentifier FROM outbound_calls WHERE call_type='remote_action' AND unresolved_reason='dynamic_operation_path_identifier' ORDER BY source_file,source_line LIMIT 5").all() as Diagnostic[];
  return { severity: examples.length > 0 ? 'warning' : 'info', code: 'strict_wrapper_path_propagation_quality', message: 'Dynamic path sends where send({ path }) used a path identifier', dynamicPathIdentifierCalls: examples.length, examples };
}

function nestedThisReceiverQuality(db: Db): Diagnostic {
  const aggregate = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN json_extract(evidence_json,'$.relation')='indexed_this_method' THEN 1 ELSE 0 END) resolvedToCurrentClass,
      SUM(CASE WHEN json_extract(evidence_json,'$.relation')='class_instance_method' THEN 1 ELSE 0 END) withExplicitHelperInstanceEvidence
    FROM symbol_calls WHERE callee_expression LIKE 'this.%.%'`).get() as Diagnostic;
  const examples = db.prepare(`SELECT source_file sourceFile,source_line sourceLine,callee_expression calleeExpression,json_extract(evidence_json,'$.relation') relation,json_extract(evidence_json,'$.targetName') targetName
    FROM symbol_calls WHERE callee_expression LIKE 'this.%.%' AND json_extract(evidence_json,'$.relation')='indexed_this_method'
    ORDER BY source_file,source_line LIMIT 8`).all() as Diagnostic[];
  return { severity: Number(aggregate.resolvedToCurrentClass ?? 0) > 0 ? 'warning' : 'info', code: 'strict_nested_this_receiver_quality', message: 'Nested this receiver symbol-call aggregate', nestedThisReceiverCallsConsidered: Number(aggregate.total ?? 0), nestedThisResolvedToCurrentClass: Number(aggregate.resolvedToCurrentClass ?? 0), nestedThisWithExplicitHelperInstanceEvidence: Number(aggregate.withExplicitHelperInstanceEvidence ?? 0), warningExamples: examples };
}

function remoteQueryTargetQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN e.edge_type='HANDLER_RUNS_REMOTE_QUERY' AND e.status='terminal' THEN 1 ELSE 0 END) terminal,SUM(CASE WHEN e.edge_type='HANDLER_RUNS_REMOTE_QUERY' AND e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,SUM(CASE WHEN e.edge_type='UNRESOLVED_EDGE' OR e.status='unresolved' THEN 1 ELSE 0 END) unresolved FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_query'").get() as Diagnostic;
  const numeric = Number(row.numericTargets ?? 0);
  const unresolved = Number(row.unresolved ?? 0);
  return { severity: numeric + unresolved > 0 ? 'warning' : 'info', code: 'strict_remote_query_target_quality', message: 'Remote query terminal target quality aggregate', totalRemoteQueryCalls: Number(row.total ?? 0), terminalRemoteQueryEdges: Number(row.terminal ?? 0), numericTargetCount: numeric, unresolvedRemoteQueryCount: unresolved };
}

function remoteEntityOperationCollisionQuality(db: Db): Diagnostic {
  const rows = db.prepare(`SELECT c.id callId,c.source_file sourceFile,c.source_line sourceLine,c.method method,c.operation_path_expr rawPath,c.query_entity entitySegment,e.to_id selectedTerminalEntityTarget,e.evidence_json evidenceJson
    FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type LIKE 'remote_entity_%' AND e.edge_type='HANDLER_ACCESSES_REMOTE_ENTITY' AND e.status='terminal'
    ORDER BY c.source_file,c.source_line LIMIT 100`).all() as Diagnostic[];
  const examples = rows.map((row) => operationCollisionExample(db, row)).filter((row): row is Diagnostic => Boolean(row)).slice(0, 10);
  return { severity: examples.length > 0 ? 'warning' : 'info', code: 'strict_remote_entity_operation_collision_quality', message: 'Terminal remote entity edges that look like indexed operation invocations', collisionCount: examples.length, examples };
}

function operationCollisionExample(db: Db, row: Diagnostic): Diagnostic | undefined {
  const rawPath = String(row.rawPath ?? '');
  const normalized = normalizeODataOperationInvocationPath(rawPath);
  const candidatePath = normalized?.wasInvocation ? normalized.normalizedOperationPath : rawPath;
  const name = candidatePath.replace(/^\//, '');
  const simple = name.split('.').at(-1) ?? name;
  const candidates = db.prepare('SELECT COUNT(*) count FROM cds_operations WHERE operation_path IN (?,?) OR operation_name IN (?,?)').get(candidatePath, `/${simple}`, name, simple) as { count?: number };
  const candidateCount = Number(candidates.count ?? 0);
  if (!normalized?.wasInvocation && candidateCount === 0) return undefined;
  const evidence = parseObject(row.evidenceJson);
  return { callId: row.callId, sourceFile: row.sourceFile, sourceLine: row.sourceLine, method: row.method, rawPath, normalizedOperationPath: normalized?.wasInvocation ? normalized.normalizedOperationPath : candidatePath, entitySegment: row.entitySegment, operationCandidateCount: candidateCount, selectedTerminalEntityTarget: row.selectedTerminalEntityTarget, classifierReason: parseObject(evidence.odataPathIntent).reason };
}

function remoteEntityDynamicOperationFalsePositiveQuality(db: Db): Diagnostic {
  const rows = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,c.method method,c.operation_path_expr rawPath,e.id graphEdgeId,e.unresolved_reason unresolvedReason,e.evidence_json evidenceJson
    FROM outbound_calls c JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type LIKE 'remote_entity_%' AND e.status IN ('dynamic','unresolved') AND e.to_kind='operation_candidate'
    ORDER BY c.source_file,c.source_line LIMIT 100`).all() as Diagnostic[];
  const examples = rows.filter(isRemoteEntityFalsePositive).map((row) => falsePositiveExample(row)).slice(0, 10);
  return { severity: examples.length > 0 ? 'warning' : 'info', code: 'strict_remote_entity_dynamic_operation_false_positive_quality', message: 'Parser-classified entity paths linked as dynamic operation candidates without indexed operation evidence', falsePositiveCount: examples.length, examples };
}

function isRemoteEntityFalsePositive(row: Diagnostic): boolean {
  const intent = classifyODataPathIntent(String(row.rawPath ?? ''), String(row.method ?? 'GET'));
  const entityIntent = ['entity_key_read', 'entity_navigation_query', 'entity_media'].includes(intent.kind) || (intent.kind === 'entity_mutation' && (intent.hasEntityKeyPredicate || intent.hasNavigationSuffix));
  const evidence = parseObject(row.evidenceJson);
  const candidateCount = Number(evidence.indexedOperationCandidateCount ?? evidence.candidateCount ?? 0);
  const reason = String(row.unresolvedReason ?? '');
  return entityIntent && candidateCount === 0 && (intent.keyPredicatePlaceholderKeys.length > 0 || reason.includes('runtime variable') || reason.includes('placeholder'));
}

function falsePositiveExample(row: Diagnostic): Diagnostic {
  const intent = classifyODataPathIntent(String(row.rawPath ?? ''), String(row.method ?? 'GET'));
  return { sourceFile: row.sourceFile, sourceLine: row.sourceLine, rawPath: row.rawPath, method: row.method, pathIntent: intent.kind, keyPlaceholderKeys: intent.keyPredicatePlaceholderKeys, navigationOrMediaSuffix: intent.navigationSuffix ?? intent.mediaOrPropertySuffix, graphEdgeId: row.graphEdgeId, operationCandidateCount: 0, recommendedRemediation: 'Reindex and relink with service-flow 0.1.35 or newer so entity key placeholders remain entity-addressing evidence.' };
}

function remoteActionTargetQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN e.status='unresolved' THEN 1 ELSE 0 END) unresolved,SUM(CASE WHEN e.status='unresolved' AND e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,SUM(CASE WHEN e.status='unresolved' AND (e.to_id='Remote action: unknown path' OR e.to_id='Remote action: dynamic path') THEN 1 ELSE 0 END) semanticTargets FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_action'").get() as Diagnostic;
  const numeric = Number(row.numericTargets ?? 0);
  return { severity: numeric > 0 ? 'warning' : 'info', code: 'strict_remote_action_target_quality', message: 'Remote action unresolved target quality aggregate', totalRemoteActionCalls: Number(row.total ?? 0), unresolvedRemoteActionCalls: Number(row.unresolved ?? 0), numericUnresolvedTargetCount: numeric, semanticUnknownOrDynamicTargetCount: Number(row.semanticTargets ?? 0) };
}

function externalHttpTargetQuality(db: Db): Diagnostic {
  const row = db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN e.to_id GLOB '[0-9]*' THEN 1 ELSE 0 END) numericTargets,SUM(CASE WHEN e.evidence_json IS NULL OR json_valid(e.evidence_json)=0 OR json_extract(e.evidence_json,'$.externalTarget.kind') IS NULL THEN 1 ELSE 0 END) invalidEvidence FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='external_http'").get() as Diagnostic;
  const bad = Number(row.numericTargets ?? 0) + Number(row.invalidEvidence ?? 0);
  return { severity: bad > 0 ? 'warning' : 'info', code: 'strict_external_http_target_quality', message: 'External HTTP semantic target aggregate', totalExternalHttpCalls: Number(row.total ?? 0), numericTargetCount: Number(row.numericTargets ?? 0), invalidOrMissingExternalTargetEvidence: Number(row.invalidEvidence ?? 0) };
}

function odataInvocationResolutionQuality(db: Db): Diagnostic {
  const rows = db.prepare(`SELECT c.operation_path_expr operationPathExpr,
    c.source_file sourceFile,c.source_line sourceLine,e.id graphEdgeId,
    e.status status,e.evidence_json evidenceJson
    FROM outbound_calls c JOIN graph_edges e
      ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
    WHERE c.call_type='remote_action' AND c.operation_path_expr LIKE '%(%'
    ORDER BY c.source_file,c.source_line`).all() as Array<{
      operationPathExpr?: string;
      sourceFile?: string;
      sourceLine?: number;
      graphEdgeId?: number;
      status?: string;
      evidenceJson?: string;
    }>;
  const unresolved = rows.filter((row) => row.status === 'unresolved' && normalizeODataOperationInvocationPath(row.operationPathExpr)?.wasInvocation).length;
  const ambiguous = rows.filter((row) => row.status === 'ambiguous' && normalizeODataOperationInvocationPath(row.operationPathExpr)?.wasInvocation).length;
  const examples = rows
    .filter((row) => row.status === 'ambiguous' || row.status === 'unresolved')
    .map(odataInvocationExample)
    .slice(0, 5);
  return { severity: unresolved + ambiguous > 0 ? 'warning' : 'info', code: 'strict_odata_invocation_resolution_quality', message: 'OData invocation-path resolution quality aggregate', totalInvocationRemoteActions: rows.length, resolvedInvocationCalls: rows.filter((row) => row.status === 'resolved').length, dynamicInvocationCalls: rows.filter((row) => row.status === 'dynamic').length, ambiguousInvocationCalls: rows.filter((row) => row.status === 'ambiguous').length, unresolvedInvocationCalls: rows.filter((row) => row.status === 'unresolved').length, ambiguousNormalizedCalls: ambiguous, unresolvedNormalizedCallsWithIndexedCandidates: unresolved, examples };
}

function odataInvocationExample(row: {
  operationPathExpr?: string;
  sourceFile?: string;
  sourceLine?: number;
  graphEdgeId?: number;
  status?: string;
  evidenceJson?: string;
}): Diagnostic {
  const evidence = parseObject(row.evidenceJson);
  const normalized = normalizeODataOperationInvocationPath(row.operationPathExpr);
  return {
    sourceFile: row.sourceFile,
    sourceLine: row.sourceLine,
    graphEdgeId: row.graphEdgeId,
    status: row.status,
    rawPath: row.operationPathExpr,
    normalizedOperationPath: normalized?.wasInvocation
      ? normalized.normalizedOperationPath
      : undefined,
    indexedOperationCandidateCount: evidence.indexedOperationCandidateCount,
    candidateScores: evidence.candidateScores,
    entityOperationPrecedence: evidence.entityOperationPrecedence,
    resolutionReasons: evidence.resolutionReasons,
  };
}

function identityAliasBindingQuality(db: Db): Diagnostic {
  const examples = db.prepare("SELECT c.source_file sourceFile,c.source_line sourceLine FROM outbound_calls c WHERE c.call_type='remote_action' AND c.service_binding_id IS NULL AND json_extract(c.evidence_json,'$.receiver') IS NOT NULL ORDER BY c.source_file,c.source_line LIMIT 5").all() as Diagnostic[];
  return { severity: examples.length > 0 ? 'warning' : 'info', code: 'strict_identity_alias_binding_quality', message: 'Remote sends that look like missed same-file identity aliases', missedAliasBindingCalls: examples.length, examples };
}

function remoteActionNoBindingQuality(db: Db): Diagnostic {
  const rows = db.prepare("SELECT COALESCE(e.status,'missing_edge') status,COUNT(*) count FROM outbound_calls c LEFT JOIN graph_edges e ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT) WHERE c.call_type='remote_action' AND c.operation_path_expr IS NOT NULL AND c.service_binding_id IS NULL GROUP BY status ORDER BY count DESC,status").all() as Diagnostic[];
  const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  return { severity: total > 0 ? 'warning' : 'info', code: 'strict_remote_action_no_binding_quality', message: 'Remote actions with operation paths but no service binding id', total, breakdown: rows };
}

function candidateCount(value: unknown): number {
  return Number(parseObject(value).candidateCount ?? 0);
}

function parseObject(value: unknown): Diagnostic {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Diagnostic;
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Diagnostic : {};
  } catch {
    return {};
  }
}

function asRecords(value: unknown): Diagnostic[] {
  return Array.isArray(value) ? value.filter((item): item is Diagnostic => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}
