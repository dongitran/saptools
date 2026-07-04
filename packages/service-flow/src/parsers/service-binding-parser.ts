import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ServiceBindingFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';

interface HelperBinding {
  exportedName: string;
  returnedProperty?: string;
  alias?: string;
  aliasExpr?: string;
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
interface ClassHelperReturn {
  className: string;
  helperName: string;
  propertyName: string;
  variableName: string;
  fact: Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>;
  sourceLine: number;
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
  return [...(value ?? '').matchAll(/\$\{([^}]*)\}/g)]
    .map((m) => (m[1] ?? '').trim())
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
  const second = call.arguments[1];
  const objectArg = ts.isObjectLiteralExpression(first)
    ? first
    : second && ts.isObjectLiteralExpression(second)
      ? second
      : undefined;
  let alias: string | undefined;
  let aliasExpr: string | undefined;
  if (ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first))
    alias = first.text;
  else if (!ts.isObjectLiteralExpression(first))
    aliasExpr = stringValue(first);
  if (
    (ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
    !objectArg
  )
    return { alias: first.text, isDynamic: false, placeholders: [] };
  if (!objectArg && aliasExpr)
    return {
      aliasExpr,
      isDynamic: true,
      placeholders: placeholders(aliasExpr),
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
  if (objectArg) visitObject(objectArg);
  const ph = [
    ...placeholders(aliasExpr ?? alias),
    ...placeholders(destinationExpr),
    ...placeholders(servicePathExpr),
  ];
  return {
    alias,
    aliasExpr,
    destinationExpr,
    servicePathExpr,
    isDynamic: ph.length > 0 || (!destinationExpr && !servicePathExpr),
    placeholders: ph,
  };
}
function unwrapCall(expr: ts.Expression): ts.CallExpression | undefined {
  if (ts.isAwaitExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return unwrapCall(expr.expression);
  if (ts.isCallExpression(expr)) return expr;
  return undefined;
}
function unwrapIdentityExpression(expr: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expr)) return unwrapIdentityExpression(expr.expression);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return unwrapIdentityExpression(expr.expression);
  return expr;
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
  const rawBase = path.resolve(repoPath, path.dirname(fromFile), spec);
  const parsed = path.parse(rawBase);
  const base = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(parsed.ext)
    ? path.join(parsed.dir, parsed.name)
    : rawBase;
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
function collectReturnedObjectBindings(
  fn: ts.FunctionLikeDeclaration,
): Map<string, Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>> {
  const bindings = new Map<string, Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>>();
  const returns = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)))
      return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fact = findConnectInExpression(node.initializer);
      if (fact) bindings.set(node.name.text, fact);
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      for (const prop of node.expression.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) returns.set(prop.name.text, prop.name.text);
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
          const propertyName = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
          if (propertyName) returns.set(propertyName, prop.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  const out = new Map<string, Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>>();
  for (const [propertyName, variableName] of returns) {
    const fact = bindings.get(variableName);
    if (fact) out.set(propertyName, fact);
  }
  return out;
}

function functionLikeInitializer(
  expr: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  if (!expr) return undefined;
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
  return undefined;
}

function directReturnConnectFact(
  fn: ts.FunctionLikeDeclaration,
): Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> | undefined {
  const localBindings = new Map<string, Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>>();
  let returned: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)))
      return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fact = findConnectInExpression(node.initializer);
      if (fact) localBindings.set(node.name.text, fact);
    }
    if (!returned && ts.isReturnStatement(node) && node.expression)
      returned = node.expression;
    if (!returned) ts.forEachChild(node, visit);
  }
  visit(fn);
  if (!returned) return undefined;
  if (ts.isIdentifier(returned)) return localBindings.get(returned.text);
  return findConnectInExpression(returned);
}

function directConnectFactFromFunctionLike(
  fn: ts.FunctionLikeDeclaration,
): Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> | undefined {
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body))
    return findConnectInExpression(fn.body);
  return directReturnConnectFact(fn);
}

function exportedLocalNames(sf: ts.SourceFile): Map<string, string> {
  const exports = new Map<string, string>();
  for (const stmt of sf.statements) {
    const direct = ts.canHaveModifiers(stmt)
      ? (ts
          .getModifiers(stmt)
          ?.some(
            (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword,
          ) ?? false)
      : false;
    if (direct && ts.isFunctionDeclaration(stmt) && stmt.name)
      exports.set(stmt.name.text, stmt.name.text);
    if (direct && ts.isVariableStatement(stmt))
      for (const decl of stmt.declarationList.declarations)
        if (ts.isIdentifier(decl.name)) exports.set(decl.name.text, decl.name.text);
    if (!ts.isExportDeclaration(stmt) || !stmt.exportClause) continue;
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    for (const el of stmt.exportClause.elements)
      exports.set(el.name.text, el.propertyName?.text ?? el.name.text);
  }
  return exports;
}
async function helperBindings(
  repoPath: string,
  filePath: string,
): Promise<HelperBinding[]> {
  const sf = await readSource(path.join(repoPath, filePath));
  if (!sf) return [];
  const sourceFileAst = sf;
  const out: HelperBinding[] = [];
  const exportedLocals = exportedLocalNames(sf);
  const factsByLocal = new Map<
    string,
    Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'> & {
      sourceLine: number;
    }
  >();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const fact = directConnectFactFromFunctionLike(stmt);
      if (fact) factsByLocal.set(stmt.name.text, { ...fact, sourceLine: lineOf(sf, stmt) });
      for (const [returnedProperty, objectFact] of collectReturnedObjectBindings(stmt))
        factsByLocal.set(`${stmt.name.text}#${returnedProperty}`, { ...objectFact, returnedProperty, sourceLine: lineOf(sf, stmt) });
    }
    if (ts.isVariableStatement(stmt))
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const helper = functionLikeInitializer(decl.initializer);
        if (helper) {
          const directReturn = directConnectFactFromFunctionLike(helper);
          if (directReturn)
            factsByLocal.set(decl.name.text, {
              ...directReturn,
              sourceLine: lineOf(sourceFileAst, decl),
            });
          for (const [returnedProperty, objectFact] of collectReturnedObjectBindings(helper))
            factsByLocal.set(`${decl.name.text}#${returnedProperty}`, {
              ...objectFact,
              returnedProperty,
              sourceLine: lineOf(sourceFileAst, decl),
            });
          continue;
        }
        const fact = findConnectInExpression(decl.initializer);
        if (fact)
          factsByLocal.set(decl.name.text, {
            ...fact,
            sourceLine: lineOf(sourceFileAst, decl),
          });
      }
  }
  for (const [exportedName, localName] of exportedLocals) {
    const fact = factsByLocal.get(localName);
    if (fact)
      out.push({
        ...fact,
        exportedName,
        sourceFile: normalizePath(filePath),
        sourceLine: fact.sourceLine,
      });
  }
  for (const [key, fact] of factsByLocal) {
    const [localName, returnedProperty] = key.split('#');
    if (!returnedProperty) continue;
    for (const [exportedName, exportedLocal] of exportedLocals) {
      if (exportedLocal !== localName) continue;
      out.push({ ...fact, exportedName, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: fact.sourceLine });
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
  const classHelpers = collectClassHelpers(sourceFileAst);
  const localObjectHelpers = new Map<string, HelperBinding[]>();
  for (const stmt of sourceFileAst.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const rows: HelperBinding[] = [];
      for (const [returnedProperty, fact] of collectReturnedObjectBindings(stmt))
        rows.push({ ...fact, exportedName: stmt.name.text, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: lineOf(sourceFileAst, stmt) });
      if (rows.length > 0) localObjectHelpers.set(stmt.name.text, rows);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const helper = functionLikeInitializer(decl.initializer);
        if (!helper) continue;
        const rows: HelperBinding[] = [];
        for (const [returnedProperty, fact] of collectReturnedObjectBindings(helper))
          rows.push({ ...fact, exportedName: decl.name.text, returnedProperty, sourceFile: normalizePath(filePath), sourceLine: lineOf(sourceFileAst, decl) });
        if (rows.length > 0) localObjectHelpers.set(decl.name.text, rows);
      }
    }
  }
  async function importedHelpers(
    localName: string,
  ): Promise<Array<{ imp: ImportBinding; helper: HelperBinding }>> {
    const imp = imports.find((i) => i.localName === localName && i.sourceFile);
    if (!imp?.sourceFile) return [];
    if (!helperCache.has(imp.sourceFile))
      helperCache.set(
        imp.sourceFile,
        await helperBindings(repoPath, imp.sourceFile),
      );
    return (helperCache.get(imp.sourceFile) ?? [])
      .filter((h) => h.exportedName === imp.exportedName)
      .map((helper) => ({ imp, helper }));
  }
  async function importedHelper(
    localName: string,
  ): Promise<{ imp: ImportBinding; helper: HelperBinding } | undefined> {
    return (await importedHelpers(localName)).find((row) => !row.helper.returnedProperty);
  }
  function bindingForVariable(variableName: string): ServiceBindingFact | undefined {
    const sourceFile = normalizePath(filePath);
    return [...out]
      .reverse()
      .find((row) => row.variableName === variableName && row.sourceFile === sourceFile);
  }
  function cloneAliasBinding(decl: ts.VariableDeclaration, sourceName: string, aliasKind: 'identity' | 'transaction'): void {
    if (!ts.isIdentifier(decl.name)) return;
    const existing = bindingForVariable(sourceName);
    if (!existing) return;
    out.push({
      ...existing,
      variableName: decl.name.text,
      sourceLine: lineOf(sourceFileAst, decl),
      helperChain: [
        ...(existing.helperChain ?? []),
        {
          callerVariable: decl.name.text,
          aliasOf: sourceName,
          aliasKind,
          scopeRule: 'same-file-source-order',
        },
      ],
    });
  }
  function recordIdentityAlias(decl: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) return;
    const unwrapped = unwrapIdentityExpression(decl.initializer);
    if (!ts.isIdentifier(unwrapped)) return;
    cloneAliasBinding(decl, unwrapped.text, 'identity');
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
          aliasExpr: resolved.helper.aliasExpr,
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

  async function helpersForCall(call: ts.CallExpression): Promise<Array<{ helper: HelperBinding; imp?: ImportBinding }>> {
    if (!ts.isIdentifier(call.expression)) return [];
    const local = localObjectHelpers.get(call.expression.text) ?? [];
    const imported = await importedHelpers(call.expression.text);
    return [...local.map((helper) => ({ helper })), ...imported];
  }
  async function recordDestructuredHelper(decl: ts.VariableDeclaration): Promise<void> {
    if (!ts.isObjectBindingPattern(decl.name) || !decl.initializer) return;
    const call = unwrapCall(decl.initializer);
    if (!call) return;
    const helpers = await helpersForCall(call);
    if (helpers.length === 0) return;
    for (const el of decl.name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const propertyName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      const matches = helpers.filter((row) => row.helper.returnedProperty === propertyName);
      if (matches.length !== 1) continue;
      const resolved = matches[0];
      out.push({
        variableName: el.name.text,
        alias: resolved.helper.alias,
        aliasExpr: resolved.helper.aliasExpr,
        destinationExpr: resolved.helper.destinationExpr,
        servicePathExpr: resolved.helper.servicePathExpr,
        isDynamic: resolved.helper.isDynamic,
        placeholders: resolved.helper.placeholders,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf(sourceFileAst, decl),
        helperChain: [{ callerVariable: el.name.text, helperFunction: call.expression.getText(sourceFileAst), returnedProperty: propertyName, importSource: resolved.imp?.sourceFile, exportedSymbol: resolved.imp?.exportedName, helperSourceFile: resolved.helper.sourceFile, helperSourceLine: resolved.helper.sourceLine }],
      });
    }
  }
  function recordDestructuredClassHelper(decl: ts.VariableDeclaration): void {
    if (!ts.isObjectBindingPattern(decl.name) || !decl.initializer) return;
    const call = unwrapCall(decl.initializer);
    if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
    const target = call.expression;
    if (target.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    for (const el of decl.name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const propertyName = el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : el.name.text;
      const helper = classHelpers.find(
        (h) => h.helperName === target.name.text && h.propertyName === propertyName,
      );
      if (!helper) continue;
      out.push({
        variableName: el.name.text,
        ...helper.fact,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf(sourceFileAst, decl),
        helperChain: [
          {
            callerVariable: el.name.text,
            className: helper.className,
            classHelper: helper.helperName,
            returnedProperty: helper.propertyName,
            helperVariable: helper.variableName,
            helperSourceFile: normalizePath(filePath),
            helperSourceLine: helper.sourceLine,
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
  for (const decl of declarations) {
    await recordDestructuredHelper(decl);
    recordDestructuredClassHelper(decl);
    await recordVariable(decl);
    recordIdentityAlias(decl);
    if (ts.isIdentifier(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer) && ts.isPropertyAccessExpression(decl.initializer.expression) && decl.initializer.expression.name.text === 'tx' && ts.isIdentifier(decl.initializer.expression.expression)) {
      cloneAliasBinding(decl, decl.initializer.expression.expression.text, 'transaction');
    }
  }
  return out;
}

function collectClassHelpers(sf: ts.SourceFile): ClassHelperReturn[] {
  const helpers: ClassHelperReturn[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    for (const member of stmt.members) {
      if (!ts.isPropertyDeclaration(member) || !member.initializer) continue;
      if (!ts.isIdentifier(member.name)) continue;
      const className = stmt.name.text;
      const helperName = member.name.text;
      const initializer = member.initializer;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
        continue;
      const bindings = new Map<
        string,
        Omit<HelperBinding, 'exportedName' | 'sourceFile' | 'sourceLine'>
      >();
      function visit(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const fact = findConnectInExpression(node.initializer);
          if (fact) bindings.set(node.name.text, fact);
        }
        if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
          for (const prop of node.expression.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              const fact = bindings.get(prop.name.text);
              if (fact)
                helpers.push({
                  className,
                  helperName,
                  propertyName: prop.name.text,
                  variableName: prop.name.text,
                  fact,
                  sourceLine: lineOf(sf, prop),
                });
            }
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
              const propertyName =
                ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
                  ? prop.name.text
                  : undefined;
              const fact = propertyName ? bindings.get(prop.initializer.text) : undefined;
              if (propertyName && fact)
                helpers.push({
                  className,
                  helperName,
                  propertyName,
                  variableName: prop.initializer.text,
                  fact,
                  sourceLine: lineOf(sf, prop),
                });
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(initializer);
    }
  }
  return helpers;
}
