import type { Db } from '../db/connection.js';
import { extractPlaceholders, substituteVariables, type RuntimeSubstitution } from '../linker/dynamic-edge-resolver.js';
import { resolveOperation, type OperationTarget } from '../linker/service-resolver.js';
import type { TraceEdge, TraceResult, TraceStart } from '../types.js';

interface RepoRef {
  id: number;
  name: string;
}
interface StartScope {
  repo?: RepoRef;
  sourceFiles?: Set<string>;
  symbolIds?: Set<number>;
  selectorMatched: boolean;
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
interface Candidate {
  servicePath?: string;
  operationPath?: string;
  repoName?: string;
  operationName?: string;
  score?: number;
}

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}
function positiveDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
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
function startScope(db: Db, start: TraceStart): StartScope {
  const repo = start.repo
    ? (db
        .prepare(
          'SELECT id,name FROM repositories WHERE name=? OR package_name=?',
        )
        .get(start.repo, start.repo) as RepoRef | undefined)
    : undefined;
  if (start.repo && !repo) return { repo, selectorMatched: false };
  const sourceScope = sourceFilesForStart(db, repo?.id, start);
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
    selectorMatched: !hasSelector || sourceFiles !== undefined,
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
function hasRuntimeVariable(value: unknown, vars: Record<string, string>): boolean {
  return typeof value === 'string' && extractPlaceholders(value).some((key) => Object.hasOwn(vars, key));
}

function isRemoteRuntimeCandidate(row: GraphRow, evidence: Record<string, unknown>, vars: Record<string, string> | undefined): boolean {
  if (!vars || Object.keys(vars).length === 0) return false;
  if (!['dynamic', 'ambiguous', 'unresolved'].includes(String(row.status ?? ''))) return false;
  if (!['DYNAMIC_EDGE_CANDIDATE', 'UNRESOLVED_EDGE', 'REMOTE_CALL_RESOLVES_TO_OPERATION'].includes(row.edge_type)) return false;
  if (row.status === 'resolved') return false;
  return ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination'].some((key) => hasRuntimeVariable(evidence[key], vars));
}

function evidenceWithRuntimeVariables(
  evidence: Record<string, unknown>,
  vars: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!vars || Object.keys(vars).length === 0) return evidence;
  const substitutions: Record<string, RuntimeSubstitution> = {};
  for (const key of ['servicePath', 'operationPath', 'serviceAliasExpr', 'serviceAlias', 'destination']) {
    const substitution = substituteVariables(typeof evidence[key] === 'string' ? String(evidence[key]) : undefined, vars);
    if (substitution.placeholders.length > 0) substitutions[key] = substitution;
  }
  const next: Record<string, unknown> = { ...evidence, runtimeVariablesApplied: true, runtimeSubstitutions: substitutions };
  for (const [key, value] of Object.entries(substitutions)) {
    if (value.effective) next[key] = value.effective;
  }
  const missing = Object.values(substitutions).flatMap((value) => value.missing);
  if (missing.length > 0) next.missingRuntimeVariables = [...new Set(missing)];
  return next;
}

function operationNode(db: Db, operationId: string): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT o.id operationId,o.operation_name operationName,o.operation_type operationType,o.operation_path operationPath,o.source_file sourceFile,o.source_line sourceLine,s.id serviceId,s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,r.id repoId,r.name repoName FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operationId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { id: `operation:${operationId}`, kind: 'operation', label: `${String(row.repoName)}:${String(row.servicePath)}${String(row.operationPath)}`, ...row };
}
function workspaceIdForCall(db: Db, callId: string): number | undefined {
  return (db.prepare('SELECT r.workspace_id workspaceId FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE c.id=?').get(callId) as { workspaceId?: number } | undefined)?.workspaceId;
}
function runtimeResolution(db: Db, row: GraphRow, evidence: Record<string, unknown>, vars: Record<string, string> | undefined): { row: GraphRow; evidence: Record<string, unknown>; target?: OperationTarget; unresolvedReason?: string } {
  if (!isRemoteRuntimeCandidate(row, evidence, vars))
    return { row, evidence, unresolvedReason: row.unresolved_reason };
  const nextEvidence = evidenceWithRuntimeVariables(evidence, vars);
  const servicePath = typeof nextEvidence.servicePath === 'string' ? nextEvidence.servicePath : undefined;
  const operationPath = typeof nextEvidence.operationPath === 'string' ? nextEvidence.operationPath : undefined;
  const alias = typeof nextEvidence.serviceAliasExpr === 'string' ? nextEvidence.serviceAliasExpr : typeof nextEvidence.serviceAlias === 'string' ? nextEvidence.serviceAlias : undefined;
  const destination = typeof nextEvidence.destination === 'string' ? nextEvidence.destination : undefined;
  const resolution = resolveOperation(db, { servicePath, operationPath, alias, destination, hasExplicitOverride: true, isDynamic: true }, workspaceIdForCall(db, row.from_id));
  nextEvidence.runtimeResolutionStatus = resolution.status;
  nextEvidence.runtimeResolutionReasons = resolution.reasons;
  if (resolution.target) {
    nextEvidence.runtimeResolvedCandidate = resolution.target;
    return { row: { ...row, to_kind: 'operation', to_id: String(resolution.target.operationId), unresolved_reason: undefined, confidence: Math.max(0, Math.min(1, resolution.target.score)) }, evidence: nextEvidence, target: resolution.target };
  }
  const unresolvedReason = resolution.status === 'dynamic' ? `Dynamic target is missing runtime variables: ${resolution.reasons.join(', ')}` : resolution.status === 'ambiguous' ? 'Ambiguous runtime operation candidates' : 'No runtime operation candidate matched substituted service and operation path';
  return { row, evidence: nextEvidence, unresolvedReason };
}
function edgeTarget(row: GraphRow, evidence: Record<string, unknown>): string {
  const runtimeCandidate = evidence.runtimeResolvedCandidate as
    | Candidate
    | undefined;
  if (runtimeCandidate?.servicePath && runtimeCandidate.operationPath)
    return `${runtimeCandidate.servicePath}${runtimeCandidate.operationPath}`;
  const servicePath =
    typeof evidence.servicePath === 'string' ? evidence.servicePath : undefined;
  const operationPath =
    typeof evidence.operationPath === 'string'
      ? evidence.operationPath
      : undefined;
  const targetOperation =
    typeof evidence.targetOperation === 'string'
      ? evidence.targetOperation
      : undefined;
  const targetRepo =
    typeof evidence.targetRepo === 'string' ? evidence.targetRepo : '';
  return servicePath && operationPath
    ? `${servicePath}${operationPath}`
    : targetOperation
      ? `${targetRepo}:${targetOperation}`
      : row.to_id;
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
  },
): TraceResult {
  const scope = startScope(db, start);
  const diagnostics = db
    .prepare(
      'SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics WHERE (? IS NULL OR repo_id=?)',
    )
    .all(scope.repo?.id, scope.repo?.id) as Array<Record<string, unknown>>;
  const stale = db.prepare('SELECT name,graph_stale_reason reason FROM repositories WHERE graph_stale_reason IS NOT NULL AND (? IS NULL OR id=?)').all(scope.repo?.id, scope.repo?.id) as Array<{ name?: string; reason?: string }>;
  for (const row of stale)
    diagnostics.unshift({ severity: 'warning', code: 'graph_stale', message: `Graph is stale for ${row.name ?? 'repository'}: ${row.reason ?? 'facts_changed'}. Run service-flow link.` });
  if (!scope.selectorMatched)
    diagnostics.unshift({
      severity: 'warning',
      code: 'trace_start_not_found',
      message: start.servicePath && !start.operation && !start.operationPath && !start.handler ? 'Service-only trace requires --operation or --path and will not broaden to the whole workspace' : 'No handler source matched the requested trace start selector',
    });
  const maxDepth = positiveDepth(options.depth);
  const edges: TraceEdge[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const queue: Array<{ repoId?: number; files?: Set<string>; symbolIds?: Set<number>; depth: number }> =
    scope.selectorMatched
      ? [{ repoId: scope.repo?.id, files: scope.sourceFiles, symbolIds: scope.symbolIds, depth: 1 }]
      : [];
  if (start.servicePath && (start.operation ?? start.operationPath)) {
    const startOperation = normalizeOperation(start.operation ?? start.operationPath);
    const startRows = db.prepare(`SELECT o.id operationId,r.name repoName,s.service_path servicePath,o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,o.source_line sourceLine FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE (? IS NULL OR s.repo_id=?) AND s.service_path=? AND (o.operation_path=? OR o.operation_name=?) ORDER BY r.name,o.id LIMIT 2`).all(scope.repo?.id, scope.repo?.id, start.servicePath, startOperation, startOperation) as Array<Record<string, unknown>>;
    if (!scope.repo && startRows.length > 1) diagnostics.unshift({ severity: 'warning', code: 'trace_start_ambiguous', message: 'Service/path trace start matched multiple repositories; add --repo to disambiguate', candidates: startRows });
    const row = startRows.length === 1 ? startRows[0] : undefined;
    if (row?.operationId !== undefined) {
      const opId = String(row.operationId);
      const op = operationNode(db, opId);
      const impl = implementationScope(db, opId);
      if (op) nodes.set(String(op.id), op);
      if (impl.edge) {
        const implEvidence = JSON.parse(String(impl.edge.evidence_json || '{}')) as Record<string, unknown>;
        const handlerNode = impl.edge.status === 'resolved' ? handlerMethodNode(db, impl.edge.to_id) : undefined;
        if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
        edges.push({ step: 1, type: 'operation_implemented_by_handler', from: op?.label ? String(op.label) : `${start.servicePath}/${startOperation ?? ''}`, to: handlerNode?.label ? String(handlerNode.label) : `${impl.edge.to_kind}:${impl.edge.to_id}`, evidence: implEvidence, confidence: Number(impl.edge.confidence ?? 0), unresolvedReason: impl.edge.status === 'resolved' ? undefined : String(impl.edge.unresolved_reason ?? impl.edge.status) });
      }
    }
  }
  const seenScopes = new Set<string>();
  const seenEdges = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;
    const key = `${current.repoId ?? '*'}:${[...(current.symbolIds ?? new Set(['*']))].sort().join(',')}:${[...(current.files ?? new Set(['*']))].sort().join(',')}`;
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

    if (current.symbolIds && current.symbolIds.size > 0 && current.depth < maxDepth) {
      const symbolRows = db.prepare(`SELECT sc.*,s.repo_id calleeRepoId,s.source_file calleeFile FROM symbol_calls sc LEFT JOIN symbols s ON s.id=sc.callee_symbol_id WHERE sc.caller_symbol_id IN (${[...current.symbolIds].map(() => '?').join(',')}) ORDER BY sc.source_file,sc.source_line`).all(...current.symbolIds) as Array<Record<string, unknown>>;
      for (const symbolCall of symbolRows) {
        if (!symbolCall.callee_symbol_id) continue;
        const nextSymbols = new Set([Number(symbolCall.callee_symbol_id)]);
        const nextFiles = new Set([String(symbolCall.calleeFile)]);
        const nextRepoId = Number(symbolCall.calleeRepoId);
        const nextKey = `${nextRepoId}:${[...nextSymbols].join(',')}:${[...nextFiles].join(',')}`;
        edges.push({ step: current.depth, type: 'local_symbol_call', from: String(symbolCall.callee_expression), to: `symbol:${String(symbolCall.callee_symbol_id)}`, evidence: JSON.parse(String(symbolCall.evidence_json || '{}')) as Record<string, unknown>, confidence: Number(symbolCall.confidence ?? 0.8), unresolvedReason: symbolCall.unresolved_reason ? String(symbolCall.unresolved_reason) : undefined });
        if (seenScopes.has(nextKey)) edges.push({ step: current.depth, type: 'cycle', from: String(symbolCall.callee_expression), to: nextKey, evidence: { cycle: true, symbolCallId: symbolCall.id }, confidence: 1, unresolvedReason: 'Cycle detected; downstream symbol already visited' });
        else queue.push({ repoId: nextRepoId, files: nextFiles, symbolIds: nextSymbols, depth: current.depth + 1 });
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
      const graphRows = graph.get(Number(call.id)) ?? [];
      for (const row of graphRows) {
        if (seenEdges.has(Number(row.id))) continue;
        seenEdges.add(Number(row.id));
        const rawEvidence = JSON.parse(
          String(row.evidence_json || '{}'),
        ) as Record<string, unknown>;
        const effective = runtimeResolution(db, row, rawEvidence, options.vars);
        const evidence = effective.evidence;
        const effectiveRow = effective.row;
        const targetNode = `${effectiveRow.to_kind}:${effectiveRow.to_id}`;
        const opNode = effectiveRow.to_kind === 'operation' ? operationNode(db, effectiveRow.to_id) : undefined;
        nodes.set(targetNode, opNode ?? {
          id: targetNode,
          kind: effectiveRow.to_kind,
          label: effectiveRow.to_id,
        });
        const to = edgeTarget(effectiveRow, evidence);
        edges.push({
          step: current.depth,
          type: String(call.call_type),
          from: `${call.repoName}:${call.source_file}:${call.source_line}`,
          to,
          evidence,
          confidence: Number(effectiveRow.confidence ?? call.confidence),
          unresolvedReason: effective.unresolvedReason,
        });
        if (effectiveRow.to_kind === 'operation') {
          const implementation = implementationScope(db, effectiveRow.to_id);
          if (implementation.edge) {
            const implEvidence = JSON.parse(String(implementation.edge.evidence_json || '{}')) as Record<string, unknown>;
            const handlerNode = implementation.edge.status === 'resolved' ? handlerMethodNode(db, implementation.edge.to_id) : undefined;
            const implTo = handlerNode?.label ? String(handlerNode.label) : `${implementation.edge.to_kind}:${implementation.edge.to_id}`;
            if (handlerNode) nodes.set(String(handlerNode.id), handlerNode);
            edges.push({
              step: current.depth,
              type: 'operation_implemented_by_handler',
              from: to,
              to: implTo,
              evidence: implEvidence,
              confidence: Number(implementation.edge.confidence ?? 0),
              unresolvedReason: implementation.edge.status === 'resolved' ? undefined : String(implementation.edge.unresolved_reason ?? implementation.edge.status),
            });
          }
          if (current.depth >= maxDepth) continue;
          const files = implementation.files.size > 0 ? implementation.files : handlerFilesForOperation(db, effectiveRow.to_id);
          const symbolIds = implementation.symbolId ? new Set([implementation.symbolId]) : undefined;
          if (implementation.edge?.status === 'resolved' && files.size > 0) {
            const targetRepoId = implementation.repoId ?? (db
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
  return { start, nodes: [...nodes.values()], edges, diagnostics };
}
