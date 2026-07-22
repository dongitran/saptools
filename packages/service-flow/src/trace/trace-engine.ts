import type { Db } from '../db/connection.js';
import { reposByName } from '../db/repositories.js';
import { extractPlaceholders } from '../linker/dynamic-edge-resolver.js';
import type { ImplementationHint, TraceEdge, TraceOptions, TraceResult, TraceStart } from '../types.js';
import { baseTraceEvidence, edgeTarget, runtimeNoCandidateDiagnostics, runtimeResolution, runtimeVariableDiagnostic, type TraceGraphRow } from './evidence.js';
import { dynamicCandidateBranches } from './dynamic-branches.js';
import {
  loadTraceDiagnostics,
  prependTraceDiagnostic,
} from './002-trace-diagnostics.js';
import { implementationHintDiagnostic } from './implementation-hints.js';
import {
  contextualImplementationSelection,
  hintedImplementationSelection,
} from './005-implementation-selection.js';
import { implementationStartDiagnostic } from './007-implementation-start-diagnostic.js';
import {
  contextualRuntimeResolution,
  type ContextBinding,
} from './008-contextual-runtime-state.js';
import {
  handlerMethodNode,
  withSelectedHandlerProvenance,
  type SelectedHandlerEvidence,
} from './009-selected-handler-provenance.js';
import { boundCandidateLikeEvidence } from '../utils/000-bounded-projection.js';
import { schemaLifecycleDiagnostic } from '../db/001-fact-lifecycle.js';
import { TraversalScopeScheduler } from './010-traversal-scope.js';
import { planEventSubscriberTransitions } from './011-event-subscriber-traversal.js';
import {
  graphForCalls,
  operationNode,
  symbolNode,
  type TraceGraphEdgeRow as GraphRow,
} from './012-trace-graph-lookups.js';
import {
  createTraceRootPlan,
  enqueueCausalScope,
  nextPendingRoot,
} from './013-trace-root-scopes.js';
import {
  ambiguousStartDiagnostic,
  selectorNotFoundDiagnostic,
  selectorRepoAmbiguousDiagnostic,
  selectorRepoNotFoundDiagnostic,
  sourceScopeForSelector,
} from './selectors.js';
interface RepoRef {
  id: number;
  name: string;
  packageName?: string;
}
interface StartScope {
  repo?: RepoRef;
  executionRepoId?: number;
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
  workspaceId: number;
  graphGeneration: number;
}
interface ImplementationHintOptions {
  implementationRepo?: string;
  implementationHints?: ImplementationHint[];
}
function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}
function positiveDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
}
function operationStartScope(db: Db, repoId: number | undefined, start: TraceStart, hintOptions: ImplementationHintOptions, workspaceId?: number): { files?: Set<string>; symbols?: Set<number>; repoId?: number; operationId?: string; diagnostics?: Array<Record<string, unknown>> } | undefined {
  const requested = normalizeOperation(start.operationPath ?? start.operation);
  if (!requested) return undefined;
  const rows = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,s.service_path servicePath,r.id repoId,r.name repoName
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
    WHERE (? IS NULL OR r.workspace_id=?) AND (? IS NULL OR r.id=?)
      AND (? IS NULL OR s.service_path=?) AND (o.operation_name=? OR o.operation_path=? OR o.operation_path=?)
    ORDER BY r.name,s.service_path,o.operation_name,o.id`).all(workspaceId, workspaceId, repoId, repoId, start.servicePath, start.servicePath, requested, requested, requested.startsWith('/') ? requested : `/${requested}`) as Array<Record<string, unknown>>;
  if (rows.length === 0) return undefined;
  const repoCount = new Set(rows.map((row) => String(row.repoName))).size;
  const serviceCount = new Set(rows.map((row) => `${String(row.repoName)}:${String(row.servicePath)}`)).size;
  if (!repoId && repoCount > 1)
    return { diagnostics: [ambiguousStartDiagnostic(requested, rows, 'Operation trace start matched multiple repositories; add --repo to disambiguate')] };
  if (!start.servicePath && serviceCount > 1)
    return { diagnostics: [ambiguousStartDiagnostic(requested, rows, 'Operation trace start matched multiple services; add --service to disambiguate')] };
  if (rows.length !== 1)
    return { diagnostics: [ambiguousStartDiagnostic(requested, rows, 'Operation trace start matched multiple indexed operations')] };
  const operationId = String(rows[0]?.operationId);
  const impl = implementationScope(db, operationId);
  if (impl.edge?.status === 'resolved' && impl.files.size > 0) return { files: impl.files, symbols: impl.symbolId ? new Set([impl.symbolId]) : undefined, repoId: impl.repoId, operationId, diagnostics: [] };
  const hinted = hintedImplementationSelection(
    db, impl.edge, operationId, hintOptions,
  );
  if (hinted.methodId) {
    const hintedScope = handlerScope(db, hinted.methodId);
    if (hintedScope?.files.size) return { files: hintedScope.files, symbols: hintedScope.symbolId ? new Set([hintedScope.symbolId]) : undefined, repoId: hintedScope.repoId, operationId, diagnostics: [] };
  }
  if (impl.edge) {
    const evidence = parseEvidence(impl.edge.evidence_json);
    const hintDiagnostic = implementationHintDiagnostic(hinted, evidence);
    const diagnostics = [implementationStartDiagnostic(impl.edge, evidence)];
    return { operationId, diagnostics: hintDiagnostic ? [hintDiagnostic, ...diagnostics] : diagnostics };
  }
  return { operationId, diagnostics: [{ severity: 'warning', code: 'trace_start_implementation_unresolved', message: 'Indexed operation matched but no implementation candidate exists', resolutionStage: 'implementation', resolutionStatus: 'operation_without_implementation' }] };
}
function sourceFilesForStart(
  db: Db,
  repoId: number | undefined,
  start: TraceStart,
  workspaceId: number | undefined,
): ReturnType<typeof sourceScopeForSelector> {
  return sourceScopeForSelector(db, repoId, start, workspaceId);
}
function startScope(db: Db, start: TraceStart, hintOptions: ImplementationHintOptions, workspaceId?: number): StartScope {
  const repos: RepoRef[] = start.repo
    ? reposByName(db, start.repo, workspaceId).map((row) => ({
        id: row.id,
        name: row.name,
        packageName: row.package_name ?? undefined,
      }))
    : [];
  if (start.repo && repos.length === 0) return {
    selectorMatched: false,
    startDiagnostics: [selectorRepoNotFoundDiagnostic(start.repo)],
  };
  if (start.repo && repos.length > 1) return {
    selectorMatched: false,
    startDiagnostics: [selectorRepoAmbiguousDiagnostic(start.repo, repos)],
  };
  const repo = repos[0];
  const operationScope = operationStartScope(
    db, repo?.id, start, hintOptions, workspaceId,
  );
  const terminalOperationScope = operationScope && !operationScope.files && (operationScope.diagnostics ?? []).some((d) => d.resolutionStage === 'operation' || d.resolutionStage === 'implementation');
  const sourceScope = operationScope?.files || terminalOperationScope ? operationScope : sourceFilesForStart(db, repo?.id, start, workspaceId);
  const terminalSelectorScope = Boolean(sourceScope?.diagnostics?.length && !sourceScope.files);
  const sourceFiles = sourceScope?.files;
  const hasSelector = Boolean(
    start.handler ?? start.operation ?? start.operationPath ?? start.servicePath,
  );
  if (start.servicePath && !start.operation && !start.operationPath && !start.handler)
    return { repo, selectorMatched: false };
  return {
    repo,
    executionRepoId: sourceScope?.repoId ?? repo?.id,
    sourceFiles,
    symbolIds: sourceScope?.symbols,
    selectorMatched: !terminalOperationScope && !terminalSelectorScope
      && (!hasSelector || sourceFiles !== undefined),
    startOperationId: operationScope?.operationId,
    startDiagnostics: operationScope?.diagnostics?.length
      ? operationScope.diagnostics
      : sourceScope?.diagnostics,
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
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id
      AND sym.source_file=hc.source_file
      AND sym.qualified_name=hc.class_name || '.' || hm.method_name
      AND sym.start_line=hm.source_line
    WHERE hc.repo_id=?
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.handlerKind'),
        CASE WHEN hm.decorator_kind='Event' THEN 'event'
          WHEN hm.decorator_kind IN ('Action','Func','On') THEN 'operation'
          ELSE 'unsupported' END)='operation'
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On')
          THEN 1 ELSE 0 END)=1
      AND (hm.decorator_value=? OR hm.method_name=? OR hm.decorator_value=?)`,
    )
    .all(op.repoId, operation, operation, op.operationName) as Array<{
    sourceFile?: string;
  }>;
  return new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]);
}
function implementationEdge(db: Db, operationId: string): GraphRow | undefined {
  return db.prepare("SELECT * FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND from_kind='operation' AND from_id=? ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,id LIMIT 1").get(operationId) as GraphRow | undefined;
}
function implementationScope(db: Db, operationId: string): { repoId?: number; files: Set<string>; symbolId?: number; edge?: GraphRow } {
  const edge = implementationEdge(db, operationId);
  if (!edge || edge.status !== 'resolved') return { files: new Set(), edge };
  const row = db.prepare("SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.qualified_name=hc.class_name || '.' || hm.method_name AND s.start_line=hm.source_line WHERE hm.id=?").get(edge.to_id) as { repoId?: number; sourceFile?: string; symbolId?: number } | undefined;
  if (!row || typeof row.symbolId !== 'number')
    return { repoId: row?.repoId, files: new Set(), edge };
  return { repoId: row?.repoId, files: new Set(row?.sourceFile ? [row.sourceFile] : []), symbolId: row?.symbolId, edge };
}
function handlerScope(db: Db, methodId: string): { repoId?: number; files: Set<string>; symbolId?: number } | undefined {
  const row = db.prepare("SELECT hc.repo_id repoId,hc.source_file sourceFile,s.id symbolId FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id LEFT JOIN symbols s ON s.repo_id=hc.repo_id AND s.source_file=hc.source_file AND s.qualified_name=hc.class_name || '.' || hm.method_name AND s.start_line=hm.source_line WHERE hm.id=?").get(methodId) as { repoId?: number; sourceFile?: string; symbolId?: number } | undefined;
  if (!row || typeof row.symbolId !== 'number') return undefined;
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
function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return isEvidenceRecord(parsed) ? boundCandidateLikeEvidence(parsed) : {};
  } catch {
    return {};
  }
}
function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
  type BindingRow = Omit<ContextBinding, 'bindingId' | 'source' | 'calleeReceiver'> & { id?: number; symbolId?: number | null; variableName?: string };
  const rows = db.prepare(`SELECT b.id,b.symbol_id symbolId,b.variable_name variableName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.source_file sourceFile,b.source_line sourceLine,req.service_path requireServicePath,req.destination requireDestination
    FROM service_bindings b LEFT JOIN cds_requires req ON req.repo_id=b.repo_id AND req.alias=b.alias
    WHERE b.repo_id=? ORDER BY b.source_file COLLATE BINARY,b.source_line,b.id`).all(repoId) as BindingRow[];
  for (const row of rows) {
    if (!row.variableName) continue;
    if (files && !files.has(String(row.sourceFile))) continue;
    if (symbolIds && symbolIds.size > 0 && row.symbolId != null
      && !symbolIds.has(Number(row.symbolId))) continue;
    const candidate = enrichBinding({
      ...row,
      bindingId: Number(row.id),
      source: 'local_service_binding',
      calleeReceiver: row.variableName,
      resolutionStatus: 'selected',
    });
    const existing = map.get(row.variableName);
    if (!existing) {
      map.set(row.variableName, candidate);
      continue;
    }
    const candidates = uniqueBindingCandidates([
      ...(existing.bindingCandidates ?? [bindingCandidateEvidence(existing)]),
      bindingCandidateEvidence(candidate),
    ]);
    map.set(row.variableName, {
      ...candidate,
      bindingId: undefined,
      source: 'ambiguous_local_service_bindings',
      resolutionStatus: 'ambiguous',
      bindingCandidates: candidates,
    });
  }
  return map;
}
function bindingCandidateEvidence(binding: ContextBinding): Record<string, unknown> {
  return {
    bindingId: binding.bindingId,
    sourceFile: binding.sourceFile,
    sourceLine: binding.sourceLine,
    alias: binding.alias,
    aliasExpr: binding.aliasExpr,
    destinationExpr: binding.destinationExpr,
    servicePathExpr: binding.servicePathExpr,
  };
}

function uniqueBindingCandidates(
  candidates: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function contextForSymbolCall(db: Db, symbolCall: Record<string, unknown>, callerBindings: Map<string, ContextBinding>): Map<string, ContextBinding> {
  const next = new Map<string, ContextBinding>();
  if (callerBindings.size === 0) return next;
  const callEvidence = parseEvidence(symbolCall.evidence_json);
  const callee = db.prepare('SELECT evidence_json evidenceJson,source_file sourceFile,start_line startLine FROM symbols WHERE id=?').get(symbolCall.callee_symbol_id) as { evidenceJson?: string; sourceFile?: string; startLine?: number } | undefined;
  const calleeEvidence = parseEvidence(callee?.evidenceJson);
  const params = Array.isArray(calleeEvidence.parameters) ? calleeEvidence.parameters.filter((item): item is string => typeof item === 'string') : [];
  const parameterBindings = Array.isArray(calleeEvidence.parameterBindings) ? calleeEvidence.parameterBindings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
  const parameterPropertyAliases = Array.isArray(calleeEvidence.parameterPropertyAliases) ? calleeEvidence.parameterPropertyAliases.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
  const args = Array.isArray(callEvidence.callArguments) ? callEvidence.callArguments as Array<Record<string, unknown>> : [];
  const provenance = {
    callerSite: { sourceFile: String(symbolCall.source_file ?? ''), sourceLine: Number(symbolCall.source_line ?? 0) },
    calleeSite: { sourceFile: callee?.sourceFile, sourceLine: callee?.startLine },
  };
  args.forEach((arg, index) => {
    const paramBinding = parameterBindings.find((binding) => binding.index === index);
    const param = paramBinding?.kind === 'identifier' && typeof paramBinding.name === 'string' ? paramBinding.name : params[index];
    if (arg.kind === 'identifier' && typeof arg.name === 'string') {
      const binding = callerBindings.get(arg.name);
      if (binding && param) next.set(param, { ...binding, ...provenance, source: 'local_symbol_argument', callerArgument: arg.name, calleeParameter: param, calleeReceiver: param });
    }
    if (arg.kind === 'object_literal' && Array.isArray(arg.properties)) {
      for (const prop of arg.properties as Array<Record<string, unknown>>) {
        if (typeof prop.property !== 'string' || typeof prop.argument !== 'string') continue;
        const binding = callerBindings.get(prop.argument);
        if (!binding) continue;
        const destructured = paramBinding?.kind === 'object_pattern' && Array.isArray(paramBinding.properties)
          ? (paramBinding.properties as Array<Record<string, unknown>>).find((item) => item.property === prop.property && typeof item.local === 'string')
          : undefined;
        if (destructured && typeof destructured.local === 'string') next.set(destructured.local, { ...binding, ...provenance, source: 'local_symbol_destructured_object_argument', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: String(index), calleeReceiver: destructured.local });
        else if (param) {
          next.set(`${param}.${prop.property}`, { ...binding, ...provenance, source: 'local_symbol_object_argument', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeReceiver: `${param}.${prop.property}` });
          for (const alias of parameterPropertyAliases) {
            if (alias.parameter === param && alias.property === prop.property && typeof alias.local === 'string') next.set(alias.local, { ...binding, ...provenance, source: 'local_symbol_object_parameter_destructure', callerProperty: prop.property, callerArgument: prop.argument, calleeParameter: param, calleeObjectProperty: `${param}.${prop.property}`, calleeReceiver: alias.local, calleeLocalDestructuredIdentifier: alias.local, parameterPropertyAliasKind: alias.kind, parameterPropertyAliasLine: alias.line });
          }
        }
      }
    }
    if (arg.kind === 'array_literal' && Array.isArray(arg.elements) && paramBinding?.kind === 'array_pattern' && Array.isArray(paramBinding.elements)) {
      for (const element of arg.elements as Array<Record<string, unknown>>) {
        const target = (paramBinding.elements as Array<Record<string, unknown>>).find((item) => item.index === element.index);
        if (element.kind !== 'identifier' || typeof element.name !== 'string' || typeof target?.local !== 'string') continue;
        const binding = callerBindings.get(element.name);
        if (binding) next.set(target.local, { ...binding, ...provenance, source: 'local_symbol_destructured_array_argument', callerArgument: element.name, calleeParameter: String(index), calleeReceiver: target.local });
      }
    }
  });
  return next;
}
export function trace(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
): TraceResult {
  const schemaLifecycle = schemaLifecycleDiagnostic(db);
  if (schemaLifecycle)
    return { start, nodes: [], edges: [], diagnostics: [schemaLifecycle] };
  const hintOptions = { implementationRepo: options.implementationRepo, implementationHints: options.implementationHints };
  const scope = startScope(db, start, hintOptions, options.workspaceId);
  const hasSelector = Boolean(start.repo || start.handler || start.operation
    || start.operationPath || start.servicePath);
  const diagnosticRepoId = scope.executionRepoId ?? scope.repo?.id;
  const scheduler = new TraversalScopeScheduler();
  const roots = createTraceRootPlan(db, scheduler, {
    repoId: diagnosticRepoId, files: scope.sourceFiles,
    symbolIds: scope.symbolIds, selectorMatched: scope.selectorMatched,
  }, options.workspaceId, Boolean(options.includeAsync));
  if (roots.diagnostic)
    return { start, nodes: [], edges: [], diagnostics: [roots.diagnostic] };
  const { workspaceId, queue, pendingRoots } = roots;
  const diagnostics = loadTraceDiagnostics(
    db,
    diagnosticRepoId,
    !hasSelector,
    workspaceId,
  );
  const stale = diagnosticRepoId !== undefined || !hasSelector
    ? db.prepare('SELECT name,graph_stale_reason reason FROM repositories WHERE graph_stale_reason IS NOT NULL AND (? IS NULL OR id=?) AND (? IS NULL OR workspace_id=?) ORDER BY name,id').all(diagnosticRepoId, diagnosticRepoId, workspaceId, workspaceId) as Array<{ name?: string; reason?: string }>
    : [];
  for (const row of stale)
    prependTraceDiagnostic(diagnostics, { severity: 'warning', code: 'graph_stale', message: `Graph is stale for ${row.name ?? 'repository'}: ${row.reason ?? 'facts_changed'}. Run service-flow link.` });
  for (const diagnostic of scope.startDiagnostics ?? [])
    prependTraceDiagnostic(diagnostics, diagnostic);
  if (!scope.selectorMatched && !(scope.startDiagnostics?.length))
    prependTraceDiagnostic(diagnostics, selectorNotFoundDiagnostic(start));
  const maxDepth = positiveDepth(options.depth);
  const edges: TraceEdge[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  if (scope.startOperationId && scope.selectorMatched) {
    const op = operationNode(db, scope.startOperationId);
    const impl = implementationScope(db, scope.startOperationId);
    if (op) nodes.set(String(op.id), op);
    const startSelection = hintedImplementationSelection(
      db, impl.edge, scope.startOperationId, hintOptions,
    );
    if (impl.edge && (impl.edge.status === 'resolved' || startSelection.methodId)) {
      const selectedMethodId = impl.edge.status === 'resolved' ? impl.edge.to_id : startSelection.methodId;
      const implEvidence = {
        ...parseEvidence(impl.edge.evidence_json),
        startResolution: {
          strategy: 'indexed_operation_graph',
          matchedOperationId: scope.startOperationId,
          implementationEdgeId: impl.edge.id,
          implementationStatus: impl.edge.status,
          selectedHandlerMethodId: selectedMethodId,
        },
        implementationSelection: startSelection.methodId
          ? startSelection.evidence : undefined,
      };
      const selected: SelectedHandlerEvidence = selectedMethodId
        ? withSelectedHandlerProvenance(
          implEvidence, selectedMethodId, handlerMethodNode(db, selectedMethodId),
        )
        : { evidence: implEvidence };
      if (selected.diagnostic) prependTraceDiagnostic(diagnostics, selected.diagnostic);
      if (selected.handler) nodes.set(String(selected.handler.id), selected.handler);
      edges.push({ step: 1, type: 'operation_implemented_by_handler', from: op?.label ? String(op.label) : `operation:${scope.startOperationId}`, to: selected.handler?.label ? String(selected.handler.label) : `${impl.edge.to_kind}:${impl.edge.to_id}`, evidence: selected.evidence, confidence: Number(impl.edge.confidence ?? 0), unresolvedReason: selected.unresolvedReason ?? (impl.edge.status === 'resolved' || startSelection.methodId ? undefined : String(impl.edge.unresolved_reason ?? impl.edge.status)) });
    }
  }
  while (queue.length > 0 || pendingRoots.length > 0) {
    if ((queue[0]?.depth ?? Number.POSITIVE_INFINITY) > 1
      && workspaceId !== undefined) {
      const root = nextPendingRoot(pendingRoots, scheduler, workspaceId);
      if (root) queue.unshift(root);
    }
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;
    if (!scheduler.markExpanded(current.state)) continue;
    const calls = db
      .prepare(
        `SELECT c.*,r.name repoName,r.workspace_id workspaceId,
          r.graph_generation graphGeneration
        FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
        WHERE (? IS NULL OR c.repo_id=?) AND (? IS NULL OR r.workspace_id=?)
        ORDER BY c.source_file COLLATE BINARY,c.call_site_start_offset,
          c.call_site_end_offset,c.source_line,c.id`,
      )
      .all(current.repoId, current.repoId, workspaceId, workspaceId) as CallRow[];
    const filtered = calls.filter(
      (c) =>
        (current.unownedOnly ? c.source_symbol_id == null
          : !current.symbolIds || current.symbolIds.has(Number(c.source_symbol_id)))
        && (!current.files || current.files.has(String(c.source_file))) &&
        includeCall(String(c.call_type), options),
    );
    const callerBindings = new Map<string, ContextBinding>([...current.context, ...knownBindingsForScope(db, current.repoId, current.symbolIds, current.files), ...knownBindingsForCalls(db, filtered)]);

    if (!current.rootObservationOnly && current.symbolIds
      && current.symbolIds.size > 0 && current.depth < maxDepth) {
      const symbolRows = db.prepare(`SELECT sc.*,s.repo_id calleeRepoId,
        s.source_file calleeFile FROM symbol_calls sc
        LEFT JOIN symbols s ON s.id=sc.callee_symbol_id
        WHERE sc.call_role='ordinary_call'
          AND sc.caller_symbol_id IN (${[...current.symbolIds].map(() => '?').join(',')})
        ORDER BY sc.source_file COLLATE BINARY,sc.call_site_start_offset,
          sc.call_site_end_offset,sc.source_line,sc.id`).all(
        ...current.symbolIds,
      ) as Array<Record<string, unknown>>;
      for (const symbolCall of symbolRows) {
        if (!symbolCall.callee_symbol_id) continue;
        const nextSymbols = new Set([Number(symbolCall.callee_symbol_id)]);
        const nextFiles = new Set([String(symbolCall.calleeFile)]);
        const nextRepoId = Number(symbolCall.calleeRepoId);
        const nextContext = contextForSymbolCall(db, symbolCall, callerBindings);
        const scheduling = scheduler.schedule({
          workspaceId,
          repoId: nextRepoId,
          files: nextFiles,
          symbolIds: nextSymbols,
          context: nextContext,
        }, current.state);
        const calleeNode = symbolNode(db, Number(symbolCall.callee_symbol_id));
        if (calleeNode) nodes.set(String(calleeNode.id), calleeNode);
        const evidence = { ...parseEvidence(symbolCall.evidence_json), sourceFile: symbolCall.source_file, sourceLine: symbolCall.source_line, calleeSymbolId: symbolCall.callee_symbol_id, calleeSymbolName: calleeNode?.symbolName, calleeSymbolFile: calleeNode?.sourceFile, resolutionStatus: symbolCall.status };
        edges.push({ step: current.depth, type: 'local_symbol_call', from: String(symbolCall.callee_expression), to: calleeNode?.label ? String(calleeNode.label) : `symbol:${String(symbolCall.callee_symbol_id)}`, evidence, confidence: Number(symbolCall.confidence ?? 0.8), unresolvedReason: String(symbolCall.status) === 'resolved' ? undefined : symbolCall.unresolved_reason ? String(symbolCall.unresolved_reason) : undefined });
        if (scheduling.kind === 'cycle') edges.push({ step: current.depth, type: 'cycle', from: String(symbolCall.callee_expression), to: scheduling.state.structuralKey, evidence: { cycle: true, cycleReason: 'structural_ancestry_cycle', symbolCallId: symbolCall.id }, confidence: 1, unresolvedReason: 'Cycle detected in structural ancestry; downstream symbol was not expanded' });
        if (scheduling.kind === 'scheduled') enqueueCausalScope(
          queue, pendingRoots, { repoId: nextRepoId, files: nextFiles,
            symbolIds: nextSymbols, depth: current.depth + 1,
            context: nextContext, state: scheduling.state });
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
      const contextual = contextualRuntimeResolution(db, call, callerBindings.get(receiverFromEvidence(call.evidence_json) ?? ''), call.workspaceId, persistedRowsForCall);
      const graphRows = contextual.row ? [contextual.row] : persistedRowsForCall;
      for (const row of graphRows) {
        const persistedEvidence = parseEvidence(row.evidence_json);
        const rawEvidence = baseTraceEvidence(row as TraceGraphRow, call, persistedEvidence, contextual.evidence);
        const effective = runtimeResolution(db, row as TraceGraphRow, rawEvidence, {
          vars: options.vars,
          dynamicMode: options.dynamicMode ?? 'strict',
          maxDynamicCandidates: options.maxDynamicCandidates,
        }, call.workspaceId, contextual.state);
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
        if (options.includeAsync && call.call_type === 'async_emit'
          && effectiveRow.edge_type === 'HANDLER_EMITS_EVENT'
          && typeof call.event_name_expr === 'string') {
          const plans = planEventSubscriberTransitions(db, {
            workspaceId: workspaceId ?? call.workspaceId,
            graphGeneration: call.graphGeneration,
            eventName: call.event_name_expr,
          }, scheduler, current.state, current.depth, maxDepth);
          for (const plan of plans) {
            const nodeId = String(plan.node.id);
            const targetLabel = String(plan.node.label ?? nodeId);
            nodes.set(nodeId, plan.node);
            edges.push({
              step: current.depth,
              type: 'event_name_matches_subscription_handler',
              from: plan.transition.eventName,
              to: targetLabel,
              evidence: plan.evidence,
              confidence: plan.transition.confidence,
              unresolvedReason: plan.transition.unresolvedReason,
            });
            if (plan.bodyExpansion === 'cycle_blocked' && plan.state)
              edges.push({ step: current.depth, type: 'cycle', from: targetLabel, to: plan.state.structuralKey, evidence: { cycle: true, cycleReason: 'structural_ancestry_cycle', graphEdgeId: plan.transition.graphEdgeId }, confidence: 1, unresolvedReason: 'Cycle detected across an event subscriber boundary; downstream symbol was not expanded' });
            const handler = plan.transition.handler;
            if (plan.bodyExpansion === 'scheduled' && plan.state && handler) {
              const files = new Set([handler.sourceFile]);
              const symbolIds = new Set([handler.symbolId]);
              enqueueCausalScope(queue, pendingRoots, {
                repoId: handler.repoId, files, symbolIds,
                depth: current.depth + 1, context: new Map(), state: plan.state,
              });
            }
          }
        }
        if ((options.dynamicMode ?? 'strict') === 'candidates'
          && effectiveRow.status !== 'resolved')
          edges.push(...dynamicCandidateBranches(current.depth, call, evidence));
        if (effectiveRow.to_kind === 'operation') {
          const implementation = implementationScope(db, effectiveRow.to_id);
          const contextSelection = contextualImplementationSelection(
            db, implementation.edge, effectiveRow.to_id, current.repoId, evidence,
            hintOptions,
          );
          const contextMethodId = contextSelection.methodId;
          let selectedHandlerAvailable = true;
          if (implementation.edge) {
            const implEvidence = parseEvidence(implementation.edge.evidence_json);
            const hintDiagnostic = implementationHintDiagnostic(contextSelection, implEvidence);
            if (hintDiagnostic) prependTraceDiagnostic(diagnostics, hintDiagnostic);
            const selectedMethodId = implementation.edge.status === 'resolved'
              ? implementation.edge.to_id : contextMethodId;
            const selectionEvidence = contextMethodId
              ? {
                ...implEvidence,
                contextualImplementationSelected:
                  contextSelection.evidence.strategy !== 'implementation_repo_hint',
                contextualImplementation: contextSelection.evidence,
                implementationSelection: contextSelection.evidence,
              }
              : {
                ...implEvidence,
                contextualImplementation: contextSelection.evidence,
                implementationSelection: contextSelection.evidence,
              };
            const selected: SelectedHandlerEvidence = selectedMethodId
              ? withSelectedHandlerProvenance(
                selectionEvidence,
                selectedMethodId,
                handlerMethodNode(db, selectedMethodId),
              )
              : { evidence: selectionEvidence };
            selectedHandlerAvailable = !selected.unresolvedReason;
            if (selected.diagnostic) prependTraceDiagnostic(diagnostics, selected.diagnostic);
            const implTo = selected.handler?.label
              ? String(selected.handler.label)
              : `${implementation.edge.to_kind}:${implementation.edge.to_id}`;
            if (selected.handler) nodes.set(String(selected.handler.id), selected.handler);
            edges.push({
              step: current.depth,
              type: 'operation_implemented_by_handler',
              from: to,
              to: implTo,
              evidence: selected.evidence,
              confidence: Number(implementation.edge.confidence ?? 0),
              unresolvedReason: selected.unresolvedReason
                ?? (implementation.edge.status === 'resolved' || contextMethodId
                  ? undefined
                  : String(implementation.edge.unresolved_reason ?? implementation.edge.status)),
            });
          }
          if (current.depth >= maxDepth) continue;
          const contextScope = contextMethodId ? handlerScope(db, contextMethodId) : undefined;
          const files = contextScope?.files ?? (implementation.files.size > 0 ? implementation.files : handlerFilesForOperation(db, effectiveRow.to_id));
          const symbolIds = contextScope?.symbolId ? new Set([contextScope.symbolId]) : implementation.symbolId ? new Set([implementation.symbolId]) : undefined;
          if (selectedHandlerAvailable
            && (implementation.edge?.status === 'resolved' || contextScope)
            && files.size > 0) {
            const targetRepoId = contextScope?.repoId ?? implementation.repoId ?? (db
              .prepare(
                'SELECT s.repo_id repoId FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?',
              )
              .get(effectiveRow.to_id)?.repoId as number | undefined);
            const nextContext = new Map<string, ContextBinding>();
            const scheduling = scheduler.schedule({
              workspaceId: workspaceId ?? call.workspaceId,
              repoId: targetRepoId,
              files,
              symbolIds,
              context: nextContext,
            }, current.state);
            if (scheduling.kind === 'cycle')
              edges.push({
                step: current.depth,
                type: 'cycle',
                from: to,
                to: scheduling.state.structuralKey,
                evidence: { ...evidence, cycle: true,
                  cycleReason: 'structural_ancestry_cycle' },
                confidence: 1,
                unresolvedReason:
                  'Cycle detected in structural ancestry; downstream scope was not expanded',
              });
            if (scheduling.kind === 'scheduled') enqueueCausalScope(
              queue, pendingRoots, { repoId: targetRepoId, files, symbolIds,
                depth: current.depth + 1, context: nextContext,
                state: scheduling.state });
          }
        }
      }
    }
  }
  const runtimeDiagnostic = runtimeVariableDiagnostic(edges);
  if (runtimeDiagnostic) prependTraceDiagnostic(diagnostics, runtimeDiagnostic);
  for (const diagnostic of runtimeNoCandidateDiagnostics(edges))
    prependTraceDiagnostic(diagnostics, diagnostic);
  return { start, nodes: [...nodes.values()], edges, diagnostics };
}
