import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ServiceBindingFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';

interface HelperBinding {
  exportedName: string;
  alias?: string;
  destinationExpr?: string;
  servicePathExpr?: string;
  isDynamic: boolean;
  placeholders: string[];
  sourceFile: string;
  sourceLine: number;
}
interface ImportBinding {
  localName: string;
  exportedName: string;
  sourceFile?: string;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return node.getText().replace(/^`|`$/g, '');
  return node.getText();
}
function placeholders(value?: string): string[] {
  return [...(value ?? '').matchAll(/\$\{\s*(\w+)\s*\}/g)]
    .map((m) => m[1] ?? '')
    .filter(Boolean);
}
function connectFactFromCall(
  call: ts.CallExpression,
):
  | Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>
  | undefined {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'to')
    return undefined;
  const inner = expr.expression;
  if (
    !ts.isPropertyAccessExpression(inner) ||
    inner.name.text !== 'connect' ||
    inner.expression.getText() !== 'cds'
  )
    return undefined;
  const first = call.arguments[0];
  if (!first) return undefined;
  if (
    ts.isStringLiteralLike(first) ||
    ts.isNoSubstitutionTemplateLiteral(first)
  )
    return { alias: first.text, isDynamic: false, placeholders: [] };
  if (!ts.isObjectLiteralExpression(first))
    return {
      servicePathExpr: first.getText(),
      isDynamic: true,
      placeholders: [],
    };
  let destinationExpr: string | undefined;
  let servicePathExpr: string | undefined;
  function visitObject(obj: ts.ObjectLiteralExpression): void {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name =
        ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
          ? prop.name.text
          : undefined;
      if (name === 'destination')
        destinationExpr = stringValue(prop.initializer);
      if (name === 'path' || name === 'servicePath')
        servicePathExpr = stringValue(prop.initializer);
      if (ts.isObjectLiteralExpression(prop.initializer))
        visitObject(prop.initializer);
    }
  }
  visitObject(first);
  const ph = [
    ...placeholders(destinationExpr),
    ...placeholders(servicePathExpr),
  ];
  return {
    destinationExpr,
    servicePathExpr,
    isDynamic: ph.length > 0 || (!destinationExpr && !servicePathExpr),
    placeholders: ph,
  };
}
function unwrapCall(expr: ts.Expression): ts.CallExpression | undefined {
  if (ts.isAwaitExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isCallExpression(expr)) return expr;
  return undefined;
}
function findConnectInExpression(
  expr: ts.Expression,
):
  | Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>
  | undefined {
  const direct = unwrapCall(expr);
  if (direct) {
    const fact = connectFactFromCall(direct);
    if (fact) return fact;
  }
  let found:
    | Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>
    | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node)) found = connectFactFromCall(node);
    if (!found) ts.forEachChild(node, visit);
  }
  visit(expr);
  return found;
}
async function readSource(abs: string): Promise<ts.SourceFile | undefined> {
  try {
    const text = await fs.readFile(abs, 'utf8');
    return ts.createSourceFile(
      abs,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  } catch {
    return undefined;
  }
}
async function resolveImport(
  repoPath: string,
  fromFile: string,
  spec: string,
): Promise<string | undefined> {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(repoPath, path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ]) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return normalizePath(path.relative(repoPath, candidate));
    } catch {
      /* continue */
    }
  }
  return undefined;
}
async function importsFor(
  repoPath: string,
  filePath: string,
  sf: ts.SourceFile,
): Promise<ImportBinding[]> {
  const imports: ImportBinding[] = [];
  for (const stmt of sf.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteralLike(stmt.moduleSpecifier)
    )
      continue;
    const sourceFile = await resolveImport(
      repoPath,
      filePath,
      stmt.moduleSpecifier.text,
    );
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name)
      imports.push({
        localName: clause.name.text,
        exportedName: 'default',
        sourceFile,
      });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements)
        imports.push({
          localName: el.name.text,
          exportedName: el.propertyName?.text ?? el.name.text,
          sourceFile,
        });
  }
  return imports;
}
async function helperBindings(
  repoPath: string,
  filePath: string,
): Promise<HelperBinding[]> {
  const sf = await readSource(path.join(repoPath, filePath));
  if (!sf) return [];
  const sourceFileAst = sf;
  const out: HelperBinding[] = [];
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt)
      ? (ts
          .getModifiers(stmt)
          ?.some(
            (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword,
          ) ?? false)
      : false;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      let fact:
        | Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>
        | undefined;
      stmt.forEachChild(function visit(node): void {
        if (!fact && ts.isReturnStatement(node) && node.expression)
          fact = findConnectInExpression(node.expression);
        if (!fact) ts.forEachChild(node, visit);
      });
      if (fact && exported)
        out.push({
          ...fact,
          exportedName: stmt.name.text,
          sourceFile: normalizePath(filePath),
          sourceLine: lineOf(sf, stmt),
        });
    }
    if (ts.isVariableStatement(stmt))
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const fact = findConnectInExpression(decl.initializer);
        if (fact && exported)
          out.push({
            ...fact,
            exportedName: decl.name.text,
            sourceFile: normalizePath(filePath),
            sourceLine: lineOf(sourceFileAst, decl),
          });
      }
  }
  return out;
}

export async function parseServiceBindings(
  repoPath: string,
  filePath: string,
): Promise<ServiceBindingFact[]> {
  const sf = await readSource(path.join(repoPath, filePath));
  if (!sf) return [];
  const sourceFileAst = sf;
  const out: ServiceBindingFact[] = [];
  const imports = await importsFor(repoPath, filePath, sf);
  const helperCache = new Map<string, HelperBinding[]>();
  async function importedHelper(
    localName: string,
  ): Promise<{ imp: ImportBinding; helper: HelperBinding } | undefined> {
    const imp = imports.find((i) => i.localName === localName && i.sourceFile);
    if (!imp?.sourceFile) return undefined;
    if (!helperCache.has(imp.sourceFile))
      helperCache.set(
        imp.sourceFile,
        await helperBindings(repoPath, imp.sourceFile),
      );
    const helper = helperCache
      .get(imp.sourceFile)
      ?.find((h) => h.exportedName === imp.exportedName);
    return helper ? { imp, helper } : undefined;
  }
  async function recordVariable(decl: ts.VariableDeclaration): Promise<void> {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) return;
    const call = unwrapCall(decl.initializer);
    if (!call) return;
    const direct = connectFactFromCall(call);
    if (direct)
      out.push({
        variableName: decl.name.text,
        ...direct,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf(sourceFileAst, decl),
      });
    else if (ts.isIdentifier(call.expression)) {
      const resolved = await importedHelper(call.expression.text);
      if (resolved)
        out.push({
          variableName: decl.name.text,
          alias: resolved.helper.alias,
          destinationExpr: resolved.helper.destinationExpr,
          servicePathExpr: resolved.helper.servicePathExpr,
          isDynamic: resolved.helper.isDynamic,
          placeholders: resolved.helper.placeholders,
          sourceFile: normalizePath(filePath),
          sourceLine: lineOf(sourceFileAst, decl),
          helperChain: [
            {
              callerVariable: decl.name.text,
              importedHelper: call.expression.text,
              importSource: resolved.imp.sourceFile,
              exportedSymbol: resolved.imp.exportedName,
              helperSourceFile: resolved.helper.sourceFile,
              helperSourceLine: resolved.helper.sourceLine,
            },
          ],
        });
    }
  }
  const declarations: ts.VariableDeclaration[] = [];
  function collectDeclarations(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFileAst);
  for (const decl of declarations) await recordVariable(decl);
  return out;
}
