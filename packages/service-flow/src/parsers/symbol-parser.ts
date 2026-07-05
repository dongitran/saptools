import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ExecutableSymbolFact, SymbolCallFact } from '../types.js';
import { containsSupportedOutboundCall } from './outbound-call-parser.js';
import { normalizePath } from '../utils/path-utils.js';

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
function isRelativeImport(value: string | undefined): boolean {
  return Boolean(value?.startsWith('.'));
}
function isObjectFunction(node: ts.Node): boolean {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}
type ParameterBinding =
  | { index: number; kind: 'identifier'; name: string }
  | { index: number; kind: 'object_pattern'; properties: Array<{ property: string; local: string }> };
type ParameterPropertyAlias = { parameter: string; property: string; local: string; kind: 'object_parameter_destructure'; line: number };
const commonTerminalMembers = new Set(['push', 'includes', 'find', 'findIndex', 'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'toUpperCase', 'toLowerCase', 'trim', 'split', 'join', 'get', 'set', 'has']);
const loggerMembers = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log']);
const globalObjects = new Set(['JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'Reflect']);
const builtInConstructors = new Set([
  'Set', 'Map', 'WeakSet', 'WeakMap',
  'Date', 'RegExp', 'URL', 'URLSearchParams',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Promise', 'AbortController',
]);
const capDslRoots = new Set(['SELECT', 'INSERT', 'UPSERT', 'UPDATE', 'DELETE']);
const requestHelpers = new Set(['reject', 'error', 'info', 'warn', 'notify']);
const transportMembers = new Set(['emit', 'publish', 'send', 'on']);
function callName(expr: ts.Expression): { expression: string; local?: string; member?: string; receiver?: string } {
  if (ts.isIdentifier(expr)) return { expression: expr.text, local: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expr.expression.getText();
    const root = left.split('.')[0];
    return { expression: expr.getText(), local: left === 'this' ? undefined : root, member: expr.name.text, receiver: left };
  }
  return { expression: expr.getText() };
}
function requireSource(expr: ts.Expression): string | undefined {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'require') return undefined;
  const first = expr.arguments[0];
  return first && ts.isStringLiteral(first) ? first.text : undefined;
}
function ignoredFrameworkCall(callee: { expression: string; local?: string; member?: string; receiver?: string }): boolean {
  if (callee.local && capDslRoots.has(callee.local)) return true;
  if (callee.expression === 'cds.run' || callee.expression.startsWith('cds.connect.') || callee.expression.startsWith('cds.services.') || callee.expression.startsWith('cds.parse.')) return true;
  if (callee.local === 'req' && callee.member && requestHelpers.has(callee.member)) return true;
  if (callee.member && transportMembers.has(callee.member)) return true;
  if (callee.local && globalObjects.has(callee.local)) return true;
  if (callee.expression.startsWith('new Date().')) return true;
  return false;
}
function nearest(symbols: ExecutableSymbolFact[], line: number): ExecutableSymbolFact | undefined {
  return symbols.filter((s) => s.startLine <= line && s.endLine >= line).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}
function argumentEvidence(args: ts.NodeArray<ts.Expression>, source: ts.SourceFile): Array<Record<string, unknown>> {
  return args.map((arg) => {
    if (ts.isIdentifier(arg)) return { kind: 'identifier', name: arg.text };
    if (ts.isObjectLiteralExpression(arg)) {
      const properties: Array<Record<string, unknown>> = [];
      for (const prop of arg.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) properties.push({ kind: 'shorthand', property: prop.name.text, argument: prop.name.text });
        if (ts.isPropertyAssignment(prop)) {
          const propName = nameOf(prop.name);
          if (propName && ts.isIdentifier(prop.initializer)) properties.push({ kind: 'property_assignment', property: propName, argument: prop.initializer.text });
        }
      }
      return { kind: 'object_literal', properties };
    }
    return { kind: 'unsupported', expression: arg.getText(source) };
  });
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
    if (!ts.isObjectBindingPattern(param.name)) return [];
    const properties = param.name.elements.flatMap((element): Array<{ property: string; local: string }> => {
      if (element.dotDotDotToken || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) return [];
      const property = element.propertyName ? nameOf(element.propertyName) : nameOf(element.name);
      if (!property) return [];
      const local = bindingLocalName(element.name, element.initializer);
      return local ? [{ property, local }] : [];
    });
    return properties.length > 0 ? [{ index, kind: 'object_pattern', properties }] : [];
  });
}
export async function parseExecutableSymbols(repoPath: string, filePath: string): Promise<{ symbols: ExecutableSymbolFact[]; calls: SymbolCallFact[] }> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const sourceFile = normalizePath(filePath);
  const symbols: ExecutableSymbolFact[] = [];
  const calls: SymbolCallFact[] = [];
  const imports = new Map<string, string>();
  const exportNames = exportDeclarations(source);
  const objectExports = new Set<string>();
  const exportedClasses = new Set<string>();
  const declaredClasses = new Set<string>();
  const proxyVariables = new Map<string, { importSource: string; factory: string; variableName: string }>();
  const classInstances = new Map<string, { className: string; importSource?: string; propertyName?: string }>();
  const addSymbol = (kind: string, localName: string, node: ts.Node, parentName?: string, exportedName?: string, evidence?: Record<string, unknown>): void => {
    const parentRoot = parentName?.split('.')[0] ?? '';
    const declaredExportName = exportedName ?? exportNames.get(parentName ? parentRoot : localName);
    const qualifiedName = parentName ? `${parentName}.${localName}` : localName;
    const objectExported = parentName ? objectExports.has(parentRoot) : false;
    const classMemberExported = kind === 'method' && parentName ? exportedClasses.has(parentRoot) && ts.isMethodDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0 && isPublicClassMethod(node) : false;
    const effectiveExportedName = classMemberExported || objectExported ? qualifiedName : declaredExportName;
    const bindings = isFunctionLike(node) ? parameterBindings(node.parameters) : undefined;
    const params = bindings?.flatMap((binding) => binding.kind === 'identifier' ? [binding.name] : []);
    const sourceEvidence = evidence ?? (classMemberExported ? { source: 'exported_class_member', exportedClass: parentRoot, memberKind: (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0 ? 'static_method' : 'class_method', parameters: params } : declaredExportName ? { exportedName: declaredExportName, source: 'export_declaration' } : objectExported ? { exportedName: qualifiedName, source: 'exported_object_literal' } : undefined);
    const aliases = isFunctionLike(node) ? parameterPropertyAliases(node, source) : [];
    const parameterEvidence = { ...(bindings && bindings.length > 0 ? { parameters: params, parameterBindings: bindings } : {}), ...(aliases.length > 0 ? { parameterPropertyAliases: aliases } : {}) };
    symbols.push({ kind, localName: kind === 'object_method' ? qualifiedName : localName, exportedName: effectiveExportedName, qualifiedName, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: exported(node) || Boolean(effectiveExportedName), importExportEvidence: sourceEvidence ? { ...sourceEvidence, ...parameterEvidence } : bindings && bindings.length > 0 ? parameterEvidence : undefined });
  };
  const addAliasSymbol = (objectName: string, propertyName: string, node: ts.Node, targetImportSource?: string): void => {
    symbols.push({ kind: 'object_alias', localName: propertyName, exportedName: propertyName, qualifiedName: `${objectName}.${propertyName}`, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: true, importExportEvidence: { source: 'exported_object_shorthand', objectName, propertyName, targetImportSource } });
  };
  const visitImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const sourceText = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, sourceText);
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.set(el.name.text, sourceText);
      if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, sourceText);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const requiredSource = declaration.initializer ? requireSource(declaration.initializer) : undefined;
        if (ts.isIdentifier(declaration.name) && requiredSource) imports.set(declaration.name.text, requiredSource);
        if (ts.isObjectBindingPattern(declaration.name) && requiredSource) for (const element of declaration.name.elements) if (ts.isIdentifier(element.name)) imports.set(element.name.text, requiredSource);
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(source);
  const visitSymbols = (node: ts.Node, parentClass?: string): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      declaredClasses.add(node.name.text);
      if (exported(node) || exportNames.has(node.name.text)) exportedClasses.add(node.name.text);
      for (const member of node.members) visitSymbols(member, node.name.text);
      return;
    }
    if (ts.isMethodDeclaration(node)) {
      const localName = nameOf(node.name);
      if (localName) addSymbol('method', localName, node, parentClass);
    } else if (ts.isPropertyDeclaration(node) && parentClass && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const localName = nameOf(node.name);
      if (localName) addSymbol('method', localName, node.initializer, parentClass, undefined, { source: 'class_property_function', memberKind: ts.isArrowFunction(node.initializer) ? 'arrow_function_property' : 'function_expression_property' });
    } else if (ts.isFunctionDeclaration(node) && node.name) addSymbol('function', node.name.text, node, undefined, exported(node) ? node.name.text : undefined);
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const localName = nameOf(d.name);
        if (!localName || !d.initializer) continue;
        if (isFunctionLike(d.initializer)) addSymbol('function', localName, d.initializer, undefined, exported(node) ? localName : exportNames.get(localName));
        if (ts.isObjectLiteralExpression(d.initializer)) {
          const objectIsExported = exported(node) || exportNames.has(localName);
          if (objectIsExported) objectExports.add(localName);
          for (const prop of d.initializer.properties) {
            if (objectIsExported && ts.isShorthandPropertyAssignment(prop)) addAliasSymbol(localName, prop.name.text, prop.name, imports.get(prop.name.text));
            if (ts.isPropertyAssignment(prop) && isObjectFunction(prop.initializer)) {
              const propName = nameOf(prop.name);
              if (propName) addSymbol('object_method', propName, prop.initializer, localName);
            } else if (ts.isMethodDeclaration(prop)) {
              const propName = nameOf(prop.name);
              if (propName) addSymbol('object_method', propName, prop, localName);
            }
          }
        }
      }
    } else ts.forEachChild(node, (child) => visitSymbols(child, parentClass));
  };
  visitSymbols(source);

  const isTopLevelCallback = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
    if (!ts.isCallExpression(node.parent)) return false;
    const callee = callName(node.parent.expression);
    const member = callee.member ?? callee.local;
    return Boolean(member && ['bootstrap', 'served', 'connect', 'on', 'once', 'use', 'get', 'post', 'put', 'patch', 'delete', 'subscribe'].includes(member));
  };
  const visitCallbackSymbols = (node: ts.Node): void => {
    if (isTopLevelCallback(node) && containsSupportedOutboundCall(node)) {
      const startLine = lineOf(source, node.getStart(source));
      const name = `callback:${startLine}`;
      symbols.push({ kind: 'callback', localName: name, qualifiedName: `module:${sourceFile}#${name}`, sourceFile, startLine, endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: false, importExportEvidence: { source: 'synthetic_outbound_callback', callbackLine: startLine } });
    }
    ts.forEachChild(node, visitCallbackSymbols);
  };
  visitCallbackSymbols(source);

  const visitEventRegistrationSymbols = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'on') {
      const receiver = node.expression.expression.getText(source);
      const eventArg = node.arguments[0];
      if ((receiver === 'cds' || /^(srv|service|serviceClient|messaging|messageClient|eventClient|.*Client)$/.test(receiver)) && eventArg && (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))) {
        const startLine = lineOf(source, node.getStart(source));
        const eventName = eventArg.text.replace(/[^A-Za-z0-9_$-]/g, '_');
        const name = `event:${eventName}:${startLine}`;
        symbols.push({ kind: 'event_registration', localName: name, qualifiedName: `module:${sourceFile}#${name}`, sourceFile, startLine, endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: false, importExportEvidence: { source: 'synthetic_event_registration', eventName: eventArg.text, registrationLine: startLine, receiver } });
      }
    }
    ts.forEachChild(node, visitEventRegistrationSymbols);
  };
  visitEventRegistrationSymbols(source);
  const visitProxyVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression)) {
      const callee = callName(node.initializer.expression);
      const importSource = callee.local ? imports.get(callee.local) : undefined;
      if (callee.member && importSource && isRelativeImport(importSource)) proxyVariables.set(node.name.text, { importSource, factory: callee.expression, variableName: node.name.text });
    }
    ts.forEachChild(node, visitProxyVariables);
  };
  visitProxyVariables(source);
  const rememberClassInstance = (variableName: string, className: string, propertyName?: string): void => {
    const importSource = imports.get(className);
    if (!builtInConstructors.has(className) && ((importSource && isRelativeImport(importSource)) || declaredClasses.has(className))) classInstances.set(variableName, { className, importSource, propertyName });
  };
  const visitClassInstances = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      rememberClassInstance(node.name.text, node.initializer.expression.text);
    }
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      const propertyName = nameOf(node.name);
      if (propertyName) rememberClassInstance(`this.${propertyName}`, node.initializer.expression.text, propertyName);
    }
    ts.forEachChild(node, visitClassInstances);
  };
  visitClassInstances(source);
  const localCallables = new Set(symbols.flatMap((sym) => [sym.localName, sym.qualifiedName]));
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const line = lineOf(source, node.getStart(source));
      const caller = nearest(symbols, line);
      if (caller) {
        const callee = callName(node.expression);
        const proxy = callee.local ? proxyVariables.get(callee.local) : undefined;
        const instance = (callee.local ? classInstances.get(callee.local) : undefined) ?? (callee.receiver ? classInstances.get(callee.receiver) : undefined);
        const importSource = instance?.importSource ?? proxy?.importSource ?? (callee.local ? imports.get(callee.local) : undefined) ?? (callee.member && callee.local ? imports.get(callee.local) : undefined);
        const directThisMethod = callee.receiver === 'this';
        const targetName = instance && callee.member ? `${instance.className}.${callee.member}` : proxy && callee.member ? callee.member : directThisMethod ? callee.member : callee.member && callee.local ? `${callee.local}.${callee.member}` : callee.local;
        const className = caller.qualifiedName.includes('.') ? caller.qualifiedName.split('.')[0] : undefined;
        const thisTarget = directThisMethod && className && callee.member ? `${className}.${callee.member}` : undefined;
        const loggerLike = callee.receiver?.endsWith('.logger') || callee.local === 'logger' || (callee.expression.startsWith('this.logger.') && callee.member ? loggerMembers.has(callee.member) : false);
        const terminalMember = callee.member ? commonTerminalMembers.has(callee.member) || loggerMembers.has(callee.member) : false;
        const provenLocal = Boolean(targetName) && localCallables.has(String(targetName));
        const provenThisMethod = Boolean(thisTarget && localCallables.has(thisTarget));
        const provenRelativeImport = Boolean(isRelativeImport(importSource) && targetName);
        const provenClassInstance = Boolean(instance && callee.member && targetName);
        const importedFromPackage = Boolean(importSource && !isRelativeImport(importSource));
        const ignored = loggerLike || terminalMember || importedFromPackage || ignoredFrameworkCall(callee);
        const resolvedTarget = provenThisMethod ? thisTarget : targetName;
        const keep = Boolean(resolvedTarget) && !ignored && (provenLocal || provenThisMethod || provenRelativeImport || provenClassInstance);
        if (keep) calls.push({ callerQualifiedName: caller.qualifiedName, calleeExpression: callee.expression, calleeLocalName: resolvedTarget, receiverLocalName: callee.member ? (callee.local ?? callee.receiver) : undefined, importSource, sourceFile, sourceLine: line, evidence: { relation: instance ? 'class_instance_method' : proxy ? 'relative_import_proxy_member' : importSource ? 'relative_import' : provenThisMethod ? 'indexed_this_method' : 'indexed_local_symbol', caller: caller.qualifiedName, targetName: resolvedTarget, instanceVariable: instance ? (instance.propertyName ?? callee.local) : undefined, className: instance?.className, methodName: instance ? callee.member : undefined, classImportSource: instance?.importSource, callArguments: argumentEvidence(node.arguments, source), proxyVariableName: proxy?.variableName, factory: proxy?.factory, factoryExpression: proxy?.factory, factoryImportSource: proxy?.importSource, candidateStrategy: instance ? (instance.importSource ? 'relative_import_class_instance_method' : 'same_file_class_instance_method') : proxy ? 'proxy_member_exact_export_or_unique_member' : undefined } });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { symbols, calls };
}
