import type { Db } from '../db/connection.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { resolveOperation } from './service-resolver.js';
import { linkHelperPackages } from './helper-package-linker.js';
export function linkWorkspace(
  db: Db,
  workspaceId: number,
  vars: Record<string, string> = {},
): { edgeCount: number; unresolvedCount: number; resolvedCount: number; ambiguousCount: number; dynamicCount: number; terminalCount: number } {
  return db.transaction(() => {
  db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
  let edges = linkHelperPackages(db, workspaceId);
  let unresolved = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db
    .prepare(
      `SELECT c.*,r.name repoName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,b.helper_chain_json helperChainJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE r.workspace_id=?`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  for (const call of calls) {
    const callType = String(call.call_type);
    const op = applyVariables(String(call.operation_path_expr ?? ''), vars);
    const servicePath = applyVariables(
      (call.servicePathExpr as string | undefined) ??
        (call.requireServicePath as string | undefined),
      vars,
    );
    const destination =
      (call.destinationExpr as string | undefined) ??
      (call.requireDestination as string | undefined);
    const isDynamic = Boolean(Number(call.isDynamic ?? 0));
    const resolution = callType.startsWith('remote')
      ? resolveOperation(
          db,
          {
            servicePath,
            operationPath: op,
            alias: applyVariables((call.aliasExpr as string | undefined) ?? (call.alias as string | undefined), vars),
            destination: applyVariables(destination, vars),
            isDynamic,
            hasExplicitOverride: Object.keys(vars).length > 0,
          },
          workspaceId,
        )
      : { status: 'unresolved' as const, candidates: [], reasons: [] };
    const target = resolution.target;
    const evidence = {
      sourceFile: call.source_file,
      sourceLine: call.source_line,
      file: call.source_file,
      line: call.source_line,
      repo: call.repoName,
      serviceAlias: call.alias,
      serviceAliasExpr: call.aliasExpr,
      destination: applyVariables(destination, vars),
      servicePath,
      operationPath: op,
      targetRepo: target?.repoName,
      targetOperation: target?.operationName,
      helperChain: call.helperChainJson
        ? (JSON.parse(String(call.helperChainJson)) as unknown)
        : undefined,
      candidates: resolution.candidates,
      candidateCount: resolution.candidates.length,
      resolutionStatus: resolution.status,
      resolutionReasons: resolution.reasons,
    };
    if (target) {
      db.prepare(
        'INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        workspaceId,
        'REMOTE_CALL_RESOLVES_TO_OPERATION',
        'resolved',
        'call',
        String(call.id),
        'operation',
        String(target.operationId),
        target.score,
        JSON.stringify(evidence),
        isDynamic ? 1 : 0,
      );
      edges += 1;
      resolvedCount += 1;
    } else {
      const edgeType =
        callType === 'local_db_query'
          ? 'HANDLER_RUNS_DB_QUERY'
          : callType === 'external_http'
            ? 'HANDLER_CALLS_EXTERNAL_HTTP'
            : callType === 'async_emit'
              ? 'HANDLER_EMITS_EVENT'
              : callType === 'async_subscribe'
                ? 'EVENT_CONSUMED_BY_HANDLER'
                : resolution.status === 'dynamic'
                  ? 'DYNAMIC_EDGE_CANDIDATE'
                  : 'UNRESOLVED_EDGE';
      const status = edgeType === 'DYNAMIC_EDGE_CANDIDATE' ? 'dynamic' : resolution.status === 'ambiguous' ? 'ambiguous' : edgeType === 'UNRESOLVED_EDGE' ? 'unresolved' : 'terminal';
      const unresolvedReason = status === 'terminal' ? null : String(
          call.unresolved_reason ??
            (resolution.status === 'ambiguous'
              ? 'Ambiguous operation candidates require a strong service signal'
              : resolution.status === 'dynamic'
                ? `Dynamic target requires runtime variable overrides: ${(resolution.reasons.length ? resolution.reasons : ['missing runtime variables']).join(', ')}`
                : 'No indexed target operation matched'),
        );
      db.prepare(
        'INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        workspaceId,
        edgeType,
        status,
        'call',
        String(call.id),
        callType.startsWith('async_') ? 'event' : 'external',
        String(call.event_name_expr ?? call.query_entity ?? op ?? call.id),
        Number(call.confidence ?? 0.2),
        JSON.stringify(evidence),
        isDynamic || resolution.status === 'dynamic' ? 1 : 0,
        unresolvedReason,
      );
      edges += 1;
      unresolved += status === 'unresolved' ? 1 : 0;
      ambiguousCount += status === 'ambiguous' ? 1 : 0;
      dynamicCount += status === 'dynamic' ? 1 : 0;
      terminalCount += status === 'terminal' ? 1 : 0;
    }
  }
  return { edgeCount: edges, unresolvedCount: unresolved, resolvedCount, ambiguousCount, dynamicCount, terminalCount };
  });
}
