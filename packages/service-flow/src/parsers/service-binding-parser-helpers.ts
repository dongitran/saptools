import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { normalizePath } from '../utils/path-utils.js';
import { extractPlaceholderKeys } from '../utils/001-placeholders.js';
import type { RepositorySourceContext } from './ts-project.js';

export interface HelperBinding {
  exportedName: string;
  returnedProperty?: string;
  alias?: string;
  aliasExpr?: string;
  destinationExpr?: string;
  servicePathExpr?: string;
  isDynamic: boolean;
  placeholders: string[];
  helperChain?: Array<Record<string, unknown>>;
  sourceFile: string;
  sourceLine: number;
}
export interface ImportBinding {
  localName: string;
  exportedName: string;
  sourceFile?: string;
}
export interface ClassHelperReturn {
  className: string;
  helperName: string;
  propertyName: string;
  variableName: string;
  fact: Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>;
  sourceLine: number;
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().replace(/^`|`$/g, '');
  return node.getText();
}

function placeholders(value?: string): string[] {
  return extractPlaceholderKeys(value);
}

export function connectFactFromCall(call: ts.CallExpression): Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> | undefined {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'to') return undefined;
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== 'connect' || inner.expression.getText() !== 'cds') return undefined;
  const first = call.arguments[0];
  if (!first) return undefined;
  const second = call.arguments[1];
  const objectArg = ts.isObjectLiteralExpression(first) ? first : second && ts.isObjectLiteralExpression(second) ? second : undefined;
  let alias: string | undefined;
  let aliasExpr: string | undefined;
  if (ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first)) alias = first.text;
  else if (!ts.isObjectLiteralExpression(first)) aliasExpr = stringValue(first);
  if ((ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first)) && !objectArg) return { alias: first.text, isDynamic: false, placeholders: [] };
  if (!objectArg && aliasExpr) return { aliasExpr, isDynamic: true, placeholders: placeholders(aliasExpr) };
  const expressions = objectArg ? objectExpressions(objectArg) : {};
  const ph = [...placeholders(aliasExpr ?? alias), ...placeholders(expressions.destinationExpr), ...placeholders(expressions.servicePathExpr)];
  return { alias, aliasExpr, ...expressions, isDynamic: ph.length > 0 || (!expressions.destinationExpr && !expressions.servicePathExpr), placeholders: ph };
}

function objectExpressions(objectArg: ts.ObjectLiteralExpression): { destinationExpr?: string; servicePathExpr?: string } {
  const out: { destinationExpr?: string; servicePathExpr?: string } = {};
  function visitObject(obj: ts.ObjectLiteralExpression): void {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
      if (name === 'destination') out.destinationExpr = stringValue(prop.initializer);
      if (name === 'path' || name === 'servicePath') out.servicePathExpr = stringValue(prop.initializer);
      if (ts.isObjectLiteralExpression(prop.initializer)) visitObject(prop.initializer);
    }
  }
  visitObject(objectArg);
  return out;
}

export function unwrapCall(expr: ts.Expression): ts.CallExpression | undefined {
  if (ts.isAwaitExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isTypeAssertionExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isCallExpression(expr)) return expr;
  return undefined;
}

export function unwrapIdentityExpression(expr: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts.isTypeAssertionExpression(expr)) return unwrapIdentityExpression(expr.expression);
  return expr;
}

export function transactionReceiverName(expr: ts.Expression): string | undefined {
  const call = unwrapCall(expr);
  if (call && ts.isPropertyAccessExpression(call.expression) && ['tx', 'transaction'].includes(call.expression.name.text) && ts.isIdentifier(call.expression.expression)) return call.expression.expression.text;
  const unwrapped = unwrapIdentityExpression(expr);
  if (!ts.isConditionalExpression(unwrapped)) return undefined;
  const left = transactionReceiverName(unwrapped.whenTrue);
  const right = transactionReceiverName(unwrapped.whenFalse);
  return left && left === right ? left : undefined;
}

export function findConnectInExpression(expr: ts.Expression): Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> | undefined {
  const direct = unwrapCall(expr);
  if (direct) {
    const fact = connectFactFromCall(direct);
    if (fact) return fact;
  }
  let found: Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node)) found = connectFactFromCall(node);
    if (!found) ts.forEachChild(node, visit);
  }
  visit(expr);
  return found;
}

export async function readSource(
  abs: string,
  context?: RepositorySourceContext,
  filePath?: string,
): Promise<ts.SourceFile | undefined> {
  const snapshot = filePath ? context?.get(filePath) : undefined;
  if (snapshot) return snapshot.sourceFile();
  try {
    const text = await fs.readFile(abs, 'utf8');
    return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return undefined;
  }
}

async function resolveImport(repoPath: string, fromFile: string, spec: string): Promise<string | undefined> {
  if (!spec.startsWith('.')) return undefined;
  const rawBase = path.resolve(repoPath, path.dirname(fromFile), spec);
  const parsed = path.parse(rawBase);
  const base = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(parsed.ext) ? path.join(parsed.dir, parsed.name) : rawBase;
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isFile()) return normalizePath(path.relative(repoPath, candidate));
  }
  return undefined;
}

export async function importsFor(repoPath: string, filePath: string, sf: ts.SourceFile): Promise<ImportBinding[]> {
  const imports: ImportBinding[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const sourceFile = await resolveImport(repoPath, filePath, stmt.moduleSpecifier.text);
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) imports.push({ localName: clause.name.text, exportedName: 'default', sourceFile });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements) imports.push({ localName: el.name.text, exportedName: el.propertyName?.text ?? el.name.text, sourceFile });
  }
  return imports;
}
