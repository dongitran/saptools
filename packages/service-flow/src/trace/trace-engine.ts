import type { Db } from '../db/connection.js';
import type { TraceEdge, TraceResult, TraceStart } from '../types.js';

interface RepoRef { id: number; name: string }
interface StartScope { repo?: RepoRef; sourceFiles?: Set<string>; selectorMatched: boolean }
interface CallRow extends Record<string, unknown> { id: number; repo_id: number; repoName: string; source_file: string; source_line: number; call_type: string; confidence: number }
interface GraphRow extends Record<string, unknown> { edge_type: string; from_id: string; to_kind: string; to_id: string; confidence: number; evidence_json: string; unresolved_reason?: string }

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}
function positiveDepth(value: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25; }
function sourceFilesForStart(db: Db, repoId: number | undefined, start: TraceStart): Set<string> | undefined {
  const handler = start.handler;
  const operation = normalizeOperation(start.operation ?? start.operationPath);
  if (!handler && !operation) return undefined;
  const rows = db.prepare(`SELECT DISTINCT hc.source_file sourceFile
       FROM handler_classes hc LEFT JOIN handler_methods hm ON hm.handler_class_id=hc.id
       WHERE (? IS NULL OR hc.repo_id=?) AND (? IS NULL OR hc.class_name=? OR hm.method_name=?)
         AND (? IS NULL OR hm.decorator_value=? OR hm.method_name=?)`).all(repoId, repoId, handler, handler, handler, operation, operation, operation) as Array<{ sourceFile?: string }>;
  if (rows.length === 0) return undefined;
  return new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]);
}
function startScope(db: Db, start: TraceStart): StartScope {
  const repo = start.repo ? (db.prepare('SELECT id,name FROM repositories WHERE name=? OR package_name=?').get(start.repo, start.repo) as RepoRef | undefined) : undefined;
  if (start.repo && !repo) return { repo, selectorMatched: false };
  const sourceFiles = sourceFilesForStart(db, repo?.id, start);
  const hasSelector = Boolean(start.handler ?? start.operation ?? start.operationPath);
  return { repo, sourceFiles, selectorMatched: !hasSelector || sourceFiles !== undefined };
}
function handlerFilesForOperation(db: Db, operationId: string): Set<string> {
  const op = db.prepare(`SELECT o.operation_name operationName,o.operation_path operationPath,s.repo_id repoId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id WHERE o.id=?`).get(operationId) as { operationName?: string; operationPath?: string; repoId?: number } | undefined;
  if (!op) return new Set();
  const operation = normalizeOperation(op.operationPath ?? op.operationName);
  const rows = db.prepare(`SELECT DISTINCT hc.source_file sourceFile FROM handler_classes hc
    JOIN handler_methods hm ON hm.handler_class_id=hc.id
    WHERE hc.repo_id=? AND (hm.decorator_value=? OR hm.method_name=? OR hm.decorator_value=?)`).all(op.repoId, operation, operation, op.operationName) as Array<{ sourceFile?: string }>;
  return new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]);
}
function includeCall(type: string, options: { includeExternal?: boolean; includeDb?: boolean; includeAsync?: boolean }): boolean {
  if (!options.includeDb && type === 'local_db_query') return false;
  if (!options.includeExternal && type === 'external_http') return false;
  if (!options.includeAsync && type.startsWith('async_')) return false;
  return true;
}
function graphForCalls(db: Db, callIds: number[]): Map<number, GraphRow[]> {
  const map = new Map<number, GraphRow[]>();
  if (callIds.length === 0) return map;
  const rows = db.prepare(`SELECT * FROM graph_edges WHERE from_kind='call' AND from_id IN (${callIds.map(() => '?').join(',')}) ORDER BY id`).all(...callIds) as GraphRow[];
  for (const row of rows) {
    const id = Number(row.from_id);
    map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}
export function trace(db: Db, start: TraceStart, options: { depth: number; vars?: Record<string, string>; includeExternal?: boolean; includeDb?: boolean; includeAsync?: boolean }): TraceResult {
  const scope = startScope(db, start);
  const diagnostics = db.prepare('SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics WHERE (? IS NULL OR repo_id=?)').all(scope.repo?.id, scope.repo?.id) as Array<Record<string, unknown>>;
  if (!scope.selectorMatched) diagnostics.unshift({ severity: 'warning', code: 'trace_start_not_found', message: 'No handler source matched the requested trace start selector' });
  const maxDepth = positiveDepth(options.depth);
  const edges: TraceEdge[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const queue: Array<{ repoId?: number; files?: Set<string>; depth: number }> = scope.selectorMatched ? [{ repoId: scope.repo?.id, files: scope.sourceFiles, depth: 1 }] : [];
  const seenScopes = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > maxDepth) continue;
    const key = `${current.repoId ?? '*'}:${[...(current.files ?? new Set(['*']))].sort().join(',')}:${current.depth}`;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    const calls = db.prepare(`SELECT c.*,r.name repoName FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id WHERE (? IS NULL OR c.repo_id=?) ORDER BY c.source_file,c.source_line`).all(current.repoId, current.repoId) as CallRow[];
    const filtered = calls.filter((c) => (!current.files || current.files.has(String(c.source_file))) && includeCall(String(c.call_type), options));
    const graph = graphForCalls(db, filtered.map((c) => Number(c.id)));
    for (const call of filtered) {
      const callNode = `call:${call.id}`;
      nodes.set(callNode, { id: callNode, kind: 'outbound_call', repo: call.repoName, file: call.source_file, line: call.source_line, callType: call.call_type });
      const graphRows = graph.get(Number(call.id)) ?? [];
      for (const row of graphRows) {
        const evidence = JSON.parse(String(row.evidence_json || '{}')) as Record<string, unknown>;
        const targetNode = `${row.to_kind}:${row.to_id}`;
        nodes.set(targetNode, { id: targetNode, kind: row.to_kind, label: row.to_id, ...evidence });
        const servicePath = typeof evidence.servicePath === 'string' ? evidence.servicePath : undefined;
        const operationPath = typeof evidence.operationPath === 'string' ? evidence.operationPath : undefined;
        const targetOperation = typeof evidence.targetOperation === 'string' ? evidence.targetOperation : undefined;
        const targetRepo = typeof evidence.targetRepo === 'string' ? evidence.targetRepo : '';
        const to = servicePath && operationPath ? `${servicePath}${operationPath}` : targetOperation ? `${targetRepo}:${targetOperation}` : row.to_id;
        edges.push({ step: current.depth, type: String(call.call_type), from: `${call.repoName}:${call.source_file}`, to, evidence, confidence: Number(row.confidence ?? call.confidence), unresolvedReason: row.unresolved_reason });
        if (row.to_kind === 'operation' && current.depth < maxDepth) {
          const files = handlerFilesForOperation(db, row.to_id);
          if (files.size > 0) queue.push({ files, depth: current.depth + 1 });
        }
      }
    }
  }
  return { start, nodes: [...nodes.values()], edges, diagnostics };
}
