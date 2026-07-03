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
function callName(expr: ts.Expression): { expression: string; local?: string; member?: string; importSource?: string } {
  if (ts.isIdentifier(expr)) return { expression: expr.text, local: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expr.expression.getText();
    return { expression: expr.getText(), local: left === 'this' ? undefined : left, member: expr.name.text };
  }
  return { expression: expr.getText() };
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
  const addSymbol = (kind: string, localName: string, node: ts.Node, parentName?: string, exportedName?: string): void => {
    symbols.push({ kind, localName, exportedName, qualifiedName: parentName ? `${parentName}.${localName}` : localName, sourceFile, startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()), startOffset: node.getStart(source), endOffset: node.getEnd(), exported: exported(node) || Boolean(exportedName), importExportEvidence: exportedName ? { exportedName } : undefined });
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
    ts.forEachChild(node, visitImports);
  };
  visitImports(source);
  const visitSymbols = (node: ts.Node, parentClass?: string): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const member of node.members) visitSymbols(member, node.name.text);
      return;
    }
    if (ts.isMethodDeclaration(node)) {
      const localName = nameOf(node.name);
      if (localName) addSymbol('method', localName, node, parentClass);
    } else if (ts.isFunctionDeclaration(node) && node.name) addSymbol('function', node.name.text, node, undefined, exported(node) ? node.name.text : undefined);
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (d.initializer && isFunctionLike(d.initializer)) {
        const localName = nameOf(d.name);
        if (localName) addSymbol('function', localName, d.initializer, undefined, exported(node) ? localName : undefined);
      }
    } else ts.forEachChild(node, (child) => visitSymbols(child, parentClass));
  };
  visitSymbols(source);
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const line = lineOf(source, node.getStart(source));
      const caller = nearest(symbols, line);
      if (caller) {
        const callee = callName(node.expression);
        calls.push({ callerQualifiedName: caller.qualifiedName, calleeExpression: callee.expression, calleeLocalName: callee.member ?? callee.local, receiverLocalName: callee.member ? callee.local : undefined, importSource: (callee.local ? imports.get(callee.local) : undefined) ?? (callee.member && callee.local ? imports.get(callee.local) : undefined), sourceFile, sourceLine: line, evidence: { relation: callee.importSource ? 'imported' : callee.expression.startsWith('this.') ? 'this_method' : 'local' } });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { symbols, calls };
}
