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

export function materializeCdsExtensionOperations(db: Db, workspaceId: number): void {
  const extensions = db.prepare(`SELECT s.id,r.id repoId,s.service_name serviceName,s.qualified_name qualifiedName,s.source_file sourceFile,s.extension_module_specifier moduleSpecifier,s.extension_imported_symbol importedSymbol,s.extension_import_kind importKind
    FROM cds_services s JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=? AND s.is_extend=1`).all(workspaceId) as unknown as ExtensionRow[];
  const insert = db.prepare(`INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,provenance,base_operation_id)
    SELECT ?,operation_type,operation_name,operation_path,params_json,return_type,source_file,source_line,'inherited',id FROM cds_operations WHERE service_id=? AND NOT EXISTS (SELECT 1 FROM cds_operations existing WHERE existing.service_id=? AND existing.operation_name=cds_operations.operation_name AND existing.operation_path=cds_operations.operation_path)`);
  for (const extension of extensions) {
    const bases = resolveBase(db, workspaceId, extension);
    const status = bases.length === 1 ? 'resolved' : bases.length > 1 ? 'ambiguous' : 'unresolved';
    db.prepare('UPDATE cds_services SET extension_base_status=?, extension_base_service_id=? WHERE id=?').run(status, bases[0]?.id ?? null, extension.id);
    if (bases.length === 1) insert.run(extension.id, bases[0]?.id, extension.id);
  }
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
