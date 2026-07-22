import type { Db } from './connection.js';
import type {
  CdsRequire,
  CdsServiceFact,
  HandlerClassFact,
  HandlerMethodFact,
  HandlerRegistrationFact,
  ServiceBindingFact,
  ExecutableSymbolFact,
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
export function listRepositories(db: Db, workspaceId?: number): RepoRow[] {
  return db
    .prepare('SELECT * FROM repositories WHERE (? IS NULL OR workspace_id=?) ORDER BY name,absolute_path,id')
    .all(workspaceId, workspaceId) as unknown as RepoRow[];
}
export function repoByName(
  db: Db,
  name: string,
  workspaceId?: number,
): RepoRow | undefined {
  const matches = reposByName(db, name, workspaceId);
  return matches.length === 1 ? matches[0] : undefined;
}
export function reposByName(
  db: Db,
  name: string,
  workspaceId?: number,
): RepoRow[] {
  return db
    .prepare(`SELECT * FROM repositories
      WHERE (? IS NULL OR workspace_id=?) AND (name=? OR package_name=?)
      ORDER BY name,absolute_path,id`)
    .all(workspaceId, workspaceId, name, name) as unknown as RepoRow[];
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
        'INSERT INTO cds_services(repo_id,namespace,service_name,qualified_name,service_path,is_extend,source_file,source_line,extension_local_ref,extension_imported_symbol,extension_local_alias,extension_module_specifier,extension_import_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
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
        s.extension?.localReference,
        s.extension?.importedSymbol,
        s.extension?.localAlias,
        s.extension?.moduleSpecifier,
        s.extension?.importKind,
      )?.id,
  );
  const stmt = db.prepare(
    'INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,provenance,base_operation_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
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
      o.provenance ?? 'direct',
      o.baseOperationId ?? null,
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
  const sid = insertHandlerClassSymbol(db, repoId, h);
  const hid = Number(
    db
      .prepare(
        'INSERT INTO handler_classes(repo_id,symbol_id,class_name,source_file,source_line) VALUES(?,?,?,?,?) RETURNING id',
      )
      .get(repoId, sid, h.className, h.sourceFile, h.sourceLine)?.id,
  );
  const stmt = db.prepare(
    'INSERT INTO handler_methods(handler_class_id,method_name,decorator_kind,decorator_value,decorator_raw_expression,decorator_resolution_json,source_file,source_line) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const m of h.methods)
    stmt.run(
      hid,
      m.methodName,
      m.decoratorKind,
      m.decoratorValue,
      m.decoratorRawExpression,
      JSON.stringify(canonicalHandlerMethodResolution(m)),
      m.sourceFile,
      m.sourceLine,
    );
  insertHandlerIndexDiagnostic(db, repoId, h);
  return hid;
}
function insertHandlerClassSymbol(
  db: Db,
  repoId: number,
  h: HandlerClassFact,
): number {
  const classEvidence = {
    hasHandlerDecorator: h.hasHandlerDecorator ?? false,
    classDecoratorNames: h.classDecoratorNames ?? [],
    observedDecoratorNames: h.observedDecoratorNames ?? [],
    unsupportedDecoratorNames: h.unsupportedDecoratorNames ?? [],
    unsupportedMethods: h.methods
      .filter((method) => !handlerMethodIsExecutable(method))
      .map((method) => ({
        methodName: method.methodName,
        decoratorKind: method.decoratorKind,
        sourceFile: method.sourceFile,
        sourceLine: method.sourceLine,
        reason: method.decoratorResolution.unresolvedReason,
      })),
  };
  return Number(
    db
      .prepare(
        'INSERT INTO symbols(repo_id,kind,name,qualified_name,exported,start_line,end_line,source_file,evidence_json) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
      )
      .get(
        repoId,
        'class',
        h.className,
        h.className,
        1,
        h.sourceLine,
        h.sourceLine,
        h.sourceFile,
        JSON.stringify(classEvidence),
      )?.id,
  );
}
function insertHandlerIndexDiagnostic(
  db: Db,
  repoId: number,
  h: HandlerClassFact,
): void {
  if (!h.hasHandlerDecorator) return;
  const hasExecutable = h.methods.some(handlerMethodIsExecutable);
  const unsupported = h.methods.filter((method) =>
    !handlerMethodIsExecutable(method));
  if (hasExecutable && unsupported.length === 0) return;
  const code = hasExecutable
    ? 'handler_decorators_not_indexed'
    : 'handler_methods_not_indexed';
  const names = unsupported.map((method) => method.decoratorKind).sort();
  const detail = names.length > 0
    ? ` Unsupported decorators: ${[...new Set(names)].join(', ')}.`
    : '';
  db.prepare(
    'INSERT INTO diagnostics(repo_id,severity,code,message,source_file,source_line) VALUES(?,?,?,?,?,?)',
  ).run(
    repoId,
    'warning',
    code,
    hasExecutable
      ? `Handler class ${h.className} contains methods that were not indexed.${detail}`
      : `Handler class ${h.className} has no indexed executable methods; use a supported CAP handler decorator and re-index.${detail}`,
    h.sourceFile,
    h.sourceLine,
  );
}
export function canonicalHandlerMethodResolution(
  method: HandlerMethodFact,
): HandlerMethodFact['decoratorResolution'] {
  const handlerKind = method.handlerKind
    ?? method.decoratorResolution.handlerKind
    ?? legacyHandlerKind(method.decoratorKind);
  const executable = method.executable
    ?? method.decoratorResolution.executable
    ?? (handlerKind === 'operation' || handlerKind === 'event'
      || handlerKind === 'entity_lifecycle');
  return {
    ...method.decoratorResolution,
    handlerKind,
    executable,
    lifecyclePhase: method.lifecyclePhase
      ?? method.decoratorResolution.lifecyclePhase,
    lifecycleEvent: method.lifecycleEvent
      ?? method.decoratorResolution.lifecycleEvent,
  };
}
export function handlerMethodIsExecutable(method: HandlerMethodFact): boolean {
  return canonicalHandlerMethodResolution(method).executable === true;
}
function legacyHandlerKind(kind: string): HandlerMethodFact['handlerKind'] {
  if (kind === 'Event') return 'event';
  if (['Action', 'Func', 'On'].includes(kind)) return 'operation';
  return 'unsupported_decorator';
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
    'INSERT INTO service_bindings(repo_id,symbol_id,variable_name,alias,alias_expr,destination_expr,service_path_expr,is_dynamic,placeholders_json,source_file,source_line,helper_chain_json) VALUES(?,(SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND start_line<=? AND end_line>=? ORDER BY (end_line-start_line),id LIMIT 1),?,?,?,?,?,?,?,?,?,?)',
  );
  for (const r of rows)
    stmt.run(
      repoId,
      repoId,
      r.sourceFile,
      r.sourceLine,
      r.sourceLine,
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
export { insertCalls, insertSymbolCalls } from './000-call-fact-repository.js';
