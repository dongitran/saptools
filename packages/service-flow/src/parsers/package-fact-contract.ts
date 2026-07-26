import {
  PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
  PACKAGE_PUBLIC_SURFACE_SCHEMA,
} from './package-public-surface.js';
import type {
  ExecutableBodyEligibility,
  PackagePublicEntry,
  PackagePublicScope,
  PackagePublicSurfaceFact,
  PublicSurfaceTarget,
} from './package-public-surface.js';
import {
  packageModuleRequest,
  type SymbolImportBindingKind,
  type SymbolImportReference,
  type SymbolImportReferenceShape,
} from './symbol-import-bindings.js';

const bindingKinds = new Set<SymbolImportBindingKind>([
  'esm_named', 'esm_default', 'esm_namespace',
  'cjs_destructured', 'cjs_namespace',
]);
const referenceShapes = new Set<SymbolImportReferenceShape>([
  'identifier', 'namespace_member', 'static_member', 'default_member',
]);
const bodyReasons = new Set([
  'body_present', 'declaration_only', 'ambient_declaration',
  'abstract_bodyless', 'overload_signature',
]);
const surfaceReasons = new Set([
  'anonymous_default_export_without_symbol_identity',
  'unsupported_namespace_reexport',
  'unsupported_export_declaration',
  'unsupported_export_assignment',
  'unsupported_commonjs_export_shape',
  'unsupported_mutable_export_binding',
  'unsupported_external_reexport',
  'unsupported_exports_map_shape',
  'unsupported_package_entrypoint_shape',
  'public_surface_entry_target_not_indexed',
  'public_surface_main_module_conflict',
  'public_surface_module_resolution_ambiguous',
  'public_surface_module_not_indexed',
  'public_surface_reexport_cycle',
  'public_surface_reexport_depth_exceeded',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function bindingShapeValid(value: Record<string, unknown>): boolean {
  const kind = value.bindingKind as SymbolImportBindingKind;
  const imported = value.importedName;
  if (!all([
    bindingKinds.has(kind),
    nonEmpty(value.localName),
    typeof value.typeOnly === 'boolean',
  ])) return false;
  if (kind === 'esm_namespace' || kind === 'cjs_namespace')
    return imported === null;
  if (!nonEmpty(imported)) return false;
  return kind !== 'esm_default' || imported === 'default';
}

function memberReferenceValid(
  value: Record<string, unknown>,
  shape: SymbolImportReferenceShape,
): boolean {
  const kind = value.bindingKind as SymbolImportBindingKind;
  const member = value.referencedMemberName;
  if (!nonEmpty(member)) return false;
  if (shape === 'namespace_member') return all([
    kind === 'esm_namespace' || kind === 'cjs_namespace',
    value.requestedPublicName === member,
  ]);
  if (!nonEmpty(value.importedName)) return false;
  return all([
    value.requestedPublicName === `${value.importedName}.${member}`,
    shape !== 'default_member' || kind === 'esm_default',
  ]);
}

function referenceShapeValid(value: Record<string, unknown>): boolean {
  const shape = value.referenceShape as SymbolImportReferenceShape;
  if (!referenceShapes.has(shape)
    || !nonEmpty(value.requestedPublicName)) return false;
  return shape === 'identifier'
    ? all([
        value.referencedMemberName === null,
        nonEmpty(value.importedName),
        value.requestedPublicName === value.importedName,
      ])
    : memberReferenceValid(value, shape);
}

function importReferenceBaseValid(
  item: Record<string, unknown>,
): boolean {
  return all([
    item.version === 1,
    bindingShapeValid(item),
    referenceShapeValid(item),
    nonEmpty(item.rawModuleSpecifier),
    nonNegativeInteger(item.bindingSiteStartOffset),
    nonNegativeInteger(item.bindingSiteEndOffset),
    Number(item.bindingSiteEndOffset)
      > Number(item.bindingSiteStartOffset),
  ]);
}

export function parsePackageImportReference(
  value: unknown,
): SymbolImportReference | undefined {
  const item = record(value);
  if (!item || !importReferenceBaseValid(item)
    || item.moduleKind !== 'package'
    || !nonEmpty(item.requestedPackageName)
    || !nonEmpty(item.requestedModuleSubpath)) return undefined;
  const specifier = item.rawModuleSpecifier;
  if (!nonEmpty(specifier)) return undefined;
  const request = packageModuleRequest(specifier);
  if (!request || request.packageName !== item.requestedPackageName
    || request.moduleSubpath !== item.requestedModuleSubpath) return undefined;
  return item as unknown as SymbolImportReference;
}

export function parseRelativeImportReference(
  value: unknown,
): SymbolImportReference | undefined {
  const item = record(value);
  if (!item || !importReferenceBaseValid(item)) return undefined;
  if (!all([
    item.moduleKind === 'relative',
    item.requestedPackageName === null,
    item.requestedModuleSubpath === null,
    String(item.rawModuleSpecifier).startsWith('.'),
  ])) return undefined;
  return item as unknown as SymbolImportReference;
}

function validBody(value: unknown): value is ExecutableBodyEligibility {
  const item = record(value);
  if (!item || typeof item.eligible !== 'boolean'
    || typeof item.reason !== 'string' || !bodyReasons.has(item.reason))
    return false;
  return item.eligible === (item.reason === 'body_present');
}

function validTarget(value: unknown): value is PublicSurfaceTarget {
  const item = record(value);
  return Boolean(item && nonEmpty(item.sourceFile)
    && ['function', 'method', 'object_method'].includes(String(item.kind))
    && nonEmpty(item.localName) && nonEmpty(item.qualifiedName)
    && nonNegativeInteger(item.startOffset)
    && nonNegativeInteger(item.endOffset)
    && Number(item.endOffset) > Number(item.startOffset)
    && validBody(item.bodyEligibility));
}

function targetIdentity(value: PublicSurfaceTarget): string {
  return [
    value.sourceFile, value.kind, value.qualifiedName,
    value.startOffset, value.endOffset,
  ].join('\0');
}

function validEntry(value: unknown): value is PackagePublicEntry {
  const item = record(value);
  return Boolean(item && nonEmpty(item.entry) && nonEmpty(item.modulePath)
    && (item.entry === '.' || String(item.entry).startsWith('./')));
}

function validScope(value: unknown): value is PackagePublicScope {
  const item = record(value);
  if (!item || !all([
    validEntry(item),
    nonEmpty(item.publicName),
    nonNegativeInteger(item.candidateCount),
    nonNegativeInteger(item.eligibleCandidateCount),
    [0, 1].includes(Number(item.selectedCandidateCount)),
    item.candidateSetComplete === true,
    Array.isArray(item.targets),
  ])) return false;
  if (!Array.isArray(item.targets) || !item.targets.every(validTarget))
    return false;
  const targetKeys = new Set(item.targets.map(targetIdentity));
  if (targetKeys.size !== item.targets.length) return false;
  const eligible = item.targets.filter((target) =>
    target.bodyEligibility.eligible).length;
  return all([
    Number(item.candidateCount) >= item.targets.length,
    item.eligibleCandidateCount === eligible,
    item.selectedCandidateCount === (eligible === 1 ? 1 : 0),
  ]);
}

function statusMatrixValid(
  value: Record<string, unknown>,
  expectedPackageName: string | null,
): boolean {
  const status = value.status;
  const reason = value.reason;
  if (!['complete', 'incomplete', 'unsupported', 'not_applicable']
    .includes(String(status))) return false;
  if (status === 'complete')
    return expectedPackageName !== null && reason === null;
  if (status === 'not_applicable') return all([
    expectedPackageName === null,
    reason === null,
    value.total === 0,
    value.shown === 0,
    value.omitted === 0,
  ]);
  return expectedPackageName !== null
    && typeof reason === 'string' && surfaceReasons.has(reason);
}

function surfaceCountsValid(value: Record<string, unknown>): boolean {
  if (!nonNegativeInteger(value.total) || !nonNegativeInteger(value.shown)
    || !nonNegativeInteger(value.omitted)
    || Number(value.shown) + Number(value.omitted) !== Number(value.total))
    return false;
  if (!Array.isArray(value.entries) || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => {
      const item = record(scope);
      return item && Array.isArray(item.targets);
    })) return false;
  const entries = value.entries;
  const scopes = value.scopes as Array<Record<string, unknown>>;
  const represented = entries.length + scopes.reduce(
    (sum, scope) => sum + 1 + (scope.targets as unknown[]).length, 0,
  );
  return represented === value.shown
    && Number(value.total) >= represented
    && Number(value.shown) <= PACKAGE_PUBLIC_SURFACE_RECORD_CAP;
}

function entriesAndScopesValid(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.entries) || !Array.isArray(value.scopes))
    return false;
  if (!value.entries.every(validEntry) || !value.scopes.every(validScope))
    return false;
  const entries = new Map((value.entries as PackagePublicEntry[])
    .map((entry) => [entry.entry, entry.modulePath]));
  const entryKeys = new Set((value.entries as PackagePublicEntry[])
    .map((entry) => `${entry.entry}\0${entry.modulePath}`));
  if (entryKeys.size !== value.entries.length) return false;
  const scopeKeys = new Set<string>();
  for (const scope of value.scopes as PackagePublicScope[]) {
    if (entries.get(scope.entry) !== scope.modulePath) return false;
    scopeKeys.add(`${scope.entry}\0${scope.publicName}`);
  }
  return scopeKeys.size === value.scopes.length;
}

function surfaceBaseValid(
  item: Record<string, unknown>,
  expectedPackageName: string | null,
): boolean {
  return all([
    item.schema === PACKAGE_PUBLIC_SURFACE_SCHEMA,
    item.recordCap === PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
    item.packageName === expectedPackageName,
    typeof item.exportsPresent === 'boolean',
    item.exportsAuthoritative === item.exportsPresent,
    nullableString(item.main),
    nullableString(item.module),
    entriesAndScopesValid(item),
    surfaceCountsValid(item),
    statusMatrixValid(item, expectedPackageName),
  ]);
}

function nonCompleteSurfaceEmpty(item: Record<string, unknown>): boolean {
  if (item.status === 'complete') return true;
  return Array.isArray(item.entries) && item.entries.length === 0
    && Array.isArray(item.scopes) && item.scopes.length === 0;
}

export function parsePackagePublicSurfaceFact(
  value: unknown,
  expectedPackageName: string | null,
): PackagePublicSurfaceFact | undefined {
  const item = record(value);
  if (!item || !surfaceBaseValid(item, expectedPackageName)
    || !nonCompleteSurfaceEmpty(item)) return undefined;
  return item as unknown as PackagePublicSurfaceFact;
}
