import { posix } from 'node:path';
import type { SymbolCallFact } from '../types.js';
import { packageModuleRequest } from
  '../parsers/symbol-import-bindings.js';
import type { Db } from './connection.js';

export interface RelativeSymbolCallResolution {
  id: number | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason: string | null;
  strategy: string;
  candidateCount: number;
  eligibleCandidateCount: number;
  candidateSetComplete: boolean;
  resolvedModulePath?: string;
}

interface TargetRow {
  id: number;
  kind: string;
  sourceFile: string;
  exported: boolean;
  evidenceJson: string | null;
}

interface RelativeModuleScope {
  paths: Set<string>;
  ambiguous: boolean;
}

interface MappingTarget {
  specifier?: string;
}

interface MappedExecutableRows {
  rows: TargetRow[];
  ambiguous: boolean;
  packageTargetUnsupported: boolean;
}

const stripExtension = (value: string): string =>
  value.replace(/\.(?:ts|tsx|js|jsx|cds)$/, '');

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedRecord(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function targetRows(rows: Array<Record<string, unknown>>): TargetRow[] {
  return rows.flatMap((row) =>
    typeof row.id === 'number' && typeof row.kind === 'string'
      && typeof row.sourceFile === 'string'
      && typeof row.exported === 'number'
      ? [{
          id: row.id,
          kind: row.kind,
          sourceFile: row.sourceFile,
          exported: row.exported === 1,
          evidenceJson: typeof row.evidenceJson === 'string'
            ? row.evidenceJson
            : null,
        }]
      : []);
}

function relativeTargets(sourceFile: string, specifier: string): Set<string> {
  const joined = stripExtension(posix.normalize(
    posix.join(posix.dirname(sourceFile), specifier),
  ));
  return new Set([joined, `${joined}/index`]);
}

function relativeModuleScope(
  db: Db,
  repoId: number,
  sourceFile: string,
  specifier: string,
): RelativeModuleScope {
  const requested = relativeTargets(sourceFile, specifier);
  const rows = db.prepare(`SELECT relative_path relativePath FROM files
    WHERE repo_id=? ORDER BY relative_path COLLATE BINARY`).all(repoId);
  const matched = rows.flatMap((row) =>
    typeof row.relativePath === 'string'
      && requested.has(stripExtension(row.relativePath))
      ? [stripExtension(row.relativePath)] : []);
  return {
    paths: new Set(matched),
    ambiguous: matched.length > 1,
  };
}

function scopedRows(
  rows: readonly TargetRow[],
  paths: ReadonlySet<string>,
): TargetRow[] {
  return rows.filter((row) => paths.has(stripExtension(row.sourceFile)));
}

function bodyEligible(row: TargetRow): boolean {
  const evidence = parsedRecord(row.evidenceJson);
  const direct = record(evidence?.executableBodyEligibility);
  const surface = record(evidence?.packagePublicSurface);
  const packageBody = record(surface?.bodyEligibility);
  const body = direct ?? packageBody;
  return body?.eligible === true && body.reason === 'body_present';
}

function relativeBinding(
  call: SymbolCallFact,
): Record<string, unknown> | undefined {
  const binding = record(call.evidence.importBinding);
  return binding?.moduleKind === 'relative'
    && binding.rawModuleSpecifier === call.importSource
    ? binding
    : undefined;
}

function importedHandlerMember(
  call: SymbolCallFact,
  binding = relativeBinding(call),
): boolean {
  return call.callRole === 'event_subscribe_handler'
    && binding?.referenceShape === 'static_member'
    && typeof binding.importedName === 'string'
    && binding.requestedPublicName === call.calleeLocalName;
}

function handlerMemberPubliclyCarried(
  row: TargetRow,
  binding: Record<string, unknown>,
): boolean {
  if (row.exported) return true;
  const evidence = parsedRecord(row.evidenceJson);
  if (evidence?.source !== 'exported_class_instance_member') return false;
  const exportKind = evidence.exportedClassExportKind;
  if (exportKind !== 'default' && exportKind !== 'named') return false;
  return binding.bindingKind === 'esm_default'
    ? exportKind === 'default'
    : evidence.exportedClass === binding.importedName;
}

function requiresPublicClassMember(
  relation: unknown,
  call: SymbolCallFact,
  binding: Record<string, unknown>,
): boolean {
  return relation === 'class_instance_method'
    || importedHandlerMember(call, binding);
}

function resolved(
  row: TargetRow,
  strategy: string,
  candidateCount: number,
  resolvedModulePath: string,
): RelativeSymbolCallResolution {
  return {
    id: row.id,
    status: 'resolved',
    reason: null,
    strategy,
    candidateCount,
    eligibleCandidateCount: 1,
    candidateSetComplete: true,
    resolvedModulePath,
  };
}

function unresolved(
  strategy: string,
  reason: string,
  candidateCount: number,
  eligibleCandidateCount = 0,
  candidateSetComplete = true,
): RelativeSymbolCallResolution {
  return {
    id: null,
    status: 'unresolved',
    reason,
    strategy,
    candidateCount,
    eligibleCandidateCount,
    candidateSetComplete,
  };
}

function ambiguous(
  strategy: string,
  reason: string,
  candidateCount: number,
  eligibleCandidateCount: number,
): RelativeSymbolCallResolution {
  return {
    id: null,
    status: 'ambiguous',
    reason,
    strategy,
    candidateCount,
    eligibleCandidateCount,
    candidateSetComplete: true,
  };
}

function uniqueRows(rows: readonly TargetRow[]): TargetRow[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .sort((left, right) => left.id - right.id);
}

function executableResolution(
  rows: readonly TargetRow[],
  scoped: readonly TargetRow[],
  modulePath: string | undefined,
  strategy: string,
  ambiguousReason: string,
): RelativeSymbolCallResolution {
  const eligible = uniqueRows(scoped.filter(bodyEligible));
  if (eligible.length === 1 && eligible[0] && modulePath)
    return resolved(eligible[0], strategy, rows.length, modulePath);
  if (eligible.length > 1) return ambiguous(
    strategy, ambiguousReason, rows.length, eligible.length,
  );
  return unresolved(
    strategy,
    scoped.length > 0
      ? 'relative_import_requested_module_has_no_executable_body'
      : 'relative_import_requested_module_has_no_target',
    rows.length,
  );
}

function qualifiedRows(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
): TargetRow[] {
  return targetRows(db.prepare(`SELECT id,kind,source_file sourceFile,
    exported,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file<>? AND qualified_name=?
    ORDER BY id`).all(repoId, call.sourceFile, call.calleeLocalName));
}

function exportedRows(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
): TargetRow[] {
  return targetRows(db.prepare(`SELECT id,kind,source_file sourceFile,
    exported,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file<>? AND exported=1
      AND (exported_name=? OR name=? OR qualified_name=?)
    ORDER BY id`).all(
    repoId, call.sourceFile,
    call.calleeLocalName, call.calleeLocalName, call.calleeLocalName,
  ));
}

function proxyRows(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
): TargetRow[] {
  return targetRows(db.prepare(`SELECT id,kind,source_file sourceFile,
    exported,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file<>?
      AND (exported_name=? OR name=? OR qualified_name=?)
    ORDER BY id`).all(
    repoId, call.sourceFile,
    call.calleeLocalName, call.calleeLocalName, call.calleeLocalName,
  ));
}

function mappingTarget(row: TargetRow): MappingTarget | undefined {
  const evidence = parsedRecord(row.evidenceJson);
  if (row.kind !== 'object_alias'
    || evidence?.source !== 'exported_object_shorthand') return undefined;
  const specifier = evidence.targetImportSource;
  return typeof specifier === 'string' ? { specifier } : {};
}

function mappingTargetScope(
  db: Db,
  repoId: number,
  row: TargetRow,
): RelativeModuleScope | undefined {
  const target = mappingTarget(row);
  if (!target) return undefined;
  if (!target.specifier)
    return {
      paths: new Set([stripExtension(row.sourceFile)]), ambiguous: false,
    };
  if (packageModuleRequest(target.specifier)) return undefined;
  return relativeModuleScope(db, repoId, row.sourceFile, target.specifier);
}

function mappedExecutableRows(
  db: Db,
  repoId: number,
  rows: readonly TargetRow[],
  aliases: readonly TargetRow[],
): MappedExecutableRows {
  const packageTargetUnsupported = aliases.some((alias) => {
    const target = mappingTarget(alias);
    return Boolean(target?.specifier && packageModuleRequest(target.specifier));
  });
  const scopes = aliases.flatMap((alias) => {
    const scope = mappingTargetScope(db, repoId, alias);
    return scope ? [scope] : [];
  });
  if (scopes.some((scope) => scope.ambiguous))
    return { rows: [], ambiguous: true, packageTargetUnsupported };
  const mapped = scopes.flatMap((scope) => {
    return rows.filter((row) =>
      row.kind !== 'object_alias' && bodyEligible(row)
      && scope.paths.has(stripExtension(row.sourceFile)));
  });
  return {
    rows: uniqueRows(mapped), ambiguous: false, packageTargetUnsupported,
  };
}

function proxyResolution(
  db: Db,
  repoId: number,
  rows: readonly TargetRow[],
  scope: RelativeModuleScope,
): RelativeSymbolCallResolution {
  const scoped = scopedRows(rows, scope.paths);
  const aliases = scoped.filter((row) => mappingTarget(row));
  const mapped = mappedExecutableRows(db, repoId, rows, aliases);
  if (mapped.ambiguous) return unresolved(
    'proxy_member_exported_object_map',
    'relative_import_module_resolution_ambiguous',
    rows.length, 0, false,
  );
  if (mapped.packageTargetUnsupported) return unresolved(
    'proxy_member_exported_object_map',
    'relative_import_proxy_alias_targets_package_unsupported',
    rows.length,
  );
  const direct = scoped.filter((row) =>
    row.kind !== 'object_alias' && row.exported && bodyEligible(row));
  const eligible = uniqueRows([
    ...direct,
    ...mapped.rows,
  ]);
  const modulePath = [...scope.paths][0];
  const strategy = aliases.length > 0
    ? 'proxy_member_exported_object_map'
    : 'relative_import_path_disambiguated';
  if (eligible.length === 1 && eligible[0] && modulePath)
    return resolved(eligible[0], strategy, rows.length, modulePath);
  if (eligible.length > 1) return ambiguous(
    'proxy_member_no_global_name_fallback',
    'multiple_proxy_targets_in_requested_module',
    rows.length,
    eligible.length,
  );
  return unresolved(
    'proxy_member_no_global_name_fallback',
    scoped.length > 0
      ? 'relative_import_requested_module_has_no_executable_body'
      : 'relative_import_requested_module_has_no_target',
    rows.length,
  );
}

function resolutionRows(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
  relation: unknown,
): TargetRow[] {
  if (relation === 'class_instance_method' || isAccessorCall(relation, call)
    || importedHandlerMember(call))
    return qualifiedRows(
    db, repoId, call,
  );
  if (relation === 'relative_import_proxy_member') return proxyRows(
    db, repoId, call,
  );
  return exportedRows(db, repoId, call);
}

function isAccessorCall(relation: unknown, call: SymbolCallFact): boolean {
  return relation === 'relative_import'
    && call.calleeExpression.includes('().')
    && String(call.calleeLocalName).includes('.');
}

function strategyFor(
  relation: unknown,
  call: SymbolCallFact,
  candidateCount: number,
): string {
  if (relation === 'class_instance_method')
    return 'relative_import_class_instance_method';
  if (relation === 'relative_import_namespace_member')
    return 'relative_import_namespace_member';
  if (isAccessorCall(relation, call))
    return 'relative_import_static_accessor_instance_method';
  return candidateCount > 1
    ? 'relative_import_path_disambiguated'
    : 'relative_import_exported_exact';
}

function ambiguousReasonFor(
  relation: unknown,
  call: SymbolCallFact,
): string {
  if (relation === 'class_instance_method')
    return 'multiple_relative_class_targets_in_requested_module';
  if (relation === 'relative_import_namespace_member')
    return 'multiple_namespace_targets_in_requested_module';
  return isAccessorCall(relation, call)
    ? 'multiple_accessor_targets_in_requested_module'
    : 'multiple_exported_targets_in_requested_module';
}

export function resolveRelativeSymbolCall(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
  relation: unknown,
): RelativeSymbolCallResolution | undefined {
  if (!call.importSource?.startsWith('.')) return undefined;
  const rows = resolutionRows(db, repoId, call, relation);
  const binding = relativeBinding(call);
  const strategy = strategyFor(relation, call, rows.length);
  if (!binding) return unresolved(
    strategy, 'relative_import_provenance_missing', rows.length,
  );
  if (binding.typeOnly === true) return unresolved(
    strategy, 'relative_import_type_only', rows.length,
  );
  const moduleScope = relativeModuleScope(
    db, repoId, call.sourceFile, call.importSource,
  );
  if (moduleScope.ambiguous) return unresolved(
    strategy, 'relative_import_module_resolution_ambiguous',
    rows.length, 0, false,
  );
  if (relation === 'relative_import_proxy_member')
    return proxyResolution(db, repoId, rows, moduleScope);
  const moduleRows = scopedRows(rows, moduleScope.paths);
  const scoped = binding && requiresPublicClassMember(
    relation, call, binding,
  )
    ? moduleRows.filter((row) => handlerMemberPubliclyCarried(row, binding))
    : moduleRows;
  return executableResolution(
    rows, scoped, [...moduleScope.paths][0],
    strategy, ambiguousReasonFor(relation, call),
  );
}
