import type { Db } from '../db/connection.js';
import { extractPlaceholders } from '../linker/dynamic-edge-resolver.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import { resolveOperation } from '../linker/service-resolver.js';
import type { TraceEdge, TraceResult, TraceStart } from '../types.js';
import { baseTraceEvidence, edgeTarget, runtimeResolution, runtimeVariableDiagnostic, type TraceGraphRow } from './evidence.js';

interface RepoRef {
  id: number;
  name: string;
}
interface StartScope {
  repo?: RepoRef;
  sourceFiles?: Set<string>;
  symbolIds?: Set<number>;
  selectorMatched: boolean;
  startOperationId?: string;
  startDiagnostics?: Array<Record<string, unknown>>;
}
interface CallRow extends Record<string, unknown> {
  id: number;
  repo_id: number;
  repoName: string;
  source_file: string;
  source_line: number;
  call_type: string;
  confidence: number;
  source_symbol_id?: number;
}
interface GraphRow extends Record<string, unknown> {
  id: number;
  edge_type: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  confidence: number;
  evidence_json: string;
  unresolved_reason?: string;
  status?: string;
}
interface ContextBinding {
  bindingId: number;
  alias?: string;
  aliasExpr?: string;
  destinationExpr?: string;
  servicePathExpr?: string;
  requireServicePath?: string;
  requireDestination?: string;
  effectiveServicePath?: string;
  effectiveDestination?: string;
  sourceFile?: string;
  sourceLine?: number;
  source: string;
  callerArgument?: string;
  callerProperty?: string;
  calleeParameter?: string;
  calleeObjectProperty?: string;
  calleeLocalDestructuredIdentifier?: string;
  parameterPropertyAliasKind?: unknown;
  parameterPropertyAliasLine?: unknown;
  calleeReceiver: string;
}
interface ImplementationSelection {
  methodId?: string;
  evidence: Record<string, unknown>;
}
function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}
function positiveDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
}

function operationStartScope(db: Db, repoId: number | undefined, start: TraceStart, implementationRepo?: string): { files?: Set<string>; symbols?: Set<number>; operationId?: string; diagnostics?: Array<Record<string, unknown>> } | undefined {
  const requested = normalizeOperation(start.operationPath ?? start.operation);
  if (!requested) return undefined;
  const rows = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_path operationPath,s.service_path servicePath,r.id repoId,r.name repoName
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
    WHERE (? IS NULL OR r.id=?) AND (? IS NULL OR s.service_path=?) AND (o.operation_name=? OR o.operation_path=? OR o.operation_path=?)
    ORDER BY r.name,s.service_path,o.operation_name,o.id`).all(repoId, repoId, start.servicePath, start.servicePath, requested, requested, requested.startsWith('/') ? requested : `/${requested}`) as Array<Record<string, unknown>>;
  if (rows.length === 0) return undefined;
  const repoCount = new Set(rows.map((row) => String(row.repoName))).size;
  const serviceCount = new Set(rows.map((row) => `${String(row.repoName)}:${String(row.servicePath)}`)).size;
  if (!repoId && repoCount > 1) return { diagnostics: [{ severity: 'warning', code: 'trace_start_ambiguous', message: 'Operation trace start matched multiple repositories; add --repo to disambiguate', normalizedSelectorValue: requested, resolutionStage: 'operation', resolutionStatus: 'ambiguous_operation', candidates: rows }] };
  if (!start.servicePath && serviceCount > 1) return { diagnostics: [{ severity: 'warning', code: 'trace_start_ambiguous', message: 'Operation trace start matched multiple services; add --service to disambiguate', normalizedSelectorValue: requested, resolutionStage: 'operation', resolutionStatus: 'ambiguous_operation', candidates: rows }] };
  if (rows.length !== 1) return { diagnostics: [{ severity: 'warning', code: 'trace_start_ambiguous', message: 'Operation trace start matched multiple indexed operations', normalizedSelectorValue: requested, resolutionStage: 'operation', resolutionStatus: 'ambiguous_operation', candidates: rows }] };
  const operationId = String(rows[0]?.operationId);
  const impl = implementationScope(db, operationId);
  if (impl.edge?.status === 'resolved' && impl.files.size > 0) return { files: impl.files, symbols: impl.symbolId ? new Set([impl.symbolId]) : undefined, operationId, diagnostics: [] };
  const hinted = implementationMethodIdFromHint(impl.edge, implementationRepo);
  if (hinted.methodId) {
    const hintedScope = handlerScope(db, hinted.methodId);
    if (hintedScope?.files.size) return { files: hintedScope.files, symbols: hintedScope.symbolId ? new Set([hintedScope.symbolId]) : undefined, operationId, diagnostics: [] };
  }
  if (impl.edge) {
    const evidence = parseEvidence(impl.edge.evidence_json);
    return { operationId, diagnostics: [{ severity: 'warning', code: impl.edge.status === 'ambiguous' ? 'trace_start_ambiguous' : 'trace_start_implementation_unresolved', message: `Indexed operation matched but implementation edge is ${String(impl.edge.status ?? 'unresolved')}`, resolutionStage: 'implementation', resolutionStatus: impl.edge.status === 'ambiguous' ? 'ambiguous_implementation' : 'rejected_implementation', implementationEdgeId: impl.edge.id, implementationStatus: impl.edge.status, implementationAmbiguityReasons: evidence.ambiguityReasons, candidates: evidence.candidates }] };
  }
  return { operationId, diagnostics: [{ severity: 'warning', code: 'trace_start_implementation_unresolved', message: 'Indexed operation matched but no implementation candidate exists', resolutionStage: 'implementation', resolutionStatus: 'operation_without_implementation' }] };
}

function sourceFilesForStart(
  db: Db,
  repoId: number | undefined,
  start: TraceStart,
): { files?: Set<string>; symbols?: Set<number> } | undefined {
  const handler = start.handler;
  const operation = normalizeOperation(start.operation ?? start.operationPath);
  if (!handler && !operation) return undefined;
  const rows = db
    .prepare(
      `SELECT DISTINCT hc.source_file sourceFile,s.id symbolId
       FROM handler_classes hc LEFT JOIN handler_methods hm ON hm.handler_class_id=hc.id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name
       WHERE (? IS NULL OR hc.repo_id=?) AND (? IS NULL OR hc.class_name=? OR hm.method_name=?)
         AND (? IS NULL OR hm.decorator_value=? OR hm.method_name=?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM cds_services s JOIN cds_operations o ON o.service_id=s.id WHERE s.repo_id=hc.repo_id AND s.service_path=? AND (? IS NULL OR o.operation_path=? OR o.operation_name=? OR hm.decorator_value=? OR hm.method_name=?)))`,
    )
    .all(
      repoId,
      repoId,
      handler,
      handler,
      handler,
      operation,
      operation,
      operation,
      start.servicePath,
      start.servicePath,
      operation,
      operation,
      operation,
      operation,
      operation,
    ) as Array<{ sourceFile?: string; symbolId?: number }>;
  if (rows.length > 0) return { files: new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]), symbols: new Set(rows.map((row) => Number(row.symbolId)).filter(Boolean)) };
  if (start.servicePath && operation) {
    const implRows = db.prepare(`SELECT DISTINCT hc.source_file sourceFile,sym.id symbolId
      FROM cds_services s JOIN cds_operations o ON o.service_id=s.id
      JOIN graph_edges e ON e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND e.status='resolved' AND e.from_kind='operation' AND e.from_id=CAST(o.id AS TEXT)
      JOIN handler_methods hm ON hm.id=CAST(e.to_id AS INTEGER)
      JOIN handler_classes hc ON hc.id=hm.handler_class_id
      LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id AND sym.source_file=hc.source_file AND sym.name=hm.method_name
      WHERE (? IS NULL OR s.repo_id=?) AND s.service_path=? AND (o.operation_path=? OR o.operation_name=?)`).all(repoId, repoId, start.servicePath, operation, operation) as Array<{ sourceFile?: string; symbolId?: number }>;
    if (implRows.length > 0) return { files: new Set(implRows.map((row) => row.sourceFile).filter(Boolean) as string[]), symbols: new Set(implRows.map((row) => Number(row.symbolId)).filter(Boolean)) };
  }
  return undefined;
}
function startScope(db: Db, start: TraceStart, implementationRepo?: string): StartScope {
  const repo = start.repo
    ? (db
        .prepare(
          'SELECT id,name FROM repositories WHERE name=? OR package_name=?',
        )
        .get(start.repo, start.repo) as RepoRef | undefined)
    : undefined;
  if (start.repo && !repo) return { repo, selectorMatched: false };
  const operationScope = operationStartScope(db, repo?.id, start, implementationRepo);
  const terminalOperationScope = operationScope && !operationScope.files && (operationScope.diagnostics ?? []).some((d) => d.resolutionStage === 'operation' || d.resolutionStage === 'implementation');
  const sourceScope = operationScope?.files || terminalOperationScope ? operationScope : sourceFilesForStart(db, repo?.id, start);
  const sourceFiles = sourceScope?.files;
  const hasSelector = Boolean(
    start.handler ?? start.operation ?? start.operationPath ?? start.servicePath,
  );
  if (start.servicePath && !start.operation && !start.operationPath && !start.handler)
    return { repo, selectorMatched: false };
  return {
    repo,
    sourceFiles,
    symbolIds: sourceScope?.symbols,
    selectorMatched: !terminalOperationScope && (!hasSelector || sourceFiles !== undefined),
    startOperationId: operationScope?.operationId,
    startDiagnostics: operationScope?.diagnostics,
  };
}
function handlerFilesForOperation(db: Db, operationId: string): Set<string> {
  const op = db
    .prepare(
      `SELECT o.operation_name operationName,o.operation_path operationPath,s.repo_id repoId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?`,
    )
    .get(operationId) as
    | { operationName?: string; operationPath?: string; repoId?: number }
    | undefined;
  if (!op) return new Set();
  const operation = normalizeOperation(op.operationPath ?? op.operationName);
  const rows = db
    .prepare(
      `SELECT DISTINCT hc.source_file sourceFile,sym.id symbolId FROM handler_classes hc
    JOIN handler_methods hm ON hm.handler_class_id=hc.id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id AND sym.source_file=hc.source_file AND sym.name=hm.method_name
    WHERE hc.repo_id=? AND (hm.decorator_value=? OR hm.method_name=? OR hm.decorator_value=?)`,
    )
    .all(op.repoId, operation, operation, op.operationName) as Array<{
    sourceFile?: string;
  }>;
  return new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]);
}

function implementationEdge(db: Db, operationId: string): GraphRow | undefined {
  return db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND from_kind='operation' AND from_id=? ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,id LIMIT 1").get(operationId) as GraphRow | undefined;
}
function handlerMethodNode(db: Db, methodId: string): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT hm.id methodId,hm.method_name methodName,hm.decorator_value decoratorValue,hm.source_line sourceLine,hc.class_name className,hc.source_file sourceFile,r.name repoName,r.id repoId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id JOIN repositories r ON r.id=hc.repo_id WHERE hm.id=?`).get(methodId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id: `handler_method:${methodId}`, kind: 'handler_method', label: `${String(row.repoName)}:${String(row.className)}.${String(row.methodName)}`, ...row };
}
function implementationScope(db: Db, operationId: string): { repoId?: number; files: Set<string>; symbolId?: number; edge?: GraphRow } {
  const edge = implementationEdge(db, operationId);
  if (!edge || edge.status !== 'resolved') return { files: new Set(), edge };
  const row = db.prepare('SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name WHERE hm.id=?').get(edge.to_id) as { repoId?: number; sourceFile?: string; symbolId?: number } | undefined;
  return { repoId: row?.repoId, files: new Set(row?.sourceFile ? [row.sourceFile] : []), symbolId: row?.symbolId, edge };
}
function implementationMethodIdFromHint(edge: GraphRow | undefined, implementationRepo: string | undefined): ImplementationSelection {
  if (!edge || edge.status !== 'ambiguous' || !implementationRepo) return { evidence: { status: 'not_applicable' } };
  const evidence = parseEvidence(edge.evidence_json) as { ambiguityReasons?: string[]; candidates?: Array<{ accepted?: boolean; methodId?: number; handlerPackage?: { name?: string; packageName?: string }; sourceFile?: string }> };
  const matches = (evidence.candidates ?? []).filter((item) => item.accepted && (
    item.handlerPackage?.name === implementationRepo ||
    item.handlerPackage?.packageName === implementationRepo ||
    item.sourceFile?.startsWith(implementationRepo)
  ));
  if (matches.length !== 1 || matches[0]?.methodId === undefined) return { evidence: { status: matches.length > 1 ? 'tied' : 'not_matched', strategy: 'implementation_repo_hint', selectedRepo: implementationRepo, candidateCount: matches.length } };
  return {
    methodId: String(matches[0].methodId),
    evidence: {
      status: 'selected',
      guided: true,
      strategy: 'implementation_repo_hint',
      selectedRepo: implementationRepo,
      selectedMethodId: matches[0].methodId,
      ambiguityReason: evidence.ambiguityReasons?.[0],
    },
  };
}

function contextImplementationMethodId(edge: GraphRow | undefined, callerRepoId: number | undefined, remoteEvidence: Record<string, unknown> = {}, implementationRepo?: string): ImplementationSelection {
  const hinted = implementationMethodIdFromHint(edge, implementationRepo);
  if (hinted.methodId) return hinted;
  if (!edge || edge.status !== 'ambiguous' || callerRepoId === undefined) return { evidence: { status: 'not_applicable' } };
  const evidence = JSON.parse(String(edge.evidence_json || '{}')) as { candidates?: Array<{ accepted?: boolean; methodId?: number; handlerPackage?: { id?: number; name?: string }; applicationPackage?: { id?: number; name?: string }; reasons?: string[]; score?: number }> };
  const scores = (evidence.candidates ?? []).filter((item) => item.accepted).map((item) => {
    const reasons: string[] = [];
    let score = Number(item.score ?? 0);
    if (Number(item.handlerPackage?.id) === callerRepoId) { score += 10; reasons.push('handler_package_matches_caller_repository'); }
    if (Number(item.applicationPackage?.id) === callerRepoId) { score += 10; reasons.push('registration_package_matches_caller_repository'); }
    if (typeof remoteEvidence.effectiveServicePath === 'string' || typeof remoteEvidence.effectiveDestination === 'string' || typeof remoteEvidence.effectiveAlias === 'string') { score += 1; reasons.push('remote_call_context_available'); }
    return { methodId: item.methodId, score, reasons, handlerPackage: item.handlerPackage, applicationPackage: item.applicationPackage };
  }).sort((a, b) => b.score - a.score);
  if (scores.length === 0) return { evidence: { status: 'not_applicable', candidateScores: [] } };
  const [first, second] = scores;
  if (first && first.methodId !== undefined && first.score > 0 && (!second || first.score > second.score)) return { methodId: String(first.methodId), evidence: { status: 'selected', selectedMethodId: first.methodId, candidateScores: scores } };
  return { evidence: { status: 'tied', tieReason: scores.length > 1 ? 'duplicate_helper_implementation_candidates' : 'no_unique_materially_stronger_candidate', candidateScores: scores } };
}
function handlerScope(db: Db, methodId: string): { repoId?: number; files: Set<string>; symbolId?: number } | undefined {
  const row = db.prepare('SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.name=hm.method_name WHERE hm.id=?').get(methodId) as { repoId?: number; sourceFile?: string; symbolId?: number } | undefined;
  if (!row) return undefined;
  return { repoId: row.repoId, files: new Set(row.sourceFile ? [row.sourceFile] : []), symbolId: row.symbolId };
}


function traceEdgeType(call: CallRow, row: GraphRow): string {
  if (row.to_kind === 'operation' && row.edge_type === 'REMOTE_CALL_RESOLVES_TO_OPERATION') return 'remote_action';
  if (row.to_kind === 'operation' && row.edge_type === 'LOCAL_CALL_RESOLVES_TO_OPERATION') return 'local_service_call';
  return String(call.call_type);
}

function includeCall(
  type: string,
  options: {
    includeExternal?: boolean;
    includeDb?: boolean;
    includeAsync?: boolean;
  },
): boolean {
  if (!options.includeDb && type === 'local_db_query') return false;
  if (!options.includeExternal && type === 'external_http') return false;
  if (!options.includeAsync && type.startsWith('async_')) return false;
  return true;
}
function graphForCalls(db: Db, callIds: number[]): Map<number, GraphRow[]> {
  const map = new Map<number, GraphRow[]>();
  if (callIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT * FROM graph_edges WHERE from_kind='call' AND from_id IN (${callIds.map(() => '?').join(',')}) ORDER BY id`,
    )
    .all(...callIds.map((id) => String(id))) as GraphRow[];
  for (const row of rows) {
    const id = Number(row.from_id);
    map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}
function symbolNode(db: Db, symbolId: number): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT s.id symbolId,s.name symbolName,s.qualified_name qualifiedName,s.source_file sourceFile,s.start_line startLine,s.end_line endLine,r.name repoName,r.id repoId FROM symbols s JOIN repositories r ON r.id=s.repo_id WHERE s.id=?`).get(symbolId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const fileName = String(row.sourceFile ?? '').split('/').at(-1) ?? String(row.sourceFile ?? '');
  return { id: `symbol:${symbolId}`, kind: 'symbol', label: `${fileName}:${String(row.qualifiedName ?? row.symbolName)}`, ...row };
}

function operationNode(db: Db, operationId: string): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_type operationType,o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,s.id serviceId,s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,r.id repoId,r.name repoName FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operationId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id: `operation:${operationId}`, kind: 'operation', label: `${String(row.repoName)}:${String(row.servicePath)}${String(row.operationPath)}`, ...row };
}
function workspaceIdForCall(db: Db, callId: string): number | undefined {
  return (db.prepare('SELECT r.workspace_id workspaceId FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE c.id=?').get(callId) as { workspaceId?: number } | undefined)?.workspaceId;
}
function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
function receiverFromEvidence(value: unknown): string | undefined {
  const evidence = parseEvidence(value);
  return typeof evidence.receiver === 'string' ? evidence.receiver : undefined;
}
function hasDynamicPlaceholder(value: string | undefined): boolean {
  return extractPlaceholders(value).length > 0;
}
function enrichBinding(row: ContextBinding): ContextBinding {
  const effectiveServicePath = row.servicePathExpr && !hasDynamicPlaceholder(row.servicePathExpr) ? row.servicePathExpr : !row.servicePathExpr ? row.requireServicePath : undefined;
  const effectiveDestination = row.destinationExpr && !hasDynamicPlaceholder(row.destinationExpr) ? row.destinationExpr : !row.destinationExpr ? row.requireDestination : undefined;
  return { ...row, effectiveServicePath, effectiveDestination };
}
function knownBindingsForCalls(db: Db, calls: CallRow[]): Map<string, ContextBinding> {
  const map = new Map<string, ContextBinding>();
  for (const call of calls) {
    const receiver = receiverFromEvidence(call.evidence_json);
    const bindingId = Number(call.service_binding_id ?? 0);
    if (!receiver || !bindingId) continue;
    const row = db.prepare(`SELECT b.id,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.source_file sourceFile,b.source_line sourceLine,req.service_path requireServicePath,req.destination requireDestination
      FROM service_bindings b LEFT JOIN cds_requires req ON req.repo_id=b.repo_id AND req.alias=b.alias
      WHERE b.id=?`).get(bindingId) as ContextBinding | undefined;
    if (row) map.set(receiver, enrichBinding({ ...row, bindingId, source: 'local_service_binding', calleeReceiver: receiver }));
  }
  return map;
}
function knownBindingsForScope(db: Db, repoId: number | undefined, symbolIds: Set<number> | undefined, files: Set<string> | undefined): Map<string, ContextBinding> {
  const map = new Map<string, ContextBinding>();
  if (repoId === undefined) return map;
  type BindingRow = Omit<ContextBinding, 'bindingId' | 'source' | 'calleeReceiver'> & { id?: number; variableName?: string };
  const rows = db.prepare(`SELECT b.id,b.variable_name variableName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.source_file sourceFile,b.source_line sourceLine,req.service_path requireServicePath,req.destination requireDestination
    FROM service_bindings b LEFT JOIN cds_requires req ON req.repo_id=b.repo_id AND req.alias=b.alias
    WHERE b.repo_id=?`).all(repoId) as BindingRow[];
  for (const row of rows) {
    if (!row.variableName) continue;
    if (files && !files.has(String(row.sourceFile))) continue;
    if (symbolIds && symbolIds.size > 0) {
      const owner = db.prepare('SELECT id FROM symbols WHERE id IN (' + [...symbolIds].map(() => '?').join(',') + ') AND source_file=? AND start_line<=? AND end_line>=? LIMIT 1').get(...symbolIds, row.sourceFile, row.sourceLine, row.sourceLine) as { id?: number } | undefined;
      if (!owner) continue;
    }
    map.set(row.variableName, enrichBinding({ ...row, bindingId: Number(row.id), source: 'local_service_binding', calleeReceiver: row.variableName }));
  }
  return map;
}
function contextForSymbolCall(db: Db, symbolCall: Record<string, unknown>, callerBindings: Map<string, ContextBinding>): Map<string, ContextBinding> {
  const next = new Map<string, ContextBinding>();
  if (callerBindings.size === 0) return next;
  const callEvidence = parseEvidence(symbolCall.evidence_json);
  const callee = db.prepare('SELECT evidence_json evidenceJson FROM symbols WHERE id=?').get(symbolCall.callee_symbol_id) as { evidenceJson?: string } | undefined;
  const calleeEvidence = parseEvidence(callee?.evidenceJson);
  const params = Array.isArray(calleeEvidence.parameters) ? calleeEvidence.parameters.filter((item): item is string => typeof item === 'string') : [];
  const parameterBindings = Array.isArray(calleeEvidence.parameterBindings) ? calleeEvidence.parameterBindings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
  const parameterPropertyAliases = Array.isArray(calleeEvidence.parameterPropertyAliases) ? calleeEvidence.parameterPropertyAliases.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
  const args = Array.isArray(callEvidence.callArguments) ? callEvidence.callArguments as Array<Record<string, unknown>> : [];
  args.forEach((arg, index) => {
    const paramBinding = parameterBindings.find((binding) => binding.index === index);
    const param = paramBinding?.kind === 'identifier' && typeof paramBinding.name === 'string' ? paramBinding.name : params[index];
    if (arg.kind === 'identifier' && typeof arg.name === 'string') {
      const binding = callerBindings.get(arg.name);
      if (binding && param) next.set(param, { ...binding, source: 'local_symbol_argument', callerArgument: arg.name, calleeParameter: param, calleeReceiver: param });
    }
    if (arg.kind === 'object_literal' && Array.isArray(arg.properties)) {
      for (const prop of arg.properties as Array<Record<string, unknown>>) {
        if (typeof prop.property !== 'string' || typeof prop.argument !== 'string') continue;
        const binding = callerBindings.get(prop.argument);
        if (!binding) continue;
        const destructured = paramBinding?.kind === 'object_pattern' && Array.isArray(paramBinding.properties)
          ? (paramBinding.properties as Array<Record<string, unknown>>).find((item) => item.property === prop.property && typeof item.local === 'string')
          : undefined;
        if (destructured && typeof destructured.local === 'string') next.set(destructured.local, { ...binding, source: 'local_symbol_destructured_object_argument', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: String(index), calleeReceiver: destructured.local });
        else if (param) {
          next.set(`${param}.${prop.property}`, { ...binding, source: 'local_symbol_object_argument', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeReceiver: `${param}.${prop.property}` });
          for (const alias of parameterPropertyAliases) {
            if (alias.parameter === param && alias.property === prop.property && typeof alias.local === 'string') next.set(alias.local, { ...binding, source: 'local_symbol_object_parameter_destructure', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeObjectProperty: `${param}.${prop.property}`, calleeReceiver: alias.local, calleeLocalDestructuredIdentifier: alias.local, parameterPropertyAliasKind: alias.kind, parameterPropertyAliasLine: alias.line });
          }
        }
      }
    }
  });
  return next;
}
function contextualRuntimeResolution(db: Db, call: CallRow, binding: ContextBinding | undefined, workspaceId: number | undefined, persistedRows: GraphRow[] = []): { row?: GraphRow; evidence?: Record<string, unknown>; unresolvedReason?: string } {
  if (!binding || String(call.call_type) !== 'remote_action' || call.operation_path_expr === undefined || call.operation_path_expr === null) return {};
  const normalized = normalizeODataOperationInvocationPath(String(call.operation_path_expr));
  const op = normalized?.normalizedOperationPath ?? (String(call.operation_path_expr).startsWith('/') ? String(call.operation_path_expr) : `/${String(call.operation_path_expr)}`);
  const servicePath = binding.effectiveServicePath ?? binding.servicePathExpr ?? binding.requireServicePath;
  const destination = binding.effectiveDestination ?? binding.destinationExpr ?? binding.requireDestination;
  const resolution = resolveOperation(db, { servicePath, operationPath: op, alias: binding.aliasExpr ?? binding.alias, destination, hasExplicitOverride: true, isDynamic: false }, workspaceId);
  const evidence: Record<string, unknown> = { contextualServiceBindingAttempted: true, contextualBinding: { source: binding.source, callerArgument: binding.callerArgument, callerProperty: binding.callerProperty, calleeParameter: binding.calleeParameter, calleeReceiver: binding.calleeReceiver, bindingSourceFile: binding.sourceFile, bindingSourceLine: binding.sourceLine, alias: binding.alias, aliasExpr: binding.aliasExpr, requireServicePath: binding.requireServicePath, requireDestination: binding.requireDestination, effectiveServicePath: binding.effectiveServicePath, effectiveDestination: binding.effectiveDestination }, operationPath: op, rawOperationPath: normalized?.rawOperationPath, normalizedOperationPath: normalized?.wasInvocation ? normalized.normalizedOperationPath : undefined, invocationArgumentPlaceholderKeys: normalized?.invocationArgumentPlaceholderKeys.length ? normalized.invocationArgumentPlaceholderKeys : undefined, servicePath, serviceAlias: binding.alias, serviceAliasExpr: binding.aliasExpr, destination, requireServicePath: binding.requireServicePath, requireDestination: binding.requireDestination, effectiveServicePath: binding.effectiveServicePath, effectiveDestination: binding.effectiveDestination, contextualResolutionStatus: resolution.status, contextualCandidateCount: resolution.candidates.length, candidates: resolution.candidates, contextualResolutionReasons: resolution.reasons, resolutionReasons: resolution.reasons };
  if (!resolution.target) return { evidence, unresolvedReason: resolution.status === 'ambiguous' ? 'Ambiguous contextual operation candidates' : resolution.status === 'dynamic' ? `Dynamic contextual target is missing runtime variables: ${resolution.reasons.join(', ')}` : 'No contextual operation candidate matched' };
  const resolvedEvidence = { ...evidence, contextualServiceBindingSelected: true, targetRepo: resolution.target.repoName, targetServicePath: resolution.target.servicePath, targetOperationPath: resolution.target.operationPath, targetOperation: resolution.target.operationName };
  const persistedResolved = persistedRows.find((item) => item.status === 'resolved');
  if (persistedResolved) return { row: undefined, evidence: { ...resolvedEvidence, contextualPreservedPersistedResolvedEdge: true }, unresolvedReason: undefined };
  return { row: { id: -Number(call.id), edge_type: 'REMOTE_CALL_RESOLVES_TO_OPERATION', from_id: String(call.id), to_kind: 'operation', to_id: String(resolution.target.operationId), confidence: resolution.target.score, evidence_json: JSON.stringify(resolvedEvidence), status: 'resolved' }, evidence: resolvedEvidence, unresolvedReason: undefined };
}
export function trace(
  db: Db,
  start: TraceStart,
  options: {
    depth: number;
    vars?: Record<string, string>;
    includeExternal?: boolean;
    includeDb?: boolean;
    includeAsync?: boolean;
    implementationRepo?: string;
  },
): TraceResult {
  const scope = startScope(db, start, options.implementationRepo);
  const diagnostics = db
    .prepare(
      'SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics WHERE (? IS NULL OR repo_id=?)',
    )
    .all(scope.repo?.id, scope.repo?.id) as Array<Record<string, unknown>>;
  const stale = db.prepare('SELECT name,graph_stale_reason reason FROM repositories WHERE graph_stale_reason IS NOT NULL AND (? IS NULL OR id=?)').all(scope.repo?.id, scope.repo?.id) as Array<{ name?: string; reason?: string }>;
  for (const row of stale)
    diagnostics.unshift({ severity: 'warning', code: 'graph_stale', message: `Graph is stale for ${row.name ?? 'repository'}: ${row.reason ?? 'facts_changed'}. Run service-flow link.` });
  for (const diagnostic of scope.startDiagnostics ?? []) diagnostics.unshift(diagnostic);
  if (!scope.selectorMatched && !(scope.startDiagnostics?.length))
    diagnostics.unshift({
      severity: 'warning',
      code: 'trace_start_not_found',
      message: start.servicePath && !start.operation && !start.operationPath && !start.handler ? 'Service-only trace requires --operation or --path and will not broaden to the whole workspace' : 'No handler source matched the requested trace start selector',
    });
  const maxDepth = positiveDepth(options.depth);
  const edges: TraceEdge[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const seenEdges = new Set<number>();
  const queue: Array<{ repoId?: number; files?: Set<string>; symbolIds?: Set<number>; depth: number; context?: Map<string, ContextBinding> }> =
    scope.selectorMatched
      ? [{ repoId: scope.repo?.id, files: scope.sourceFiles, symbolIds: scope.symbolIds, depth: 1, context: new Map() }]
      : [];
  if (scope.startOperationId && scope.selectorMatched) {
    const op = operationNode(db, scope.startOperationId);
    const impl = implementationScope(db, scope.startOperationId);
    if (op) nodes.set(String(op.id), op);
    const startSelection = implementationMethodIdFromHint(impl.edge, options.implementationRepo);
    if (impl.edge && (impl.edge.status === 'resolved' || startSelection.methodId)) {
      const selectedMethodId = impl.edge.status === 'resolved' ? impl.edge.to_id : startSelection.methodId;
      const implEvidence = { ...parseEvidence(impl.edge.evidence_json), startResolution: { strategy: 'indexed_operation_graph', matchedOperationId: scope.startOperationId, implementationEdgeId: impl.edge.id, implementationStatus: impl.edge.status, selectedHandlerMethodId: selectedMethodId }, implementationSelection: startSelection.methodId ? startSelection.evidence : undefined };
      const handlerNode = selectedMethodId ? handlerMethodNode(db, selectedMethodId) : undefined;
      if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
      seenEdges.add(Number(impl.edge.id));
      edges.push({ step: 1, type: 'operation_implemented_by_handler', from: op?.label ? String(op.label) : `operation:${scope.startOperationId}`, to: handlerNode?.label ? String(handlerNode.label) : `${impl.edge.to_kind}:${impl.edge.to_id}`, evidence: implEvidence, confidence: Number(impl.edge.confidence ?? 0), unresolvedReason: impl.edge.status === 'resolved' || startSelection.methodId ? undefined : String(impl.edge.unresolved_reason ?? impl.edge.status) });
    }
  }
  const seenScopes = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;
    const contextKey = [...(current.context ?? new Map<string, ContextBinding>()).keys()].sort().join(',');
    const key = `${current.repoId ?? '*'}:${[...(current.symbolIds ?? new Set(['*']))].sort().join(',')}:${[...(current.files ?? new Set(['*']))].sort().join(',')}:${contextKey}`;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    const calls = db
      .prepare(
        `SELECT c.*,r.name repoName FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?) ORDER BY c.source_file,c.source_line`,
      )
      .all(current.repoId, current.repoId) as CallRow[];
    const filtered = calls.filter(
      (c) =>
        (!current.symbolIds || current.symbolIds.has(Number(c.source_symbol_id))) && (!current.files || current.files.has(String(c.source_file))) &&
        includeCall(String(c.call_type), options),
    );
    const callerBindings = new Map<string, ContextBinding>([...(current.context ?? new Map<string, ContextBinding>()), ...knownBindingsForScope(db, current.repoId, current.symbolIds, current.files), ...knownBindingsForCalls(db, filtered)]);

    if (current.symbolIds && current.symbolIds.size > 0 && current.depth < maxDepth) {
      const symbolRows = db.prepare(`SELECT sc.*,s.repo_id calleeRepoId,s.source_file calleeFile FROM symbol_calls sc LEFT JOIN symbols s ON s.id=sc.callee_symbol_id WHERE sc.caller_symbol_id IN (${[...current.symbolIds].map(() => '?').join(',')}) ORDER BY sc.source_file,sc.source_line`).all(...current.symbolIds) as Array<Record<string, unknown>>;
      for (const symbolCall of symbolRows) {
        if (!symbolCall.callee_symbol_id) continue;
        const nextSymbols = new Set([Number(symbolCall.callee_symbol_id)]);
        const nextFiles = new Set([String(symbolCall.calleeFile)]);
        const nextRepoId = Number(symbolCall.calleeRepoId);
        const nextKey = `${nextRepoId}:${[...nextSymbols].join(',')}:${[...nextFiles].join(',')}`;
        const calleeNode = symbolNode(db, Number(symbolCall.callee_symbol_id));
        if (calleeNode) nodes.set(String(calleeNode.id), calleeNode);
        const evidence = { ...(JSON.parse(String(symbolCall.evidence_json || '{}')) as Record<string, unknown>), sourceFile: symbolCall.source_file, sourceLine: symbolCall.source_line, calleeSymbolId: symbolCall.callee_symbol_id, calleeSymbolName: calleeNode?.symbolName, calleeSymbolFile: calleeNode?.sourceFile, resolutionStatus: symbolCall.status };
        edges.push({ step: current.depth, type: 'local_symbol_call', from: String(symbolCall.callee_expression), to: calleeNode?.label ? String(calleeNode.label) : `symbol:${String(symbolCall.callee_symbol_id)}`, evidence, confidence: Number(symbolCall.confidence ?? 0.8), unresolvedReason: String(symbolCall.status) === 'resolved' ? undefined : symbolCall.unresolved_reason ? String(symbolCall.unresolved_reason) : undefined });
        if (seenScopes.has(nextKey)) edges.push({ step: current.depth, type: 'cycle', from: String(symbolCall.callee_expression), to: nextKey, evidence: { cycle: true, symbolCallId: symbolCall.id }, confidence: 1, unresolvedReason: 'Cycle detected; downstream symbol already visited' });
        else queue.push({ repoId: nextRepoId, files: nextFiles, symbolIds: nextSymbols, depth: current.depth + 1, context: contextForSymbolCall(db, symbolCall, callerBindings) });
      }
    }
    const graph = graphForCalls(
      db,
      filtered.map((c) => Number(c.id)),
    );
    for (const call of filtered) {
      const callNode = `call:${call.id}`;
      nodes.set(callNode, {
        id: callNode,
        kind: 'outbound_call',
        repo: call.repoName,
        file: call.source_file,
        line: call.source_line,
        callType: call.call_type,
      });
      const persistedRowsForCall = graph.get(Number(call.id)) ?? [];
      const contextual = contextualRuntimeResolution(db, call, callerBindings.get(receiverFromEvidence(call.evidence_json) ?? ''), workspaceIdForCall(db, String(call.id)), persistedRowsForCall);
      const graphRows = contextual.row ? [contextual.row] : persistedRowsForCall;
      for (const row of graphRows) {
        if (seenEdges.has(Number(row.id))) continue;
        seenEdges.add(Number(row.id));
        const persistedEvidence = JSON.parse(
          String(row.evidence_json || '{}'),
        ) as Record<string, unknown>;
        const rawEvidence = baseTraceEvidence(row as TraceGraphRow, call, persistedEvidence, contextual.evidence);
        const effective = runtimeResolution(db, row as TraceGraphRow, rawEvidence, options.vars, workspaceIdForCall(db, String(call.id)));
        const evidence = effective.evidence;
        const effectiveRow = effective.row;
        const targetNode = `${effectiveRow.to_kind}:${effectiveRow.to_id}`;
        const opNode = effectiveRow.to_kind === 'operation' ? operationNode(db, effectiveRow.to_id) : undefined;
        nodes.set(targetNode, opNode ?? {
          id: targetNode,
          kind: effectiveRow.to_kind,
          label: effectiveRow.to_kind === 'db_entity' ? `Entity: ${effectiveRow.to_id || 'unknown'}` : effectiveRow.to_id,
        });
        const to = edgeTarget(effectiveRow, evidence);
        edges.push({
          step: current.depth,
          type: traceEdgeType(call, effectiveRow),
          from: `${call.repoName}:${call.source_file}:${call.source_line}`,
          to,
          evidence,
          confidence: Number(effectiveRow.confidence ?? call.confidence),
          unresolvedReason: effective.unresolvedReason,
        });
        if (effectiveRow.to_kind === 'operation') {
          const implementation = implementationScope(db, effectiveRow.to_id);
          const contextSelection = contextImplementationMethodId(implementation.edge, current.repoId, evidence, options.implementationRepo);
          const contextMethodId = contextSelection.methodId;
          const contextNode = contextMethodId ? handlerMethodNode(db, contextMethodId) : undefined;
          if (implementation.edge) {
            const implEvidence = JSON.parse(String(implementation.edge.evidence_json || '{}')) as Record<string, unknown>;
            const handlerNode = implementation.edge.status === 'resolved' ? handlerMethodNode(db, implementation.edge.to_id) : contextNode;
            const implTo = handlerNode?.label ? String(handlerNode.label) : `${implementation.edge.to_kind}:${implementation.edge.to_id}`;
            if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
            edges.push({
              step: current.depth,
              type: 'operation_implemented_by_handler',
              from: to,
              to: implTo,
              evidence: contextMethodId ? { ...implEvidence, contextualImplementationSelected: contextSelection.evidence.strategy !== 'implementation_repo_hint', contextualImplementation: contextSelection.evidence, implementationSelection: contextSelection.evidence } : { ...implEvidence, contextualImplementation: contextSelection.evidence },
              confidence: Number(implementation.edge.confidence ?? 0),
              unresolvedReason: implementation.edge.status === 'resolved' || contextMethodId ? undefined : String(implementation.edge.unresolved_reason ?? implementation.edge.status),
            });
          }
          if (current.depth >= maxDepth) continue;
          const contextScope = contextMethodId ? handlerScope(db, contextMethodId) : undefined;
          const files = contextScope?.files ?? (implementation.files.size > 0 ? implementation.files : handlerFilesForOperation(db, effectiveRow.to_id));
          const symbolIds = contextScope?.symbolId ? new Set([contextScope.symbolId]) : implementation.symbolId ? new Set([implementation.symbolId]) : undefined;
          if ((implementation.edge?.status === 'resolved' || contextScope) && files.size > 0) {
            const targetRepoId = contextScope?.repoId ?? implementation.repoId ?? (db
              .prepare(
                'SELECT s.repo_id repoId FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?',
              )
              .get(effectiveRow.to_id)?.repoId as number | undefined);
            const nextKey = `${targetRepoId ?? '*'}:${[...(symbolIds ?? new Set(['*']))].sort().join(',')}:${[...files].sort().join(',')}`;
            if (seenScopes.has(nextKey))
              edges.push({
                step: current.depth,
                type: 'cycle',
                from: to,
                to: nextKey,
                evidence: { ...evidence, cycle: true },
                confidence: 1,
                unresolvedReason:
                  'Cycle detected; downstream scope already visited',
              });
            else
              queue.push({
                repoId: targetRepoId,
                files,
                symbolIds,
                depth: current.depth + 1,
              });
          }
        }
      }
    }
  }
  const runtimeDiagnostic = runtimeVariableDiagnostic(edges);
  if (runtimeDiagnostic) diagnostics.unshift(runtimeDiagnostic);
  return { start, nodes: [...nodes.values()], edges, diagnostics };
}
