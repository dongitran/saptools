import type { Db } from '../db/connection.js';
import type { ImplementationHint } from '../types.js';
import type { TraceGraphEdgeRow } from './012-trace-graph-lookups.js';

export interface ImplementationHintOptions {
  implementationRepo?: string;
  implementationHints?: ImplementationHint[];
}

export interface ImplementationScope {
  repoId?: number;
  files: Set<string>;
  symbolId?: number;
  edge?: TraceGraphEdgeRow;
}

interface HandlerScopeRow {
  repoId?: number;
  sourceFile?: string;
  symbolId?: number;
}

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}

function implementationEdge(
  db: Db,
  operationId: string,
): TraceGraphEdgeRow | undefined {
  return db.prepare(`SELECT * FROM graph_edges
    WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'
      AND from_kind='operation' AND from_id=?
    ORDER BY CASE status WHEN 'resolved' THEN 0
      WHEN 'ambiguous' THEN 1 ELSE 2 END,id LIMIT 1`)
    .get(operationId) as TraceGraphEdgeRow | undefined;
}

function handlerScopeRow(db: Db, methodId: string): HandlerScopeRow | undefined {
  return db.prepare(`SELECT hc.repo_id repoId,hc.source_file sourceFile,
      s.id symbolId
    FROM handler_methods hm
    JOIN handler_classes hc ON hc.id=hm.handler_class_id
    LEFT JOIN symbols s ON s.repo_id=hc.repo_id
      AND s.source_file=hc.source_file
      AND s.qualified_name=hc.class_name || '.' || hm.method_name
      AND s.start_line=hm.source_line
    WHERE hm.id=?`).get(methodId) as HandlerScopeRow | undefined;
}

export function implementationScope(
  db: Db,
  operationId: string,
): ImplementationScope {
  const edge = implementationEdge(db, operationId);
  if (!edge || edge.status !== 'resolved') return { files: new Set(), edge };
  const row = handlerScopeRow(db, edge.to_id);
  if (!row || typeof row.symbolId !== 'number')
    return { repoId: row?.repoId, files: new Set(), edge };
  return {
    repoId: row.repoId,
    files: new Set(row.sourceFile ? [row.sourceFile] : []),
    symbolId: row.symbolId,
    edge,
  };
}

export function handlerScope(
  db: Db,
  methodId: string,
): Omit<ImplementationScope, 'edge'> | undefined {
  const row = handlerScopeRow(db, methodId);
  if (!row || typeof row.symbolId !== 'number') return undefined;
  return {
    repoId: row.repoId,
    files: new Set(row.sourceFile ? [row.sourceFile] : []),
    symbolId: row.symbolId,
  };
}

export function handlerFilesForOperation(
  db: Db,
  operationId: string,
): Set<string> {
  const op = db.prepare(`SELECT o.operation_name operationName,
      o.operation_path operationPath,s.repo_id repoId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    WHERE o.id=?`).get(operationId) as {
    operationName?: string;
    operationPath?: string;
    repoId?: number;
  } | undefined;
  if (!op) return new Set();
  const operation = normalizeOperation(op.operationPath ?? op.operationName);
  const rows = handlerFileRows(db, op.repoId, operation, op.operationName);
  return new Set(rows.flatMap((row) =>
    typeof row.sourceFile === 'string' ? [row.sourceFile] : []));
}

function handlerFileRows(
  db: Db,
  repoId: number | undefined,
  operation: string | undefined,
  operationName: string | undefined,
): Array<{ sourceFile?: string }> {
  return db.prepare(`SELECT DISTINCT hc.source_file sourceFile
    FROM handler_classes hc
    JOIN handler_methods hm ON hm.handler_class_id=hc.id
    WHERE hc.repo_id=?
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.handlerKind'),
        CASE WHEN hm.decorator_kind='Event' THEN 'event'
          WHEN hm.decorator_kind IN ('Action','Func','On') THEN 'operation'
          ELSE 'unsupported' END)='operation'
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On')
          THEN 1 ELSE 0 END)=1
      AND (hm.decorator_value=? OR hm.method_name=?
        OR hm.decorator_value=?)`)
    .all(repoId, operation, operation, operationName) as Array<{
      sourceFile?: string;
    }>;
}
