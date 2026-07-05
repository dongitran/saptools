import type { Db } from '../db/connection.js';

interface ExtensionRow {
  id: number;
  repoId: number;
  serviceName: string;
  qualifiedName: string;
  sourceFile: string;
  moduleSpecifier?: string | null;
  importedSymbol?: string | null;
  importKind?: string | null;
}
interface BaseRow { id: number; repoId: number }

interface DesiredOperation { id: number; operationType: string; operationName: string; operationPath: string; paramsJson: string; returnType: string | null; sourceFile: string; sourceLine: number }
interface ExistingOperation extends DesiredOperation { baseOperationId: number | null }

export function materializeCdsExtensionOperations(db: Db, workspaceId: number): void {
  const extensions = db.prepare(`SELECT s.id,r.id repoId,s.service_name serviceName,s.qualified_name qualifiedName,s.source_file sourceFile,s.extension_module_specifier moduleSpecifier,s.extension_imported_symbol importedSymbol,s.extension_import_kind importKind
    FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND s.is_extend=1`).all(workspaceId) as unknown as ExtensionRow[];
  db.transaction(() => {
    const changedRepos = new Set<number>();
    for (const extension of extensions) {
      if (reconcileExtension(db, workspaceId, extension)) changedRepos.add(extension.repoId);
    }
    for (const repoId of changedRepos) markRepositoryDerivedFactsChanged(db, repoId);
  });
}

function reconcileExtension(db: Db, workspaceId: number, extension: ExtensionRow): boolean {
  const bases = resolveBase(db, workspaceId, extension);
  const status = bases.length === 1 ? 'resolved' : bases.length > 1 ? 'ambiguous' : 'unresolved';
  const baseId = status === 'resolved' ? bases[0]?.id ?? null : null;
  const desired = baseId === null ? [] : desiredInheritedOperations(db, extension, baseId);
  const statusChanged = updateExtensionStatus(db, extension.id, status, baseId);
  const operationChanged = reconcileInheritedOperations(db, extension, desired);
  reconcileOperationSearchRows(db, extension.repoId);
  return statusChanged || operationChanged;
}

function desiredInheritedOperations(db: Db, extension: ExtensionRow, baseId: number): DesiredOperation[] {
  return db.prepare("SELECT id,operation_type operationType,operation_name operationName,operation_path operationPath,params_json paramsJson,return_type returnType,source_file sourceFile,source_line sourceLine FROM cds_operations WHERE service_id=? AND provenance='direct' AND NOT EXISTS (SELECT 1 FROM cds_operations direct WHERE direct.service_id=? AND direct.provenance='direct' AND direct.operation_name=cds_operations.operation_name AND direct.operation_path=cds_operations.operation_path) ORDER BY operation_name,operation_path,id").all(baseId, extension.id) as unknown as DesiredOperation[];
}

function updateExtensionStatus(db: Db, serviceId: number, status: string, baseId: number | null): boolean {
  const row = db.prepare('SELECT extension_base_status status,extension_base_service_id baseId FROM cds_services WHERE id=?').get(serviceId) as { status?: string | null; baseId?: number | null } | undefined;
  if (row?.status === status && (row.baseId ?? null) === baseId) return false;
  db.prepare('UPDATE cds_services SET extension_base_status=?, extension_base_service_id=? WHERE id=?').run(status, baseId, serviceId);
  return true;
}

function reconcileInheritedOperations(db: Db, extension: ExtensionRow, desired: DesiredOperation[]): boolean {
  const existing = db.prepare("SELECT id,operation_type operationType,operation_name operationName,operation_path operationPath,params_json paramsJson,return_type returnType,source_file sourceFile,source_line sourceLine,base_operation_id baseOperationId FROM cds_operations WHERE service_id=? AND provenance='inherited'").all(extension.id) as unknown as ExistingOperation[];
  const desiredKeys = new Set(desired.map((row) => `${row.operationName}\0${row.operationPath}`));
  const byKey = new Map(existing.map((row) => [`${row.operationName}\0${row.operationPath}`, row]));
  let changed = false;
  for (const row of existing) {
    if (desiredKeys.has(`${row.operationName}\0${row.operationPath}`)) continue;
    db.prepare('DELETE FROM cds_operations WHERE id=?').run(row.id);
    changed = true;
  }
  const update = db.prepare('UPDATE cds_operations SET operation_type=?,params_json=?,return_type=?,source_file=?,source_line=?,base_operation_id=? WHERE id=?');
  const add = db.prepare("INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,provenance,base_operation_id) VALUES(?,?,?,?,?,?,?,?,'inherited',?)");
  for (const row of desired) {
    const current = byKey.get(`${row.operationName}\0${row.operationPath}`);
    if (current && operationMatches(current, row)) continue;
    if (current) update.run(row.operationType, row.paramsJson, row.returnType, row.sourceFile, row.sourceLine, row.id, current.id);
    else add.run(extension.id, row.operationType, row.operationName, row.operationPath, row.paramsJson, row.returnType, row.sourceFile, row.sourceLine, row.id);
    changed = true;
  }
  return changed;
}

function operationMatches(current: ExistingOperation, desired: DesiredOperation): boolean {
  return current.operationType === desired.operationType && current.paramsJson === desired.paramsJson && current.returnType === desired.returnType && current.sourceFile === desired.sourceFile && current.sourceLine === desired.sourceLine && current.baseOperationId === desired.id;
}

function reconcileOperationSearchRows(db: Db, repoId: number): void {
  db.prepare("DELETE FROM search_index WHERE repo=? AND kind='operation'").run(String(repoId));
  db.prepare(`INSERT INTO search_index(kind,name,path,repo)
    SELECT 'operation',o.operation_name,o.operation_path,?
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    WHERE s.repo_id=? ORDER BY o.operation_name,o.operation_path,o.id`).run(String(repoId), repoId);
}

function markRepositoryDerivedFactsChanged(db: Db, repoId: number): void {
  db.prepare("UPDATE repositories SET fact_generation=COALESCE(fact_generation,0)+1, graph_stale_reason='derived_facts_changed', graph_stale_at=? WHERE id=?").run(new Date().toISOString(), repoId);
}

function resolveBase(db: Db, workspaceId: number, extension: ExtensionRow): BaseRow[] {
  const symbol = extension.importedSymbol ?? extension.serviceName;
  if (extension.importKind === 'relative' && extension.moduleSpecifier) return relativeBase(db, extension, symbol);
  if (extension.importKind === 'package' && extension.moduleSpecifier) return packageBase(db, workspaceId, extension.moduleSpecifier, symbol);
  return sameRepoBase(db, extension, symbol);
}

function relativeBase(db: Db, extension: ExtensionRow, symbol: string): BaseRow[] {
  const modulePath = normalizeModulePath(extension.sourceFile, extension.moduleSpecifier ?? '');
  return db.prepare(`SELECT s.id,s.repo_id repoId FROM cds_services s WHERE s.repo_id=? AND s.is_extend=0 AND (s.qualified_name=? OR s.service_name=?) AND (s.source_file=? OR s.source_file=?) ORDER BY s.id`).all(extension.repoId, symbol, symbol, modulePath, `${modulePath}.cds`) as unknown as BaseRow[];
}

function packageBase(db: Db, workspaceId: number, specifier: string, symbol: string): BaseRow[] {
  const packageName = packageNameFromSpecifier(specifier);
  const moduleSuffix = specifier.slice(packageName.length).replace(/^\//, '');
  return db.prepare(`SELECT s.id,s.repo_id repoId FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND s.is_extend=0 AND r.package_name=? AND (s.qualified_name=? OR s.service_name=?) AND (?='' OR s.source_file=? OR s.source_file=?) ORDER BY s.id`).all(workspaceId, packageName, symbol, symbol, moduleSuffix, moduleSuffix, `${moduleSuffix}.cds`) as unknown as BaseRow[];
}

function sameRepoBase(db: Db, extension: ExtensionRow, symbol: string): BaseRow[] {
  return db.prepare('SELECT id,repo_id repoId FROM cds_services WHERE repo_id=? AND is_extend=0 AND (qualified_name=? OR service_name=?) ORDER BY id').all(extension.repoId, symbol, symbol) as unknown as BaseRow[];
}

function normalizeModulePath(sourceFile: string, specifier: string): string {
  const base = sourceFile.split('/').slice(0, -1).join('/');
  const parts = `${base}/${specifier}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/').replace(/\.cds$/, '');
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0] ?? specifier;
}
