import type { Db } from '../db/connection.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { findOperation } from './service-resolver.js';
import { linkHelperPackages } from './helper-package-linker.js';
export function linkWorkspace(
  db: Db,
  workspaceId: number,
  vars: Record<string, string> = {}
): { edgeCount: number; unresolvedCount: number } {
  db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
  let edges = linkHelperPackages(db, workspaceId);
  let unresolved = 0;
  const calls = db
    .prepare(
      `SELECT c.*,r.name repoName,b.alias,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias`
    )
    .all() as Array<Record<string, unknown>>;
  for (const call of calls) {
    const callType = String(call.call_type);
    const op = applyVariables(String(call.operation_path_expr ?? ''), vars);
    const servicePath = applyVariables(
      (call.servicePathExpr as string | undefined) ??
        (call.requireServicePath as string | undefined),
      vars
    );
    const target = callType.startsWith('remote')
      ? findOperation(db, servicePath, op)
      : undefined;
    const evidence = {
      sourceFile: call.source_file,
      sourceLine: call.source_line,
      serviceAlias: call.alias,
      destination: call.destinationExpr ?? call.requireDestination,
      servicePath,
      operationPath: op,
      targetRepo: target?.repoName,
      targetOperation: target?.operationName
    };
    if (target) {
      db.prepare(
        'INSERT INTO graph_edges(workspace_id,edge_type,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(
        workspaceId,
        'REMOTE_CALL_RESOLVES_TO_OPERATION',
        'call',
        String(call.id),
        'operation',
        String(target.operationId),
        call.isDynamic ? 0.6 : 0.9,
        JSON.stringify(evidence),
        call.isDynamic ? 1 : 0
      );
      edges += 1;
    } else {
      const edgeType =
        callType === 'local_db_query'
          ? 'HANDLER_RUNS_DB_QUERY'
          : callType === 'external_http'
            ? 'HANDLER_CALLS_EXTERNAL_HTTP'
            : callType === 'async_emit'
              ? 'HANDLER_EMITS_EVENT'
              : call.isDynamic
                ? 'DYNAMIC_EDGE_CANDIDATE'
                : 'UNRESOLVED_EDGE';
      db.prepare(
        'INSERT INTO graph_edges(workspace_id,edge_type,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).run(
        workspaceId,
        edgeType,
        'call',
        String(call.id),
        callType === 'async_emit' ? 'event' : 'external',
        String(call.event_name_expr ?? call.query_entity ?? op ?? call.id),
        Number(call.confidence ?? 0.2),
        JSON.stringify(evidence),
        call.isDynamic ? 1 : 0,
        String(call.unresolved_reason ?? 'No indexed target operation matched')
      );
      edges += 1;
      unresolved += edgeType === 'UNRESOLVED_EDGE' ? 1 : 0;
    }
  }
  return { edgeCount: edges, unresolvedCount: unresolved };
}
