import type { Db } from './connection.js';
import type {
  CdsRequire,
  CdsServiceFact,
  HandlerClassFact,
  HandlerRegistrationFact,
  OutboundCallFact,
  ServiceBindingFact,
  ExecutableSymbolFact,
  SymbolCallFact,
} from '../types.js';
export interface RepoRow {
  id: number;
  name: string;
  absolute_path: string;
  relative_path: string;
  package_name: string | null;
  package_version: string | null;
  dependencies_json: string;
  kind: string;
  fingerprint?: string | null;
  fact_generation?: number;
  graph_generation?: number;
  graph_stale_reason?: string | null;
  fact_analyzer_version?: string | null;
}
export interface WorkspaceRow {
  id: number;
  root_path: string;
  db_path: string;
}
export function upsertWorkspace(
  db: Db,
  rootPath: string,
  dbPath: string,
): number {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO workspaces(root_path,db_path,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(root_path) DO UPDATE SET db_path=excluded.db_path,updated_at=excluded.updated_at',
  ).run(rootPath, dbPath, now, now);
  return Number(
    db.prepare('SELECT id FROM workspaces WHERE root_path=?').get(rootPath)?.id,
  );
}
export function getWorkspace(
  db: Db,
  rootPath: string,
): WorkspaceRow | undefined {
  return db
    .prepare('SELECT * FROM workspaces WHERE root_path=?')
    .get(rootPath) as WorkspaceRow | undefined;
}
export function upsertRepository(
  db: Db,
  workspaceId: number,
  r: {
    name: string;
    absolutePath: string;
    relativePath: string;
    isGitRepo: boolean;
    packageName?: string;
    packageVersion?: string;
    dependencies?: Record<string, string>;
    kind?: string;
  },
): number {
  db.prepare(
    `INSERT INTO repositories(workspace_id,name,absolute_path,relative_path,package_name,package_version,dependencies_json,kind,is_git_repo) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,absolute_path) DO UPDATE SET name=excluded.name,relative_path=excluded.relative_path,package_name=excluded.package_name,package_version=excluded.package_version,dependencies_json=excluded.dependencies_json,kind=excluded.kind`,
  ).run(
    workspaceId,
    r.name,
    r.absolutePath,
    r.relativePath,
    r.packageName,
    r.packageVersion,
    JSON.stringify(r.dependencies ?? {}),
    r.kind ?? 'unknown',
    r.isGitRepo ? 1 : 0,
  );
  return Number(
    db
      .prepare(
        'SELECT id FROM repositories WHERE workspace_id=? AND absolute_path=?',
      )
      .get(workspaceId, r.absolutePath)?.id,
  );
}
export function listRepositories(db: Db): RepoRow[] {
  return db
    .prepare('SELECT * FROM repositories ORDER BY name')
    .all() as unknown as RepoRow[];
}
export function repoByName(db: Db, name: string): RepoRow | undefined {
  return db
    .prepare('SELECT * FROM repositories WHERE name=? OR package_name=?')
    .get(name, name) as RepoRow | undefined;
}
export function clearRepoFacts(db: Db, repoId: number): void {
  for (const t of [
    'cds_requires',
    'cds_services',
    'handler_classes',
    'outbound_calls',
    'symbol_calls',
    'handler_registrations',
    'service_bindings',
    'symbols',
    'diagnostics',
    'files',
  ])
    db.prepare(`DELETE FROM ${t} WHERE repo_id=?`).run(repoId);
  db.prepare('DELETE FROM search_index WHERE repo=?').run(String(repoId));
}
export function insertRequires(
  db: Db,
  repoId: number,
  rows: CdsRequire[],
): void {
  const stmt = db.prepare(
    'INSERT INTO cds_requires(repo_id,alias,kind,model,destination,service_path,request_timeout,raw_json) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const r of rows)
    stmt.run(
      repoId,
      r.alias,
      r.kind,
      r.model,
      r.destination,
      r.servicePath,
      r.requestTimeout,
      r.rawJson,
    );
}
export function insertService(
  db: Db,
  repoId: number,
  s: CdsServiceFact,
): number {
  const id = Number(
    db
      .prepare(
        'INSERT INTO cds_services(repo_id,namespace,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(?,?,?,?,?,?,?,?) RETURNING id',
      )
      .get(
        repoId,
        s.namespace,
        s.serviceName,
        s.qualifiedName,
        s.servicePath,
        s.isExtend ? 1 : 0,
        s.sourceFile,
        s.sourceLine,
      )?.id,
  );
  const stmt = db.prepare(
    'INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line) VALUES(?,?,?,?,?,?,?,?)',
  );
  db.prepare(
    'INSERT INTO search_index(kind,name,path,repo) VALUES(?,?,?,?)',
  ).run('service', s.qualifiedName, s.servicePath, String(repoId));
  for (const o of s.operations)
    stmt.run(
      id,
      o.operationType,
      o.operationName,
      o.operationPath,
      o.paramsJson,
      o.returnType,
      o.sourceFile,
      o.sourceLine,
    );
  const search = db.prepare(
    'INSERT INTO search_index(kind,name,path,repo) VALUES(?,?,?,?)',
  );
  for (const o of s.operations)
    search.run('operation', o.operationName, o.operationPath, String(repoId));
  return id;
}
export function insertHandler(
  db: Db,
  repoId: number,
  h: HandlerClassFact,
): number {
  const sid = Number(
    db
      .prepare(
        'INSERT INTO symbols(repo_id,kind,name,qualified_name,exported,start_line,end_line) VALUES(?,?,?,?,?,?,?) RETURNING id',
      )
      .get(
        repoId,
        'class',
        h.className,
        h.className,
        1,
        h.sourceLine,
        h.sourceLine,
      )?.id,
  );
  const hid = Number(
    db
      .prepare(
        'INSERT INTO handler_classes(repo_id,symbol_id,class_name,source_file,source_line) VALUES(?,?,?,?,?) RETURNING id',
      )
      .get(repoId, sid, h.className, h.sourceFile, h.sourceLine)?.id,
  );
  const stmt = db.prepare(
    'INSERT INTO handler_methods(handler_class_id,method_name,decorator_kind,decorator_value,decorator_raw_expression,source_file,source_line) VALUES(?,?,?,?,?,?,?)',
  );
  for (const m of h.methods)
    stmt.run(
      hid,
      m.methodName,
      m.decoratorKind,
      m.decoratorValue,
      m.decoratorRawExpression,
      m.sourceFile,
      m.sourceLine,
    );
  return hid;
}
export function insertRegistrations(
  db: Db,
  repoId: number,
  rows: HandlerRegistrationFact[],
): void {
  const stmt = db.prepare(
    'INSERT INTO handler_registrations(repo_id,handler_class_id,class_name,import_source,registration_file,registration_line,registration_kind,confidence) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const r of rows) {
    const handlerClass = r.className
      ? (db
          .prepare(
            'SELECT id FROM handler_classes WHERE repo_id=? AND class_name=? ORDER BY id',
          )
          .all(repoId, r.className) as Array<{ id: number }>)
      : [];
    stmt.run(
      repoId,
      handlerClass.length === 1 ? handlerClass[0]?.id : null,
      r.className,
      r.importSource,
      r.registrationFile,
      r.registrationLine,
      r.registrationKind,
      r.confidence,
    );
  }
}
export function insertBindings(
  db: Db,
  repoId: number,
  rows: ServiceBindingFact[],
): void {
  const stmt = db.prepare(
    'INSERT INTO service_bindings(repo_id,variable_name,alias,alias_expr,destination_expr,service_path_expr,is_dynamic,placeholders_json,source_file,source_line,helper_chain_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const r of rows)
    stmt.run(
      repoId,
      r.variableName,
      r.alias,
      r.aliasExpr,
      r.destinationExpr,
      r.servicePathExpr,
      r.isDynamic ? 1 : 0,
      JSON.stringify(r.placeholders),
      r.sourceFile,
      r.sourceLine,
      r.helperChain ? JSON.stringify(r.helperChain) : null,
    );
}
export function insertExecutableSymbols(db: Db, repoId: number, rows: ExecutableSymbolFact[]): void {
  const stmt = db.prepare('INSERT INTO symbols(repo_id,file_id,kind,name,qualified_name,exported,start_line,end_line,start_offset,end_offset,source_file,exported_name,evidence_json) VALUES(?,(SELECT id FROM files WHERE repo_id=? AND relative_path=?),?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) stmt.run(repoId, repoId, r.sourceFile, r.kind, r.localName, r.qualifiedName, r.exported ? 1 : 0, r.startLine, r.endLine, r.startOffset, r.endOffset, r.sourceFile, r.exportedName, r.importExportEvidence ? JSON.stringify(r.importExportEvidence) : null);
}
export function insertSymbolCalls(db: Db, repoId: number, rows: SymbolCallFact[]): void {
  const callerStmt = db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1');
  const insertStmt = db.prepare('INSERT INTO symbol_calls(repo_id,caller_symbol_id,callee_symbol_id,callee_expression,import_source,source_file,source_line,status,confidence,evidence_json,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    const caller = callerStmt.get(repoId, r.sourceFile, r.callerQualifiedName) as { id?: number } | undefined;
    const target = resolveSymbolCallTarget(db, repoId, r);
    insertStmt.run(repoId, caller?.id, target.id, r.calleeExpression, r.importSource, r.sourceFile, r.sourceLine, target.status, 0.8, JSON.stringify({ ...r.evidence, candidateStrategy: target.strategy, candidateCount: target.candidateCount }), target.reason);
  }
}
function isRelativeImportedSymbolCall(r: SymbolCallFact): boolean {
  return Boolean(r.importSource?.startsWith('.'));
}
function resolveSymbolCallTarget(db: Db, repoId: number, r: SymbolCallFact): { id: number | null; status: string; reason: string | null; strategy: string; candidateCount: number } {
  const evidence = r.evidence as { relation?: unknown };
  const localRows = db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND (name=? OR qualified_name=?) ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName) as Array<{ id: number }>;
  if (localRows.length === 1) return { id: localRows[0]?.id ?? null, status: 'resolved', reason: null, strategy: 'same_file_exact', candidateCount: 1 };
  if (localRows.length > 1) return { id: null, status: 'ambiguous', reason: 'Multiple same-file symbol targets matched exactly', strategy: 'same_file_exact', candidateCount: localRows.length };
  if (evidence.relation === 'class_instance_method' && isRelativeImportedSymbolCall(r)) {
    const classRows = db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file<>? AND qualified_name=? ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName) as Array<{ id: number }>;
    if (classRows.length === 1) return { id: classRows[0]?.id ?? null, status: 'resolved', reason: null, strategy: 'relative_import_class_instance_method', candidateCount: 1 };
    if (classRows.length > 1) return { id: null, status: 'ambiguous', reason: 'Multiple relative class instance method targets matched exactly', strategy: 'relative_import_class_instance_method', candidateCount: classRows.length };
  }
  const rows = db.prepare('SELECT id,kind,evidence_json evidenceJson FROM symbols WHERE repo_id=? AND source_file<>? AND exported=1 AND (exported_name=? OR name=? OR qualified_name=?) ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName, r.calleeLocalName) as Array<{ id: number; kind?: string; evidenceJson?: string | null }>;
  if (evidence.relation === 'relative_import_proxy_member' && rows.length > 1) {
    const objectMapRows = rows.filter((row) => String(row.evidenceJson ?? '').includes('exported_object_shorthand') || String(row.evidenceJson ?? '').includes('exported_object_literal'));
    if (objectMapRows.length > 0) {
      const concrete = rows.find((row) => row.kind !== 'object_alias') ?? objectMapRows[0];
      return { id: concrete?.id ?? null, status: 'resolved', reason: null, strategy: 'proxy_member_exported_object_map', candidateCount: rows.length };
    }
    return { id: null, status: 'ambiguous', reason: 'Proxy member target requires explicit factory/module/type evidence; global member name is ambiguous', strategy: 'proxy_member_no_global_name_fallback', candidateCount: rows.length };
  }
  if (rows.length === 1) return { id: rows[0]?.id ?? null, status: 'resolved', reason: null, strategy: evidence.relation === 'relative_import_proxy_member' ? 'proxy_member_unique_exported_candidate' : 'relative_import_exported_exact', candidateCount: 1 };
  if (rows.length > 1) return { id: null, status: 'ambiguous', reason: 'Multiple exported symbol targets matched exactly', strategy: 'exported_exact', candidateCount: rows.length };
  return { id: null, status: 'unresolved', reason: 'No local symbol target matched exactly', strategy: evidence.relation === 'relative_import_proxy_member' ? 'proxy_member_no_global_name_fallback' : 'exact_symbol_match', candidateCount: 0 };
}
export function insertCalls(
  db: Db,
  repoId: number,
  rows: OutboundCallFact[],
): void {
  const stmt = db.prepare(
    'INSERT INTO outbound_calls(repo_id,source_symbol_id,call_type,method,operation_path_expr,query_entity,event_name_expr,payload_summary,source_file,source_line,confidence,unresolved_reason,local_service_name,local_service_lookup,alias_chain_json,evidence_json,external_target_kind,external_target_id,external_target_label,external_target_dynamic,service_binding_id) VALUES(?,COALESCE((SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1),(SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND start_line<=? AND end_line>=? ORDER BY (end_line-start_line),id LIMIT 1)),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT id FROM service_bindings WHERE repo_id=? AND variable_name=? AND source_file=? ORDER BY CASE WHEN source_line<=? THEN 0 ELSE 1 END, ABS(source_line-?) ASC, id DESC LIMIT 1))',
  );
  for (const r of rows)
    stmt.run(
      repoId,
      repoId,
      r.sourceFile,
      r.sourceSymbolQualifiedName,
      repoId,
      r.sourceFile,
      r.sourceLine,
      r.sourceLine,
      r.callType,
      r.method,
      r.operationPathExpr,
      r.queryEntity,
      r.eventNameExpr,
      r.payloadSummary,
      r.sourceFile,
      r.sourceLine,
      r.confidence,
      r.unresolvedReason,
      r.localServiceName,
      r.localServiceLookup,
      r.aliasChain ? JSON.stringify(r.aliasChain) : null,
      r.evidence ? JSON.stringify(r.evidence) : null,
      r.externalTarget?.kind ?? null,
      r.externalTarget?.stableId ?? null,
      r.externalTarget?.label ?? null,
      r.externalTarget?.dynamic ? 1 : 0,
      repoId,
      r.serviceVariableName,
      r.sourceFile,
      r.sourceLine,
      r.sourceLine,
    );
}
