import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { HandlerRegistrationFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import type { RepositorySourceContext } from './ts-project.js';

interface ImportEvidence { importedName: string; source: string }
interface ClassEvidence { className: string; importSource?: string }
interface FileExports { arrays: Map<string, ClassEvidence[]>; defaultArray?: ClassEvidence[]; aliases: Map<string, string> }

const MAX_EXPORT_DEPTH = 5;

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
function isRelative(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}
function sourceText(node: ts.PropertyName, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return node.getText(sourceFile);
}
function importSourceFor(identifier: string, imports: Map<string, ImportEvidence>): string | undefined {
  const evidence = imports.get(identifier);
  return evidence ? `${evidence.source}#${evidence.importedName}` : undefined;
}

export async function parseHandlerRegistrations(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<HandlerRegistrationFact[]> {
  const absolutePath = path.join(repoPath, filePath);
  const snapshot = context?.get(filePath);
  const text = snapshot?.text ?? await fs.readFile(absolutePath, 'utf8');
  const sourceFile = snapshot?.sourceFile() ?? ts.createSourceFile(
    filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const imports = collectImports(sourceFile);
  const localArrays = collectLocalArrays(
    sourceFile, imports, new Map(), repoPath, filePath, context,
  );
  const out: HandlerRegistrationFact[] = [];
  function emitFromExpression(expression: ts.Expression, call: ts.CallExpression): void {
    const classes = resolveArrayExpression(
      expression, localArrays, imports, repoPath, filePath, new Set(), context,
    );
    for (const cls of classes) {
      out.push({
        className: cls.className,
        importSource: cls.importSource,
        registrationFile: normalizePath(filePath),
        registrationLine: lineOf(sourceFile, call),
        registrationKind: 'combined-handler-class',
        confidence: 0.95,
      });
    }
    if (classes.length === 0) {
      out.push({
        registrationFile: normalizePath(filePath),
        registrationLine: lineOf(sourceFile, call),
        registrationKind: 'combined-handler',
        confidence: 0.75,
      });
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isRegistrationCall(node)) {
      const handlerExpr = handlerExpression(node, sourceFile);
      if (handlerExpr) emitFromExpression(handlerExpr, node);
      else out.push({ registrationFile: normalizePath(filePath), registrationLine: lineOf(sourceFile, node), registrationKind: 'combined-handler', confidence: 0.75 });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}

function isRegistrationCall(call: ts.CallExpression): boolean {
  const text = call.expression.getText();
  return text.endsWith('createCombinedHandler') || text.endsWith('srv.prepend') || text.endsWith('cds.serve');
}
function handlerExpression(call: ts.CallExpression, sourceFile: ts.SourceFile): ts.Expression | undefined {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (sourceText(prop.name, sourceFile) === 'handler') return prop.initializer;
    }
  }
  return undefined;
}
function collectImports(sourceFile: ts.SourceFile): Map<string, ImportEvidence> {
  const imports = new Map<string, ImportEvidence>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const source = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, { importedName: 'default', source });
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) imports.set(element.name.text, { importedName: element.propertyName?.text ?? element.name.text, source });
    }
    if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { importedName: '*', source });
  }
  return imports;
}
function collectLocalArrays(sourceFile: ts.SourceFile, imports: Map<string, ImportEvidence>, seed: Map<string, ClassEvidence[]>, repoPath = '', fromFile = '', context?: RepositorySourceContext): Map<string, ClassEvidence[]> {
  const arrays = new Map(seed);
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
          arrays.set(decl.name.text, resolveArrayLiteral(
            decl.initializer, arrays, imports, repoPath, fromFile, new Set(), context,
          ));
        }
      }
    }
  }
  return arrays;
}
function resolveArrayExpression(expr: ts.Expression, arrays: Map<string, ClassEvidence[]>, imports: Map<string, ImportEvidence>, repoPath: string, fromFile: string, seen: Set<string>, context?: RepositorySourceContext): ClassEvidence[] {
  if (ts.isArrayLiteralExpression(expr)) return resolveArrayLiteral(expr, arrays, imports, repoPath, fromFile, seen, context);
  if (ts.isIdentifier(expr)) {
    const local = arrays.get(expr.text);
    if (local) return local;
    const evidence = imports.get(expr.text);
    if (evidence && isRelative(evidence.source)) return resolveImportedArray(repoPath, fromFile, evidence, seen, context);
    if (evidence) return [{ className: evidence.importedName === 'default' ? expr.text : evidence.importedName, importSource: `${evidence.source}#${evidence.importedName}` }];
  }
  return [];
}
function resolveArrayLiteral(array: ts.ArrayLiteralExpression, arrays: Map<string, ClassEvidence[]>, imports: Map<string, ImportEvidence>, repoPath: string, fromFile: string, seen: Set<string>, context?: RepositorySourceContext): ClassEvidence[] {
  const out: ClassEvidence[] = [];
  for (const element of array.elements) {
    if (ts.isSpreadElement(element)) out.push(...resolveArrayExpression(element.expression, arrays, imports, repoPath, fromFile, seen, context));
    else if (ts.isIdentifier(element)) out.push({ className: element.text, importSource: importSourceFor(element.text, imports) });
  }
  return out;
}
function resolveImportedArray(repoPath: string, fromFile: string, evidence: ImportEvidence, seen: Set<string>, context?: RepositorySourceContext): ClassEvidence[] {
  const moduleFile = resolveRelativeModule(repoPath, fromFile, evidence.source);
  if (!moduleFile) return [];
  const key = `${moduleFile}:${evidence.importedName}`;
  if (seen.has(key) || seen.size > MAX_EXPORT_DEPTH) return [];
  seen.add(key);
  const exports = readExports(repoPath, moduleFile, seen, context);
  if (evidence.importedName === 'default') return exports.defaultArray ?? [];
  return exports.arrays.get(evidence.importedName) ?? exports.arrays.get(exports.aliases.get(evidence.importedName) ?? evidence.importedName) ?? [];
}
function resolveRelativeModule(repoPath: string, fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(repoPath, path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile()) return normalizePath(path.relative(repoPath, candidate));
    } catch { /* ignore missing candidate */ }
  }
  return undefined;
}
function readExports(repoPath: string, filePath: string, seen: Set<string>, context?: RepositorySourceContext): FileExports {
  const absolute = path.join(repoPath, filePath);
  let text: string;
  const snapshot = context?.get(filePath);
  try { text = snapshot?.text ?? fsSync.readFileSync(absolute, 'utf8'); } catch { return { arrays: new Map(), aliases: new Map() }; }
  const sourceFile = snapshot?.sourceFile() ?? ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = collectImports(sourceFile);
  const arrays = collectLocalArrays(
    sourceFile, imports, new Map(), repoPath, filePath, context,
  );
  const aliases = new Map<string, string>();
  let defaultArray: ClassEvidence[] | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) defaultArray = arrays.get(statement.expression.text);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const module = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        aliases.set(element.name.text, local);
        if (module && isRelative(module)) {
          const imported = resolveImportedArray(
            repoPath, filePath, { source: module, importedName: local }, seen, context,
          );
          if (imported.length > 0) arrays.set(element.name.text, imported);
        }
      }
    }
  }
  return { arrays, defaultArray, aliases };
}
