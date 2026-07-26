import { posix } from 'node:path';
import ts from 'typescript';
import {
  hasNestedCommonJsMutation,
  isUnshadowedCommonJsExportExpression,
  unsupportedCommonJsMutation,
} from './018-package-commonjs-syntax.js';
import { stableLocalValueReference } from './020-stable-local-value.js';

export const PACKAGE_PUBLIC_SURFACE_SCHEMA =
  'service-flow/package-public-surface@1';
export const PACKAGE_PUBLIC_SURFACE_RECORD_CAP = 256;
export const PACKAGE_PUBLIC_SURFACE_EXPORT_DEPTH = 16;

export type PackagePublicSurfaceStatus =
  | 'complete'
  | 'incomplete'
  | 'unsupported'
  | 'not_applicable';
export type ExecutableBodyReason =
  | 'body_present'
  | 'declaration_only'
  | 'ambient_declaration'
  | 'abstract_bodyless'
  | 'overload_signature';

export interface PackageSourceModule {
  sourceFile: string;
  source: ts.SourceFile;
}
export interface ExecutableBodyEligibility {
  eligible: boolean;
  reason: ExecutableBodyReason;
}
export interface PublicSurfaceTarget {
  sourceFile: string;
  kind: 'function' | 'method' | 'object_method';
  localName: string;
  qualifiedName: string;
  startOffset: number;
  endOffset: number;
  bodyEligibility: ExecutableBodyEligibility;
}
export interface PackagePublicEntry {
  entry: string;
  modulePath: string;
}
export interface PackagePublicScope {
  entry: string;
  modulePath: string;
  publicName: string;
  candidateCount: number;
  eligibleCandidateCount: number;
  selectedCandidateCount: 0 | 1;
  candidateSetComplete: true;
  targets: PublicSurfaceTarget[];
}
export interface PackagePublicSurfaceFact {
  schema: typeof PACKAGE_PUBLIC_SURFACE_SCHEMA;
  status: PackagePublicSurfaceStatus;
  reason: string | null;
  recordCap: typeof PACKAGE_PUBLIC_SURFACE_RECORD_CAP;
  total: number;
  shown: number;
  omitted: number;
  packageName: string | null;
  exportsPresent: boolean;
  exportsAuthoritative: boolean;
  main: string | null;
  module: string | null;
  entries: PackagePublicEntry[];
  scopes: PackagePublicScope[];
}
export interface SymbolPublicExposure {
  entry: string;
  modulePath: string;
  publicName: string;
}
export interface SymbolPublicSurfaceEvidence {
  target: PublicSurfaceTarget;
  exposures: SymbolPublicExposure[];
  exposureTotal: number;
  shownExposureCount: number;
  omittedExposureCount: number;
}
export interface PackagePublicSurfaceAnalysis {
  surface: PackagePublicSurfaceFact;
  symbols: SymbolPublicSurfaceEvidence[];
}

interface LocalValue {
  callable: PublicSurfaceTarget[];
  members: Map<string, PublicSurfaceTarget[]>;
  declarationOnlyCount: number;
}
interface LocalExport {
  publicName: string;
  localName: string;
  typeOnly: boolean;
}
interface ReExport extends LocalExport {
  importedName: string;
  specifier: string;
}
export interface ModuleInfo {
  modulePath: string;
  sourceFile: string;
  values: Map<string, LocalValue>;
  localExports: LocalExport[];
  reExports: ReExport[];
  starExports: string[];
  unstableValues: Set<string>;
  unsupportedReason?: string;
}
export interface ResolvedExport {
  targets: PublicSurfaceTarget[];
  declarationOnlyCount: number;
}
export interface ModuleResolution {
  exports: Map<string, ResolvedExport>;
  complete: boolean;
  reason?: string;
}
const extensionPattern = /\.(?:d\.)?(?:ts|js)$/;

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((item) => item.kind === kind));
}

function canonicalModulePath(sourceFile: string): string {
  return sourceFile.replace(/\\/g, '/').replace(extensionPattern, '');
}

function targetKey(target: PublicSurfaceTarget): string {
  return [
    target.sourceFile, target.startOffset, target.endOffset,
    target.kind, target.qualifiedName,
  ].join('\0');
}

function bodyEligibility(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): ExecutableBodyEligibility {
  if (node.body) return { eligible: true, reason: 'body_present' };
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword))
    return { eligible: false, reason: 'abstract_bodyless' };
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword))
    return { eligible: false, reason: 'ambient_declaration' };
  return {
    eligible: false,
    reason: source.isDeclarationFile
      ? 'declaration_only'
      : 'overload_signature',
  };
}

function functionTarget(
  info: ModuleInfo,
  source: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
  localName: string,
  kind: PublicSurfaceTarget['kind'] = 'function',
  qualifiedName = localName,
): PublicSurfaceTarget {
  return {
    sourceFile: info.sourceFile, kind, localName, qualifiedName,
    startOffset: node.getStart(source), endOffset: node.getEnd(),
    bodyEligibility: bodyEligibility(node, source),
  };
}

function emptyLocalValue(declarationOnlyCount = 0): LocalValue {
  return { callable: [], members: new Map(), declarationOnlyCount };
}

function localValue(values: Map<string, LocalValue>, name: string): LocalValue {
  const value = values.get(name) ?? emptyLocalValue();
  values.set(name, value);
  return value;
}

function addMember(
  value: LocalValue,
  name: string,
  target: PublicSurfaceTarget,
): void {
  const targets = value.members.get(name) ?? [];
  targets.push(target);
  value.members.set(name, targets);
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function isPublicStaticMember(member: ts.ClassElement): boolean {
  if (!hasModifier(member, ts.SyntaxKind.StaticKeyword)) return false;
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)
    || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) return false;
  return !member.name || !ts.isPrivateIdentifier(member.name);
}

function collectFunction(
  info: ModuleInfo,
  source: ts.SourceFile,
  node: ts.FunctionDeclaration,
): void {
  if (!node.name) {
    if (hasModifier(node, ts.SyntaxKind.ExportKeyword))
      info.unsupportedReason = 'anonymous_default_export_without_symbol_identity';
    return;
  }
  localValue(info.values, node.name.text).callable.push(
    functionTarget(info, source, node, node.name.text),
  );
}

function collectClassMember(
  info: ModuleInfo,
  source: ts.SourceFile,
  className: string,
  value: LocalValue,
  member: ts.ClassElement,
): void {
  if (!isPublicStaticMember(member)) return;
  const name = propertyName(member.name);
  if (!name) return;
  if (ts.isMethodDeclaration(member)) {
    addMember(value, name, functionTarget(
      info, source, member, name, 'method', `${className}.${name}`,
    ));
    return;
  }
  if (!ts.isPropertyDeclaration(member) || !member.initializer
    || (!ts.isArrowFunction(member.initializer)
      && !ts.isFunctionExpression(member.initializer))) return;
  addMember(value, name, functionTarget(
    info, source, member.initializer, name, 'method', `${className}.${name}`,
  ));
}

function collectClassMembers(
  info: ModuleInfo,
  source: ts.SourceFile,
  node: ts.ClassDeclaration,
): void {
  if (!node.name) return;
  if (!stableLocalValueReference(source, node.name)) {
    info.unstableValues.add(node.name.text);
    return;
  }
  const value = localValue(info.values, node.name.text);
  for (const member of node.members)
    collectClassMember(info, source, node.name.text, value, member);
}

function collectObjectMembers(
  info: ModuleInfo,
  source: ts.SourceFile,
  objectName: string,
  object: ts.ObjectLiteralExpression,
): void {
  const value = localValue(info.values, objectName);
  for (const member of object.properties) {
    const name = propertyName(member.name);
    if (!name) continue;
    const callable = ts.isMethodDeclaration(member)
      ? member
      : ts.isPropertyAssignment(member)
        && (ts.isArrowFunction(member.initializer)
          || ts.isFunctionExpression(member.initializer))
        ? member.initializer
        : undefined;
    if (callable) addMember(value, name, functionTarget(
      info, source, callable, `${objectName}.${name}`,
      'object_method', `${objectName}.${name}`,
    ));
  }
}

function collectVariables(
  info: ModuleInfo,
  source: ts.SourceFile,
  statement: ts.VariableStatement,
): void {
  const immutable = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  for (const item of statement.declarationList.declarations) {
    if (!ts.isIdentifier(item.name)) continue;
    const name = item.name.text;
    if (!immutable || !stableLocalValueReference(source, item.name)) {
      info.unstableValues.add(name);
      continue;
    }
    if (!item.initializer) continue;
    if (ts.isArrowFunction(item.initializer)
      || ts.isFunctionExpression(item.initializer))
      localValue(info.values, name).callable.push(
        functionTarget(info, source, item.initializer, name),
      );
    if (ts.isObjectLiteralExpression(item.initializer))
      collectObjectMembers(info, source, name, item.initializer);
  }
}

function pushLocalExport(
  info: ModuleInfo,
  publicName: string,
  localName: string,
  typeOnly = false,
): void {
  const rootName = localName.split('.')[0] ?? localName;
  if (info.unstableValues.has(rootName))
    info.unsupportedReason = 'unsupported_mutable_export_binding';
  info.localExports.push({ publicName, localName, typeOnly });
}

function addDirectExports(info: ModuleInfo, statement: ts.Statement): void {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
  const exportedName = (name: string): string =>
    hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : name;
  if (ts.isFunctionDeclaration(statement) && statement.name)
    pushLocalExport(info, exportedName(statement.name.text), statement.name.text);
  if (ts.isClassDeclaration(statement) && statement.name)
    pushLocalExport(info, exportedName(statement.name.text), statement.name.text);
  if (ts.isVariableStatement(statement))
    for (const item of statement.declarationList.declarations)
      if (ts.isIdentifier(item.name))
        pushLocalExport(info, item.name.text, item.name.text);
}

function addNamedExports(
  info: ModuleInfo,
  statement: ts.ExportDeclaration,
): void {
  const clause = statement.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return;
  const module = statement.moduleSpecifier;
  const specifier = module && ts.isStringLiteralLike(module)
    ? module.text
    : undefined;
  for (const item of clause.elements) {
    const importedName = item.propertyName?.text ?? item.name.text;
    const typeOnly = statement.isTypeOnly || item.isTypeOnly;
    if (specifier) info.reExports.push({
      publicName: item.name.text, localName: importedName,
      importedName, specifier, typeOnly,
    });
    else pushLocalExport(info, item.name.text, importedName, typeOnly);
  }
}

function addExportDeclaration(
  info: ModuleInfo,
  statement: ts.ExportDeclaration,
): void {
  if (statement.exportClause) {
    if (ts.isNamedExports(statement.exportClause))
      addNamedExports(info, statement);
    else info.unsupportedReason = 'unsupported_namespace_reexport';
    return;
  }
  const module = statement.moduleSpecifier;
  if (!module || !ts.isStringLiteralLike(module)) {
    info.unsupportedReason = 'unsupported_export_declaration';
    return;
  }
  info.starExports.push(module.text);
}

function addExportAssignment(
  info: ModuleInfo,
  statement: ts.ExportAssignment,
): void {
  if (!statement.isExportEquals && ts.isIdentifier(statement.expression))
    pushLocalExport(info, 'default', statement.expression.text);
  else info.unsupportedReason = 'unsupported_export_assignment';
}

function addCjsObjectExports(
  info: ModuleInfo,
  object: ts.ObjectLiteralExpression,
): void {
  for (const item of object.properties) {
    if (ts.isShorthandPropertyAssignment(item))
      pushLocalExport(info, item.name.text, item.name.text);
    else if (ts.isPropertyAssignment(item)
      && ts.isIdentifier(item.initializer)) {
      const name = propertyName(item.name);
      if (name) pushLocalExport(info, name, item.initializer.text);
    } else info.unsupportedReason = 'unsupported_commonjs_export_shape';
  }
}

function addCjsNamespaceExport(info: ModuleInfo, localName: string): void {
  const value = info.values.get(localName);
  if (!value) {
    info.unsupportedReason = 'unsupported_commonjs_export_shape';
    return;
  }
  if (value.callable.length > 0) pushLocalExport(info, 'default', localName);
  for (const member of value.members.keys()) {
    pushLocalExport(info, member, `${localName}.${member}`);
    pushLocalExport(info, `default.${member}`, `${localName}.${member}`);
  }
}

function cjsBinaryAssignment(
  statement: ts.ExpressionStatement,
): ts.BinaryExpression | undefined {
  const value = statement.expression;
  if (!ts.isBinaryExpression(value)) return undefined;
  return value.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? value
    : undefined;
}

function cjsAssignment(
  info: ModuleInfo,
  statement: ts.ExpressionStatement,
): void {
  const value = cjsBinaryAssignment(statement);
  if (!value) return;
  const left = value.left.getText();
  if (!isUnshadowedCommonJsExportExpression(value.left)) return;
  if (left === 'module.exports' && ts.isObjectLiteralExpression(value.right))
    return addCjsObjectExports(info, value.right);
  if (left === 'module.exports' && ts.isIdentifier(value.right))
    return addCjsNamespaceExport(info, value.right.text);
  const match = /^(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)$/.exec(left);
  if (match?.[1] && ts.isIdentifier(value.right))
    return pushLocalExport(info, match[1], value.right.text);
  info.unsupportedReason = 'unsupported_commonjs_export_shape';
}

function collectTypeDeclaration(
  info: ModuleInfo,
  statement: ts.Statement,
): void {
  if (!(ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement))
    || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
  localValue(info.values, statement.name.text).declarationOnlyCount += 1;
  pushLocalExport(info, statement.name.text, statement.name.text, true);
}

function moduleInfo(module: PackageSourceModule): ModuleInfo {
  const info: ModuleInfo = {
    modulePath: canonicalModulePath(module.sourceFile),
    sourceFile: module.sourceFile.replace(/\\/g, '/'),
    values: new Map(), localExports: [], reExports: [], starExports: [],
    unstableValues: new Set(),
  };
  for (const statement of module.source.statements) {
    if (ts.isFunctionDeclaration(statement))
      collectFunction(info, module.source, statement);
    if (ts.isClassDeclaration(statement))
      collectClassMembers(info, module.source, statement);
    if (ts.isVariableStatement(statement))
      collectVariables(info, module.source, statement);
    addDirectExports(info, statement);
    if (ts.isExportDeclaration(statement))
      addExportDeclaration(info, statement);
    if (ts.isExportAssignment(statement))
      addExportAssignment(info, statement);
    if (ts.isExpressionStatement(statement)) {
      cjsAssignment(info, statement);
      if (unsupportedCommonJsMutation(statement))
        info.unsupportedReason = 'unsupported_commonjs_export_shape';
    }
    collectTypeDeclaration(info, statement);
  }
  if (hasNestedCommonJsMutation(module.source))
    info.unsupportedReason = 'unsupported_commonjs_export_shape';
  return info;
}

function mergeTargets(
  current: readonly PublicSurfaceTarget[],
  incoming: readonly PublicSurfaceTarget[],
): PublicSurfaceTarget[] {
  const byKey = new Map(current.map((item) => [targetKey(item), item]));
  for (const item of incoming) byKey.set(targetKey(item), item);
  return [...byKey.values()].sort((left, right) =>
    compareBinary(targetKey(left), targetKey(right)));
}

function mergeExport(
  exports: Map<string, ResolvedExport>,
  publicName: string,
  incoming: ResolvedExport,
): void {
  const current = exports.get(publicName)
    ?? { targets: [], declarationOnlyCount: 0 };
  exports.set(publicName, {
    targets: mergeTargets(current.targets, incoming.targets),
    declarationOnlyCount:
      current.declarationOnlyCount + incoming.declarationOnlyCount,
  });
}

function localExportValue(
  info: ModuleInfo,
  localName: string,
): LocalValue | undefined {
  const direct = info.values.get(localName);
  if (direct) return direct;
  const separator = localName.lastIndexOf('.');
  if (separator < 1) return undefined;
  const owner = info.values.get(localName.slice(0, separator));
  const targets = owner?.members.get(localName.slice(separator + 1));
  return targets
    ? { callable: targets, members: new Map(), declarationOnlyCount: 0 }
    : undefined;
}

function applyLocalExport(
  exports: Map<string, ResolvedExport>,
  info: ModuleInfo,
  item: LocalExport,
): void {
  const value = localExportValue(info, item.localName);
  if (!value || item.typeOnly) {
    mergeExport(exports, item.publicName, {
      targets: [], declarationOnlyCount: value?.declarationOnlyCount ?? 1,
    });
    return;
  }
  if (value.callable.length > 0 || value.declarationOnlyCount > 0)
    mergeExport(exports, item.publicName, {
      targets: value.callable,
      declarationOnlyCount: value.declarationOnlyCount,
    });
  for (const [member, targets] of value.members)
    mergeExport(exports, `${item.publicName}.${member}`, {
      targets, declarationOnlyCount: 0,
    });
}

function requestedModuleCandidates(
  fromModule: string,
  specifier: string,
  infos: Map<string, ModuleInfo[]>,
): string[] {
  if (!specifier.startsWith('.')) return [];
  const joined = posix.normalize(posix.join(posix.dirname(fromModule), specifier));
  if (joined === '..' || joined.startsWith('../')) return [];
  const base = canonicalModulePath(joined.replace(/^\.\//, ''));
  return [base, `${base}/index`].filter((item, index, values) =>
    values.indexOf(item) === index && infos.get(item)?.length === 1);
}

function renameExport(
  exports: Map<string, ResolvedExport>,
  source: Map<string, ResolvedExport>,
  item: ReExport,
): void {
  const exact = source.get(item.importedName);
  const typeOnly = (value: ResolvedExport): ResolvedExport => item.typeOnly
    ? { targets: [], declarationOnlyCount: Math.max(
      1, value.declarationOnlyCount,
    ) }
    : value;
  if (exact) mergeExport(exports, item.publicName, typeOnly(exact));
  for (const [name, value] of source) {
    if (!name.startsWith(`${item.importedName}.`)) continue;
    mergeExport(exports, `${item.publicName}${name.slice(
      item.importedName.length,
    )}`, typeOnly(value));
  }
}

function moduleFailure(reason: string): ModuleResolution {
  return { exports: new Map(), complete: false, reason };
}

function nestedResolution(
  info: ModuleInfo,
  specifier: string,
  infos: Map<string, ModuleInfo[]>,
  memo: Map<string, ModuleResolution>,
  stack: readonly string[],
): ModuleResolution {
  if (!specifier.startsWith('.'))
    return moduleFailure('unsupported_external_reexport');
  const candidates = requestedModuleCandidates(info.modulePath, specifier, infos);
  if (candidates.length !== 1 || !candidates[0])
    return moduleFailure(candidates.length > 1
      ? 'public_surface_module_resolution_ambiguous'
      : 'public_surface_module_not_indexed');
  return resolveModule(candidates[0], infos, memo, stack);
}

function resolveModuleInfo(
  info: ModuleInfo,
  infos: Map<string, ModuleInfo[]>,
  memo: Map<string, ModuleResolution>,
  stack: readonly string[],
): ModuleResolution {
  const exports = new Map<string, ResolvedExport>();
  for (const item of info.localExports) applyLocalExport(exports, info, item);
  if (info.unsupportedReason)
    return { exports, complete: false, reason: info.unsupportedReason };
  for (const item of info.reExports) {
    const nested = nestedResolution(info, item.specifier, infos, memo, stack);
    if (!nested.complete) return nested;
    renameExport(exports, nested.exports, item);
  }
  for (const specifier of info.starExports) {
    const nested = nestedResolution(info, specifier, infos, memo, stack);
    if (!nested.complete) return nested;
    for (const [name, value] of nested.exports)
      if (name !== 'default' && !name.startsWith('default.'))
        mergeExport(exports, name, value);
  }
  return { exports, complete: true };
}

export function resolveModule(
  modulePath: string,
  infos: Map<string, ModuleInfo[]>,
  memo: Map<string, ModuleResolution>,
  stack: readonly string[] = [],
): ModuleResolution {
  const cached = memo.get(modulePath);
  if (cached) return cached;
  if (stack.includes(modulePath))
    return moduleFailure('public_surface_reexport_cycle');
  if (stack.length >= PACKAGE_PUBLIC_SURFACE_EXPORT_DEPTH)
    return moduleFailure('public_surface_reexport_depth_exceeded');
  const rows = infos.get(modulePath) ?? [];
  if (rows.length !== 1 || !rows[0])
    return moduleFailure(rows.length > 1
      ? 'public_surface_module_resolution_ambiguous'
      : 'public_surface_module_not_indexed');
  const result = resolveModuleInfo(rows[0], infos, memo, [...stack, modulePath]);
  if (result.complete) memo.set(modulePath, result);
  return result;
}

export function moduleInfoMap(
  modules: readonly PackageSourceModule[],
): Map<string, ModuleInfo[]> {
  const result = new Map<string, ModuleInfo[]>();
  for (const module of modules) {
    const info = moduleInfo(module);
    result.set(info.modulePath, [...(result.get(info.modulePath) ?? []), info]);
  }
  return result;
}

export { analyzePackagePublicSurface } from
  './010-package-public-surface-analysis.js';
