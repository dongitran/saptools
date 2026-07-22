import type { Db } from '../db/connection.js';

export interface TraceGraphEdgeRow extends Record<string, unknown> {
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

export function graphForCalls(
  db: Db,
  callIds: number[],
): Map<number, TraceGraphEdgeRow[]> {
  const map = new Map<number, TraceGraphEdgeRow[]>();
  if (callIds.length === 0) return map;
  const rows = db.prepare(`SELECT * FROM graph_edges
    WHERE from_kind='call'
      AND from_id IN (${callIds.map(() => '?').join(',')})
    ORDER BY id`).all(
    ...callIds.map(String),
  ) as TraceGraphEdgeRow[];
  for (const row of rows) {
    const id = Number(row.from_id);
    map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}

export function symbolNode(
  db: Db,
  symbolId: number,
): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT s.id symbolId,s.name symbolName,
    s.qualified_name qualifiedName,s.source_file sourceFile,
    s.start_line startLine,s.end_line endLine,r.name repoName,r.id repoId
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE s.id=?`).get(symbolId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const sourceFile = String(row.sourceFile ?? '');
  const fileName = sourceFile.split('/').at(-1) ?? sourceFile;
  return {
    id: `symbol:${symbolId}`,
    kind: 'symbol',
    label: `${fileName}:${String(row.qualifiedName ?? row.symbolName)}`,
    ...row,
  };
}

export function operationNode(
  db: Db,
  operationId: string,
): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT o.id operationId,o.operation_name operationName,
    o.operation_type operationType,o.operation_path operationPath,
    o.source_file sourceFile,o.source_line sourceLine,s.id serviceId,
    s.service_name serviceName,s.qualified_name qualifiedName,
    s.service_path servicePath,r.id repoId,r.name repoName
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(
    operationId,
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: `operation:${operationId}`,
    kind: 'operation',
    label: `${String(row.repoName)}:${String(row.servicePath)}${String(row.operationPath)}`,
    ...row,
  };
}
