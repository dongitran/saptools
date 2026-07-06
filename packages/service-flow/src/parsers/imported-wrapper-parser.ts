import path from 'node:path';
import ts from 'typescript';
import { classifyODataPathIntent } from '../linker/odata-path-normalizer.js';
import type { OutboundCallFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
import { importsFor, lineOf, readSource, type ImportBinding } from './service-binding-parser-helpers.js';
import {
  analyzeOperationPath,
  operationPathExpression,
  pathUnresolvedReason,
} from './operation-path-analysis.js';

interface WrapperSpec {
  clientIndex: number;
  pathIndex: number;
  methodIndex?: number;
  methodLiteral?: string;
  sourceFile: string;
  sourceLine: number;
  chain: string[];
}

export async function parseImportedWrapperCalls(
  repoPath: string,
  filePath: string,
  source: ts.SourceFile,
  serviceBindings: Set<string>,
): Promise<OutboundCallFact[]> {
  const imports = await importsFor(repoPath, filePath, source);
  const importedByLocal = new Map(imports.filter((item) => item.sourceFile).map((item) => [item.localName, item]));
  const calls = collectImportedCalls(source, importedByLocal);
  const out: OutboundCallFact[] = [];
  const cache = new Map<string, Promise<WrapperSpec | undefined>>();
  for (const call of calls) {
    if (!ts.isIdentifier(call.expression)) continue;
    const imported = importedByLocal.get(call.expression.text);
    if (!imported?.sourceFile) continue;
    const spec = await loadWrapperSpec(repoPath, imported, cache, 0);
    const fact = spec ? wrapperCallFact(source, filePath, call, spec, serviceBindings) : undefined;
    if (fact) out.push(fact);
  }
  return out;
}

function collectImportedCalls(source: ts.SourceFile, imports: Map<string, ImportBinding>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imports.has(node.expression.text)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

async function loadWrapperSpec(
  repoPath: string,
  imported: ImportBinding,
  cache: Map<string, Promise<WrapperSpec | undefined>>,
  depth: number,
): Promise<WrapperSpec | undefined> {
  if (!imported.sourceFile || depth > 5) return undefined;
  const key = `${imported.sourceFile}#${imported.exportedName}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = inspectWrapper(repoPath, imported.sourceFile, imported.exportedName, cache, depth);
  cache.set(key, pending);
  return pending;
}

async function inspectWrapper(
  repoPath: string,
  sourceFile: string,
  exportedName: string,
  cache: Map<string, Promise<WrapperSpec | undefined>>,
  depth: number,
): Promise<WrapperSpec | undefined> {
  const source = await readSource(path.join(repoPath, sourceFile));
  if (!source) return undefined;
  const named = findFunction(source, exportedName);
  if (!named) return undefined;
  const direct = directSendSpec(source, sourceFile, named.name, named.fn);
  if (direct) return direct;
  return nestedSendSpec(repoPath, sourceFile, source, named.name, named.fn, cache, depth);
}

function directSendSpec(source: ts.SourceFile, sourceFile: string, name: string, fn: ts.FunctionLikeDeclaration): WrapperSpec | undefined {
  const params = parameterNames(fn);
  const sends: ts.CallExpression[] = [];
  visitFunctionBody(fn, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'send') sends.push(node);
  });
  if (sends.length !== 1) return undefined;
  const send = sends[0];
  const receiver = send && ts.isPropertyAccessExpression(send.expression) && ts.isIdentifier(send.expression.expression) ? send.expression.expression.text : undefined;
  const object = send?.arguments[0];
  if (!receiver || !object || !ts.isObjectLiteralExpression(object)) return undefined;
  const pathExpr = propertyExpression(object, 'path');
  const methodExpr = propertyExpression(object, 'method');
  const pathName = pathExpr && ts.isIdentifier(pathExpr) ? pathExpr.text : undefined;
  const clientIndex = params.indexOf(receiver);
  const pathIndex = pathName ? params.indexOf(pathName) : -1;
  if (clientIndex < 0 || pathIndex < 0) return undefined;
  const methodName = methodExpr && ts.isIdentifier(methodExpr) ? methodExpr.text : undefined;
  const methodIndex = methodName ? params.indexOf(methodName) : -1;
  return { clientIndex, pathIndex, methodIndex: methodIndex >= 0 ? methodIndex : undefined, methodLiteral: literal(methodExpr), sourceFile, sourceLine: lineOf(source, fn), chain: [name] };
}

async function nestedSendSpec(
  repoPath: string,
  sourceFile: string,
  source: ts.SourceFile,
  name: string,
  fn: ts.FunctionLikeDeclaration,
  cache: Map<string, Promise<WrapperSpec | undefined>>,
  depth: number,
): Promise<WrapperSpec | undefined> {
  const imports = await importsFor(repoPath, sourceFile, source);
  const byLocal = new Map(imports.filter((item) => item.sourceFile).map((item) => [item.localName, item]));
  const calls: ts.CallExpression[] = [];
  visitFunctionBody(fn, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && byLocal.has(node.expression.text)) calls.push(node);
  });
  if (calls.length !== 1) return undefined;
  const call = calls[0];
  const imported = call && ts.isIdentifier(call.expression) ? byLocal.get(call.expression.text) : undefined;
  const nested = imported ? await loadWrapperSpec(repoPath, imported, cache, depth + 1) : undefined;
  if (!call || !nested) return undefined;
  const params = parameterNames(fn);
  const clientIndex = mappedParameterIndex(call.arguments[nested.clientIndex], params);
  const pathIndex = mappedParameterIndex(call.arguments[nested.pathIndex], params);
  if (clientIndex < 0 || pathIndex < 0) return undefined;
  const methodIndex = nested.methodIndex === undefined ? undefined : mappedParameterIndex(call.arguments[nested.methodIndex], params);
  return { clientIndex, pathIndex, methodIndex: methodIndex !== undefined && methodIndex >= 0 ? methodIndex : undefined, methodLiteral: nested.methodLiteral, sourceFile, sourceLine: lineOf(source, fn), chain: [name, ...nested.chain] };
}

function wrapperCallFact(
  source: ts.SourceFile,
  filePath: string,
  call: ts.CallExpression,
  spec: WrapperSpec,
  serviceBindings: Set<string>,
): OutboundCallFact | undefined {
  const client = call.arguments[spec.clientIndex];
  if (!client || !ts.isIdentifier(client) || !serviceBindings.has(client.text)) return undefined;
  const methodValue = spec.methodIndex === undefined ? spec.methodLiteral : literal(call.arguments[spec.methodIndex]);
  const method = (methodValue ?? 'POST').toUpperCase();
  const pathAnalysis = analyzeOperationPath(call.arguments[spec.pathIndex], call, method);
  const operationPathExpr = operationPathExpression(pathAnalysis);
  const unresolvedReason = pathUnresolvedReason(pathAnalysis);
  return {
    callType: 'remote_action',
    serviceVariableName: client.text,
    method,
    operationPathExpr,
    payloadSummary: call.getText(source),
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(source, call),
    confidence: operationPathExpr ? 0.85 : 0.5,
    unresolvedReason,
    evidence: {
      parser: 'typescript_ast',
      classifier: importedWrapperClassifier(pathAnalysis.status),
      receiver: client.text,
      wrapperFunction: spec.chain[0],
      wrapperChain: spec.chain,
      callerSite: { sourceFile: normalizePath(filePath), sourceLine: lineOf(source, call) },
      calleeSite: { sourceFile: spec.sourceFile, sourceLine: spec.sourceLine },
      rawPathExpression: pathAnalysis.rawExpression,
      missingPathIdentifier: pathAnalysis.runtimeIdentifier,
      pathAnalysis,
      odataPathIntent: operationPathExpr
        ? classifyODataPathIntent(operationPathExpr, method)
        : undefined,
    },
  };
}

function importedWrapperClassifier(status: string): string {
  if (status === 'static') return 'imported_wrapper_literal_path';
  if (status === 'ambiguous') return 'imported_wrapper_ambiguous_path';
  return 'imported_wrapper_dynamic_path';
}

function findFunction(source: ts.SourceFile, exportedName: string): { name: string; fn: ts.FunctionLikeDeclaration } | undefined {
  const localName = exportedLocalName(source, exportedName);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName) return { name: exportedName, fn: statement };
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === localName && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return { name: exportedName, fn: declaration.initializer };
    }
  }
  return undefined;
}

function exportedLocalName(source: ts.SourceFile, exportedName: string): string {
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const match = statement.exportClause.elements.find((item) => item.name.text === exportedName);
    if (match) return match.propertyName?.text ?? match.name.text;
  }
  return exportedName;
}

function visitFunctionBody(fn: ts.FunctionLikeDeclaration, visitor: (node: ts.Node) => void): void {
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    visitor(node);
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
}

function parameterNames(fn: ts.FunctionLikeDeclaration): string[] {
  return fn.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : '');
}

function mappedParameterIndex(expr: ts.Expression | undefined, parameters: string[]): number {
  return expr && ts.isIdentifier(expr) ? parameters.indexOf(expr.text) : -1;
}

function propertyExpression(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === key) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function literal(expr: ts.Expression | undefined): string | undefined {
  return expr && (ts.isStringLiteralLike(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) ? expr.text : undefined;
}
