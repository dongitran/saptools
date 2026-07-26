import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ExecutableSymbolFact, SymbolCallFact } from '../types.js';
import {
  classifyOutboundCallsInSource,
  containsSupportedOutboundCall,
  type ClassifiedOutboundCall,
} from './outbound-call-parser.js';
import type { RepositorySourceContext } from './ts-project.js';
import { normalizePath } from '../utils/path-utils.js';
import { reconcileEventSubscriptions } from './005-event-subscription-facts.js';
import { reconcileSymbolCallOwners } from './007-source-fact-reconciliation.js';
import {
  collectSymbolImportBindings,
  type SymbolImportBinding,
} from './002-symbol-import-bindings.js';
import {
  collectSymbolCallFacts,
  symbolCallName,
  type SymbolCallProxy,
  type SymbolClassInstance,
} from './009-symbol-call-facts.js';
import {
  executableBodyEligibility,
} from './013-executable-body-eligibility.js';
import {
  collectDerivedSymbolContexts,
} from './017-symbol-derived-contexts.js';

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}
function nameOf(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}
function exported(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}
function isPublicClassMethod(node: ts.MethodDeclaration): boolean {
  const flags = ts.getCombinedModifierFlags(node);
  return (flags & ts.ModifierFlags.Private) === 0 && (flags & ts.ModifierFlags.Protected) === 0;
}
function exportDeclarations(source: ts.SourceFile): Map<string, string> {
  const exports = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) exports.set((el.propertyName ?? el.name).text, el.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return exports;
}
function isObjectFunction(
  node: ts.Node,
): node is ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}
type ParameterBinding =
  | { index: number; kind: 'identifier'; name: string }
  | { index: number; kind: 'object_pattern'; properties: Array<{ property: string; local: string }> }
  | { index: number; kind: 'array_pattern'; elements: Array<{ index: number; local: string }> };
type ParameterPropertyAlias = { parameter: string; property: string; local: string; kind: 'object_parameter_destructure'; line: number };
function requireSource(expr: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'require') return undefined;
  const first = expr.arguments[0];
  return first && ts.isStringLiteral(first) ? first.text : undefined;
}
function bindingLocalName(name: ts.BindingName, initializer?: ts.Expression): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (initializer && ts.isIdentifier(initializer)) return initializer.text;
  return undefined;
}

function objectPatternAliases(pattern: ts.ObjectBindingPattern, parameter: string, source: ts.SourceFile, lineNode: ts.Node): ParameterPropertyAlias[] {
  return pattern.elements.flatMap((element): ParameterPropertyAlias[] => {
    if (element.dotDotDotToken || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) return [];
    const property = element.propertyName ? nameOf(element.propertyName) : nameOf(element.name);
    if (!property) return [];
    const local = bindingLocalName(element.name, element.initializer);
    return local ? [{ parameter, property, local, kind: 'object_parameter_destructure', line: lineOf(source, lineNode.getStart(source)) }] : [];
  });
}
function parameterPropertyAliases(fn: ts.FunctionLikeDeclaration, source: ts.SourceFile): ParameterPropertyAlias[] {
  const parameterNames = new Set(fn.parameters.flatMap((param) => ts.isIdentifier(param.name) ? [param.name.text] : []));
  if (!fn.body || parameterNames.size === 0) return [];
  const aliases: ParameterPropertyAlias[] = [];
  const addFromAssignment = (left: ts.Expression, right: ts.Expression, node: ts.Node): void => {
    if (!ts.isObjectLiteralExpression(left) || !ts.isIdentifier(right) || !parameterNames.has(right.text)) return;
    for (const prop of left.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const property = nameOf(prop.name);
      if (property && ts.isIdentifier(prop.initializer)) aliases.push({ parameter: right.text, property, local: prop.initializer.text, kind: 'object_parameter_destructure', line: lineOf(source, node.getStart(source)) });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isIdentifier(node.initializer) && parameterNames.has(node.initializer.text)) aliases.push(...objectPatternAliases(node.name, node.initializer.text, source, node));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) addFromAssignment(ts.isParenthesizedExpression(node.left) ? node.left.expression : node.left, node.right, node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  const seen = new Set<string>();
  return aliases.filter((alias) => { const key = `${alias.parameter}.${alias.property}:${alias.local}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function parameterBindings(params: ts.NodeArray<ts.ParameterDeclaration>): ParameterBinding[] {
  return params.flatMap((param, index): ParameterBinding[] => {
    if (ts.isIdentifier(param.name)) return [{ index, kind: 'identifier', name: param.name.text }];
    if (ts.isObjectBindingPattern(param.name)) {
      const properties = param.name.elements.flatMap((element): Array<{ property: string; local: string }> => {
        if (element.dotDotDotToken || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) return [];
        const property = element.propertyName ? nameOf(element.propertyName) : nameOf(element.name);
        if (!property) return [];
        const local = bindingLocalName(element.name, element.initializer);
        return local ? [{ property, local }] : [];
      });
      return properties.length > 0 ? [{ index, kind: 'object_pattern', properties }] : [];
    }
    if (ts.isArrayBindingPattern(param.name)) {
      const elements = param.name.elements.flatMap((element, elementIndex): Array<{ index: number; local: string }> =>
        ts.isBindingElement(element) && !element.dotDotDotToken && ts.isIdentifier(element.name)
          ? [{ index: elementIndex, local: element.name.text }]
          : []);
      return elements.length > 0 ? [{ index, kind: 'array_pattern', elements }] : [];
    }
    return [];
  });
}
interface SymbolCollection {
  source: ts.SourceFile;
  sourceFile: string;
  symbols: ExecutableSymbolFact[];
  imports: Map<string, string>;
  importBindings: SymbolImportBinding[];
  classifiedCalls: readonly ClassifiedOutboundCall[];
  exportNames: Map<string, string>;
  objectExports: Set<string>;
  exportedClasses: Set<string>;
  declaredClasses: Set<string>;
  proxies: Map<string, SymbolCallProxy[]>;
  instances: Map<string, SymbolClassInstance[]>;
}

function symbolSourceEvidence(
  collection: SymbolCollection,
  node: ts.Node,
  options: {
    parentRoot: string;
    qualifiedName: string;
    declaredExportName?: string;
    classContainerExported: boolean; classMemberExported: boolean;
    objectExported: boolean;
    evidence?: Record<string, unknown>;
  },
): Record<string, unknown> {
  if (options.evidence) return options.evidence;
  if (options.classMemberExported) return {
    source: 'exported_class_member',
    exportedClass: options.parentRoot,
    memberKind: ts.getCombinedModifierFlags(node as ts.Declaration)
      & ts.ModifierFlags.Static ? 'static_method' : 'class_method',
  };
  if (options.classContainerExported && ts.isMethodDeclaration(node)
    && isPublicClassMethod(node)) return {
    source: 'exported_class_instance_member', exportedClass: options.parentRoot,
    memberKind: 'class_method',
  };
  if (options.declaredExportName) return {
    exportedName: options.declaredExportName,
    source: 'export_declaration',
  };
  return options.objectExported
    ? { exportedName: options.qualifiedName, source: 'exported_object_literal' }
    : {};
}

function executableEvidence(
  node: ts.Node,
  source: ts.SourceFile,
): Record<string, unknown> {
  if (!isFunctionLike(node)) return {};
  const bindings = parameterBindings(node.parameters);
  const parameters = bindings.flatMap((binding) =>
    binding.kind === 'identifier' ? [binding.name] : []);
  const aliases = parameterPropertyAliases(node, source);
  return {
    executableBodyEligibility: executableBodyEligibility(node, source),
    ...(bindings.length > 0 ? { parameters, parameterBindings: bindings } : {}),
    ...(aliases.length > 0 ? { parameterPropertyAliases: aliases } : {}),
  };
}

interface SymbolNames {
  parentRoot: string;
  qualifiedName: string;
  declaredExportName?: string;
  objectExported: boolean;
  classContainerExported: boolean;
  classMemberExported: boolean;
  effectiveName?: string;
}

function exportedClassMember(
  collection: SymbolCollection,
  kind: string,
  parentName: string | undefined,
  parentRoot: string,
  node: ts.Node,
): boolean {
  if (kind !== 'method' || !parentName
    || !collection.exportedClasses.has(parentRoot)
    || !ts.isMethodDeclaration(node)) return false;
  return Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static)
    && isPublicClassMethod(node);
}

function symbolNames(
  collection: SymbolCollection,
  kind: string,
  localName: string,
  node: ts.Node,
  parentName?: string,
  exportedName?: string,
): SymbolNames {
  const parentRoot = parentName?.split('.')[0] ?? '';
  const declaredExportName = exportedName ?? collection.exportNames.get(
    parentName ? parentRoot : localName,
  );
  const qualifiedName = parentName ? `${parentName}.${localName}` : localName;
  const objectExported = Boolean(
    parentName && collection.objectExports.has(parentRoot),
  );
  const classMemberExported = exportedClassMember(
    collection, kind, parentName, parentRoot, node,
  );
  const classContainerExported = Boolean(
    parentName && collection.exportedClasses.has(parentRoot),
  );
  return {
    parentRoot, declaredExportName, qualifiedName,
    objectExported, classContainerExported, classMemberExported,
    effectiveName: classMemberExported || objectExported
      ? qualifiedName : declaredExportName,
  };
}

function addExecutableSymbol(
  collection: SymbolCollection,
  kind: string,
  localName: string,
  node: ts.Node,
  parentName?: string,
  exportedName?: string,
  evidence?: Record<string, unknown>,
): void {
  const names = symbolNames(
    collection, kind, localName, node, parentName, exportedName,
  );
  const sourceEvidence = symbolSourceEvidence(collection, node, {
    parentRoot: names.parentRoot,
    qualifiedName: names.qualifiedName,
    declaredExportName: names.declaredExportName,
    classContainerExported: names.classContainerExported,
    classMemberExported: names.classMemberExported,
    objectExported: names.objectExported,
    evidence,
  });
  collection.symbols.push({
    kind,
    localName: kind === 'object_method' ? names.qualifiedName : localName,
    exportedName: names.effectiveName,
    qualifiedName: names.qualifiedName,
    sourceFile: collection.sourceFile,
    startLine: lineOf(collection.source, node.getStart(collection.source)),
    endLine: lineOf(collection.source, node.getEnd()),
    startOffset: node.getStart(collection.source),
    endOffset: node.getEnd(),
    exported: exported(node) || Boolean(names.effectiveName),
    importExportEvidence: {
      ...sourceEvidence,
      ...executableEvidence(node, collection.source),
    },
  });
}

function addAliasSymbol(
  collection: SymbolCollection,
  objectName: string,
  propertyName: string,
  node: ts.Node,
): void {
  collection.symbols.push({
    kind: 'object_alias',
    localName: propertyName,
    exportedName: propertyName,
    qualifiedName: `${objectName}.${propertyName}`,
    sourceFile: collection.sourceFile,
    startLine: lineOf(collection.source, node.getStart(collection.source)),
    endLine: lineOf(collection.source, node.getEnd()),
    startOffset: node.getStart(collection.source),
    endOffset: node.getEnd(),
    exported: true,
    importExportEvidence: {
      source: 'exported_object_shorthand',
      objectName,
      propertyName,
      targetImportSource: collection.imports.get(propertyName),
    },
  });
}

function collectImportSources(collection: SymbolCollection): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      collectEsmImportSources(collection.imports, node);
    if (ts.isVariableStatement(node))
      collectCjsImportSources(collection.imports, node);
    ts.forEachChild(node, visit);
  };
  visit(collection.source);
}

function collectEsmImportSources(
  imports: Map<string, string>,
  node: ts.ImportDeclaration,
): void {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return;
  const source = node.moduleSpecifier.text;
  const clause = node.importClause;
  if (clause?.name) imports.set(clause.name.text, source);
  const named = clause?.namedBindings;
  if (named && ts.isNamedImports(named))
    for (const item of named.elements) imports.set(item.name.text, source);
  if (named && ts.isNamespaceImport(named))
    imports.set(named.name.text, source);
}

function collectCjsImportSources(
  imports: Map<string, string>,
  node: ts.VariableStatement,
): void {
  for (const declaration of node.declarationList.declarations) {
    const source = declaration.initializer
      ? requireSource(declaration.initializer) : undefined;
    if (!source) continue;
    if (ts.isIdentifier(declaration.name))
      imports.set(declaration.name.text, source);
    if (ts.isObjectBindingPattern(declaration.name))
      for (const item of declaration.name.elements)
        if (ts.isIdentifier(item.name)) imports.set(item.name.text, source);
  }
}

function classPropertySymbol(
  collection: SymbolCollection,
  node: ts.PropertyDeclaration,
  parentClass: string,
): void {
  const initializer = node.initializer;
  const localName = nameOf(node.name);
  if (!localName || !initializer
    || (!ts.isArrowFunction(initializer)
      && !ts.isFunctionExpression(initializer))) return;
  const staticPublic = publicStaticProperty(collection, node, parentClass);
  const memberKind = propertyMemberKind(initializer, staticPublic);
  addExecutableSymbol(
    collection, 'method', localName, initializer, parentClass,
    staticPublic ? `${parentClass}.${localName}` : undefined,
    staticPublic
      ? { source: 'exported_class_member', exportedClass: parentClass, memberKind }
      : { source: 'class_property_function', memberKind },
  );
}

function publicStaticProperty(
  collection: SymbolCollection,
  node: ts.PropertyDeclaration,
  parentClass: string,
): boolean {
  const flags = ts.getCombinedModifierFlags(node);
  return collection.exportedClasses.has(parentClass)
    && Boolean(flags & ts.ModifierFlags.Static)
    && (flags & ts.ModifierFlags.Private) === 0
    && (flags & ts.ModifierFlags.Protected) === 0;
}

function propertyMemberKind(
  initializer: ts.ArrowFunction | ts.FunctionExpression,
  staticPublic: boolean,
): string {
  if (ts.isArrowFunction(initializer))
    return staticPublic ? 'static_arrow_function' : 'arrow_function_property';
  return staticPublic
    ? 'static_function_expression'
    : 'function_expression_property';
}

function objectCallable(
  property: ts.ObjectLiteralElementLike,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(property)) return property;
  return ts.isPropertyAssignment(property)
    && isObjectFunction(property.initializer)
    ? property.initializer
    : undefined;
}

function objectLiteralSymbols(
  collection: SymbolCollection,
  objectName: string,
  object: ts.ObjectLiteralExpression,
  objectIsExported: boolean,
): void {
  if (objectIsExported) collection.objectExports.add(objectName);
  for (const property of object.properties) {
    if (objectIsExported && ts.isShorthandPropertyAssignment(property))
      addAliasSymbol(collection, objectName, property.name.text, property.name);
    const callable = objectCallable(property);
    const propertyName = callable ? nameOf(property.name) : undefined;
    if (callable && propertyName)
      addExecutableSymbol(
        collection, 'object_method', propertyName, callable, objectName,
      );
  }
}

function variableSymbols(
  collection: SymbolCollection,
  node: ts.VariableStatement,
): void {
  for (const declaration of node.declarationList.declarations) {
    const localName = nameOf(declaration.name);
    const initializer = declaration.initializer;
    if (!localName || !initializer) continue;
    if (isFunctionLike(initializer)) addExecutableSymbol(
      collection, 'function', localName, initializer, undefined,
      exported(node) ? localName : collection.exportNames.get(localName),
    );
    if (ts.isObjectLiteralExpression(initializer))
      objectLiteralSymbols(
        collection, localName, initializer,
        exported(node) || collection.exportNames.has(localName),
      );
  }
}

function collectClassDeclaration(
  collection: SymbolCollection,
  node: ts.Node,
): boolean {
  if (!ts.isClassDeclaration(node) || !node.name) return false;
  collection.declaredClasses.add(node.name.text);
  if (exported(node) || collection.exportNames.has(node.name.text))
    collection.exportedClasses.add(node.name.text);
  for (const member of node.members)
    visitDeclaredSymbol(collection, member, node.name.text);
  return true;
}

function collectMethodDeclaration(
  collection: SymbolCollection,
  node: ts.Node,
  parentClass?: string,
): boolean {
  if (!ts.isMethodDeclaration(node)) return false;
  const localName = nameOf(node.name);
  if (localName)
    addExecutableSymbol(collection, 'method', localName, node, parentClass);
  return true;
}

function visitDeclaredSymbol(
  collection: SymbolCollection,
  node: ts.Node,
  parentClass?: string,
): void {
  if (collectClassDeclaration(collection, node)) return;
  if (collectMethodDeclaration(collection, node, parentClass)) return;
  if (ts.isPropertyDeclaration(node)) {
    if (parentClass) classPropertySymbol(collection, node, parentClass);
    return;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    addExecutableSymbol(
      collection, 'function', node.name.text, node, undefined,
      exported(node) ? node.name.text : undefined,
    );
    return;
  }
  if (ts.isVariableStatement(node)) {
    variableSymbols(collection, node);
    return;
  }
  ts.forEachChild(node, (child) =>
    visitDeclaredSymbol(collection, child, parentClass));
}

function collectDeclaredSymbols(collection: SymbolCollection): void {
  visitDeclaredSymbol(collection, collection.source);
}

function isTopLevelCallback(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  if ((!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))
    || !ts.isCallExpression(node.parent)) return false;
  const callee = symbolCallName(node.parent.expression);
  const member = callee.member ?? callee.local;
  return Boolean(member && [
    'bootstrap', 'served', 'connect', 'on', 'once', 'use',
    'get', 'post', 'put', 'patch', 'delete', 'subscribe',
  ].includes(member));
}

function collectCallbackSymbols(collection: SymbolCollection): void {
  const visit = (node: ts.Node): void => {
    if (isTopLevelCallback(node)
      && containsSupportedOutboundCall(node, collection.classifiedCalls)) {
      const startLine = lineOf(
        collection.source, node.getStart(collection.source),
      );
      const name = `callback:${startLine}`;
      collection.symbols.push({
        kind: 'callback', localName: name,
        qualifiedName: `module:${collection.sourceFile}#${name}`,
        sourceFile: collection.sourceFile, startLine,
        endLine: lineOf(collection.source, node.getEnd()),
        startOffset: node.getStart(collection.source), endOffset: node.getEnd(),
        exported: false,
        importExportEvidence: {
          source: 'synthetic_outbound_callback', callbackLine: startLine,
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(collection.source);
}

function createCollection(
  source: ts.SourceFile,
  sourceFile: string,
  classifiedCalls: readonly ClassifiedOutboundCall[],
): SymbolCollection {
  return {
    source, sourceFile, classifiedCalls,
    symbols: [], imports: new Map(),
    importBindings: collectSymbolImportBindings(source),
    exportNames: exportDeclarations(source),
    objectExports: new Set(), exportedClasses: new Set(),
    declaredClasses: new Set(), proxies: new Map(), instances: new Map(),
  };
}

function populateCollection(collection: SymbolCollection): void {
  collectImportSources(collection);
  collectDeclaredSymbols(collection);
  collectCallbackSymbols(collection);
  collectDerivedSymbolContexts(collection);
}

async function sourceFile(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<ts.SourceFile> {
  const snapshot = context?.get(filePath);
  const text = snapshot?.text
    ?? await fs.readFile(path.join(repoPath, filePath), 'utf8');
  return snapshot?.sourceFile() ?? ts.createSourceFile(
    filePath, text, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

export async function parseExecutableSymbols(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
  preparedOutboundCalls?: readonly ClassifiedOutboundCall[],
): Promise<{ symbols: ExecutableSymbolFact[]; calls: SymbolCallFact[] }> {
  const source = await sourceFile(repoPath, filePath, context);
  const normalizedFile = normalizePath(filePath);
  const classified = preparedOutboundCalls
    ?? classifyOutboundCallsInSource(source, normalizedFile);
  const collection = createCollection(source, normalizedFile, classified);
  populateCollection(collection);
  const calls = collectSymbolCallFacts({
    source, sourceFile: normalizedFile,
    symbols: collection.symbols, imports: collection.imports,
    importBindings: collection.importBindings,
    proxies: collection.proxies, instances: collection.instances,
  });
  const events = reconcileEventSubscriptions(
    source, classified, collection.symbols, calls,
  );
  return {
    symbols: events.symbols,
    calls: reconcileSymbolCallOwners(events.calls, events.symbols),
  };
}
