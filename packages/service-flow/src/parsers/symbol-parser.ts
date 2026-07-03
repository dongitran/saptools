import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ExecutableSymbolFact, SymbolCallFact } from '../types.js';
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
function isPublicStaticMethod(node: ts.MethodDeclaration): boolean {
  const flags = ts.getCombinedModifierFlags(node);
  return (flags & ts.ModifierFlags.Static) !== 0 && (flags & ts.ModifierFlags.Private) === 0 && (flags & ts.ModifierFlags.Protected) === 0;
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
const commonTerminalMembers = new Set(['push', 'includes', 'find', 'findIndex', 'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'toUpperCase', 'toLowerCase', 'trim', 'split', 'join', 'get', 'set', 'has']);
const loggerMembers = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log']);
const globalObjects = new Set(['JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'Reflect']);
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
  const proxyVariables = new Map<string, { importSource: string; factory: string }>();
  const addSymbol = (kind: string, localName: string, node: ts.Node, parentName?: string, exportedName?: string, evidence?: Record<string, unknown>): void => {
    const parentRoot = parentName?.split('.')[0] ?? '';
    const declaredExportName = exportedName ?? exportNames.get(parentName ? parentRoot : localName);
    const qualifiedName = parentName ? `${parentName}.${localName}` : localName;
    const objectExported = parentName ? objectExports.has(parentRoot) : false;
    const classMemberExported = kind === 'method' && parentName ? exportedClasses.has(parentRoot) && ts.isMethodDeclaration(node) && isPublicStaticMethod(node) : false;
    const effectiveExportedName = classMemberExported || objectExported ? qualifiedName : declaredExportName;
    const sourceEvidence = evidence ?? (classMemberExported ? { source: 'exported_class_member', exportedClass: parentRoot, memberKind: 'static_method' } : declaredExportName ? { exportedName: declaredExportName, source: 'export_declaration' } : objectExported ? { exportedName: qualifiedName, source: 'exported_object_literal' } : undefined);
    symbols.push({ kind, localName: kind === 'object_method' ? qualifiedName : localName, exportedName: effectiveExportedName, qualifiedName, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: exported(node) || Boolean(effectiveExportedName), importExportEvidence: sourceEvidence });
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
      if (exported(node) || exportNames.has(node.name.text)) exportedClasses.add(node.name.text);
      for (const member of node.members) visitSymbols(member, node.name.text);
      return;
    }
    if (ts.isMethodDeclaration(node)) {
      const localName = nameOf(node.name);
      if (localName) addSymbol('method', localName, node, parentClass);
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
  const visitProxyVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression)) {
      const callee = callName(node.initializer.expression);
      const importSource = callee.local ? imports.get(callee.local) : undefined;
      if (callee.member && importSource && isRelativeImport(importSource)) proxyVariables.set(node.name.text, { importSource, factory: callee.expression });
    }
    ts.forEachChild(node, visitProxyVariables);
  };
  visitProxyVariables(source);
  const localCallables = new Set(symbols.flatMap((sym) => [sym.localName, sym.qualifiedName]));
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const line = lineOf(source, node.getStart(source));
      const caller = nearest(symbols, line);
      if (caller) {
        const callee = callName(node.expression);
        const proxy = callee.local ? proxyVariables.get(callee.local) : undefined;
        const importSource = proxy?.importSource ?? (callee.local ? imports.get(callee.local) : undefined) ?? (callee.member && callee.local ? imports.get(callee.local) : undefined);
        const targetName = proxy && callee.member ? callee.member : callee.expression.startsWith('this.') ? callee.member : callee.member && callee.local ? `${callee.local}.${callee.member}` : callee.local;
        const className = caller.qualifiedName.includes('.') ? caller.qualifiedName.split('.')[0] : undefined;
        const thisTarget = className && callee.member ? `${className}.${callee.member}` : undefined;
        const loggerLike = callee.receiver?.endsWith('.logger') || callee.local === 'logger' || (callee.expression.startsWith('this.logger.') && callee.member ? loggerMembers.has(callee.member) : false);
        const terminalMember = callee.member ? commonTerminalMembers.has(callee.member) || loggerMembers.has(callee.member) : false;
        const provenLocal = Boolean(targetName) && localCallables.has(String(targetName));
        const provenThisMethod = Boolean(thisTarget && localCallables.has(thisTarget));
        const provenRelativeImport = Boolean(isRelativeImport(importSource) && targetName);
        const importedFromPackage = Boolean(importSource && !isRelativeImport(importSource));
        const ignored = loggerLike || terminalMember || importedFromPackage || ignoredFrameworkCall(callee);
        const resolvedTarget = provenThisMethod ? thisTarget : targetName;
        const keep = Boolean(resolvedTarget) && !ignored && (provenLocal || provenThisMethod || provenRelativeImport);
        if (keep) calls.push({ callerQualifiedName: caller.qualifiedName, calleeExpression: callee.expression, calleeLocalName: resolvedTarget, receiverLocalName: callee.member ? callee.local : undefined, importSource, sourceFile, sourceLine: line, evidence: { relation: proxy ? 'relative_import_proxy_member' : importSource ? 'relative_import' : provenThisMethod ? 'indexed_this_method' : 'indexed_local_symbol', caller: caller.qualifiedName, targetName: resolvedTarget, factory: proxy?.factory } });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { symbols, calls };
}
