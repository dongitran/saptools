import type { Db } from '../db/connection.js';
import type { TraceResult, TraceStart } from '../types.js';
import { applyVariables } from '../linker/dynamic-edge-resolver.js';
import { limitDepth } from './traversal.js';

interface RepoRef {
  id: number;
  name: string;
}

interface StartScope {
  repo?: RepoRef;
  sourceFiles?: Set<string>;
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
  start: TraceStart
): Set<string> | undefined {
  const handler = start.handler;
  const operation = normalizeOperation(start.operation ?? start.operationPath);
  if (!handler && !operation) return undefined;

  const rows = db
    .prepare(
      `SELECT DISTINCT hc.source_file sourceFile
       FROM handler_classes hc
       LEFT JOIN handler_methods hm ON hm.handler_class_id=hc.id
       WHERE (? IS NULL OR hc.repo_id=?)
         AND (? IS NULL OR hc.class_name=? OR hm.method_name=?)
         AND (? IS NULL OR hm.decorator_value=? OR hm.method_name=?)`
    )
    .all(repoId, repoId, handler, handler, handler, operation, operation, operation) as Array<{
    sourceFile?: string;
  }>;

  if (rows.length === 0) return undefined;
  return new Set(rows.map((row) => row.sourceFile).filter(Boolean) as string[]);
}

function startScope(db: Db, start: TraceStart): StartScope {
  const repo = start.repo
    ? (db
        .prepare(
          'SELECT id,name FROM repositories WHERE name=? OR package_name=?'
        )
        .get(start.repo, start.repo) as RepoRef | undefined)
    : undefined;
  return {
    repo,
    sourceFiles: sourceFilesForStart(db, repo?.id, start)
  };
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
  }
): TraceResult {
  const scope = startScope(db, start);
  const calls = db
    .prepare(
      `SELECT c.*,r.name repoName,b.alias,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE (? IS NULL OR c.repo_id=?) ORDER BY c.source_file,c.source_line`
    )
    .all(scope.repo?.id, scope.repo?.id) as Array<Record<string, unknown>>;
  const vars = options.vars ?? {};
  const filtered = calls.filter((c) => {
    if (scope.sourceFiles && !scope.sourceFiles.has(String(c.source_file)))
      return false;
    const type = String(c.call_type);
    if (!options.includeDb && type === 'local_db_query') return false;
    if (!options.includeExternal && type === 'external_http') return false;
    if (!options.includeAsync && type.startsWith('async_')) return false;
    return true;
  });
  const edges = filtered.map((c, index) => {
    const operation = applyVariables(
      c.operation_path_expr as string | undefined,
      vars
    );
    const servicePath = applyVariables(
      (c.servicePathExpr as string | undefined) ??
        (c.requireServicePath as string | undefined),
      vars
    );
    const type = String(c.call_type);
    const to =
      type === 'local_db_query'
        ? `Entity: ${String(c.query_entity ?? 'unknown')}`
        : type === 'async_emit'
          ? `Topic: ${String(c.event_name_expr ?? 'unknown')}`
          : type === 'async_subscribe'
            ? `Topic: ${String(c.event_name_expr ?? 'unknown')}`
            : type === 'external_http'
              ? 'External HTTP destination'
              : `${servicePath ?? ''}${operation ?? ''}` ||
                String(c.event_name_expr ?? 'unknown');
    return {
      step: index + 1,
      type: c.isDynamic ? 'dynamic_action' : type,
      from: `${String(c.repoName)}:${String(c.source_file)}`,
      to,
      evidence: {
        file: c.source_file,
        line: c.source_line,
        alias: c.alias,
        destination: c.destinationExpr ?? c.requireDestination,
        servicePath,
        operationPath: operation,
        method: c.method,
        payloadSummary: c.payload_summary
      },
      confidence: Number(c.confidence ?? 0.5),
      unresolvedReason: c.unresolved_reason as string | undefined
    };
  });
  const diagnostics = db
    .prepare(
      'SELECT severity,code,message,source_file sourceFile,source_line sourceLine FROM diagnostics WHERE (? IS NULL OR repo_id=?)'
    )
    .all(scope.repo?.id, scope.repo?.id) as Array<Record<string, unknown>>;
  return {
    start,
    nodes: [],
    edges: limitDepth(edges, positiveDepth(options.depth)),
    diagnostics
  };
}
