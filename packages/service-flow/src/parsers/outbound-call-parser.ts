import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { externalHttpTarget } from '../linker/external-http-target.js';
import type { OutboundCallFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
import { summarizeExpression } from '../utils/redaction.js';
import { classifyODataPathIntent } from '../linker/odata-path-normalizer.js';
import { parseServiceBindings } from './service-binding-parser.js';
import { parseImportedWrapperCalls } from './imported-wrapper-parser.js';
import type { RepositorySourceContext } from './ts-project.js';
import {
  analyzeOperationPath,
  operationPathExpression,
  pathUnresolvedReason,
  type OperationPathAnalysis,
} from './operation-path-analysis.js';
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}
function entityFromExpression(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isIdentifier(expr) || ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && expr.argumentExpression && (ts.isStringLiteral(expr.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expr.argumentExpression))) return expr.argumentExpression.text;
  return undefined;
}
function expressionName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${expressionName(expr.expression)}.${expr.name.text}`;
  return expr.getText();
}
function variableInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}
function queryEntityFromAst(expr: ts.Expression, initializers = new Map<string, ts.Expression>()): string | undefined {
  if (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) return queryEntityFromAst(expr.expression, initializers);
  if (ts.isIdentifier(expr) && initializers.has(expr.text)) return queryEntityFromAst(initializers.get(expr.text) as ts.Expression, initializers);
  if (ts.isCallExpression(expr)) {
    const name = expressionName(expr.expression);
    if (name === 'cds.run') return queryEntityFromAst(expr.arguments[0], initializers);
    if (['SELECT.one.from', 'SELECT.from', 'SELECT.one', 'INSERT.into', 'UPSERT.into', 'DELETE.from', 'UPDATE.entity'].includes(name)) return entityFromExpression(expr.arguments[0]);
    if (name === 'UPDATE') return entityFromExpression(expr.arguments[0]);
    const receiver = ts.isPropertyAccessExpression(expr.expression) ? expr.expression.expression : undefined;
    if (receiver) return queryEntityFromAst(receiver, initializers);
  }
  return undefined;
}
function extractQueryEntity(expr: string): string | undefined {
  const source = ts.createSourceFile('query.ts', `const __query = (${expr});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializers = variableInitializers(source);
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isParenthesizedExpression(node)) found = queryEntityFromAst(node.expression, initializers);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function queryWarning(expr: string): string {
  if (/^\s*[`'"]/.test(expr)) return 'raw_sql_or_cql_expression';
  if (/^\s*\w+\s*$/.test(expr)) return 'query_variable_without_static_initializer';
  return 'dynamic_entity_expression';
}
export interface ClassifiedOutboundCall {
  fact: OutboundCallFact;
  node: ts.CallExpression;
}
function parserEvidence(source: ts.SourceFile, node: ts.CallExpression, extra?: Record<string, unknown>): Record<string, unknown> {
  return { parser: 'typescript_ast', startOffset: node.getStart(source), endOffset: node.getEnd(), ...extra };
}
function isStringLike(expr: ts.Expression | undefined): expr is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return Boolean(expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)));
}
function literalText(expr: ts.Expression | undefined): string | undefined {
  if (isStringLike(expr)) return expr.text;
  return undefined;
}
function objectPropertyText(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  const prop = object.properties.find((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
    (ts.isPropertyAssignment(property) && nameOfProperty(property.name) === key) || (ts.isShorthandPropertyAssignment(property) && property.name.text === key),
  );
  if (!prop) return undefined;
  return ts.isShorthandPropertyAssignment(prop) ? prop.name.text : prop.initializer.getText();
}
function objectPropertyIsShorthand(object: ts.ObjectLiteralExpression, key: string): boolean {
  return object.properties.some((property) => ts.isShorthandPropertyAssignment(property) && property.name.text === key);
}
function nameOfProperty(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

type ExpressionStatus = 'static' | 'dynamic' | 'ambiguous' | 'unknown';
type ExpressionSourceKind = 'string_literal' | 'no_substitution_template' | 'template_with_substitutions' | 'const_alias' | 'conditional_candidates' | 'dynamic_expression';
interface ExpressionResolution { status: ExpressionStatus; sourceKind: ExpressionSourceKind; value?: string; rawExpression?: string; placeholderKeys: string[]; evidence: string[]; constName?: string }
interface BindingResolution { declaration?: ts.VariableDeclaration | ts.ParameterDeclaration; initializer?: ts.Expression; immutable: boolean; evidence: string[] }
const maxAliasDepth = 5;
function safeRaw(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isIdentifier(expr) || ts.isTemplateExpression(expr)) return expr.getText(expr.getSourceFile());
  return undefined;
}
function placeholders(expr: ts.TemplateExpression): string[] {
  return expr.templateSpans.map((span) => span.expression.getText(expr.getSourceFile()));
}
function isFunctionLikeScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isSourceFile(node);
}
function nodeContains(parent: ts.Node, child: ts.Node): boolean {
  const source = child.getSourceFile();
  return child.getStart(source) >= parent.getStart(source) && child.getEnd() <= parent.getEnd();
}
function declarationScope(node: ts.VariableDeclaration | ts.ParameterDeclaration): ts.Node {
  if (ts.isParameter(node)) return node.parent;
  if (ts.isCatchClause(node.parent) && node.parent.variableDeclaration === node) return node.parent;
  const list = node.parent;
  const blockScoped = (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
  let current: ts.Node = list.parent;
  if (!blockScoped) {
    while (current.parent && !isFunctionLikeScope(current)) current = current.parent;
    return current;
  }
  while (current.parent && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isModuleBlock(current) && !ts.isCaseBlock(current) && !isLoopInitializerScope(node, current) && !isFunctionLikeScope(current)) current = current.parent;
  return current;
}
function isLoopInitializerScope(declaration: ts.VariableDeclaration, scope: ts.Node): boolean {
  const list = declaration.parent;
  return (ts.isForStatement(scope) && scope.initializer === list) || ((ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer === list);
}
function catchBindingScope(declaration: ts.VariableDeclaration | ts.ParameterDeclaration): ts.CatchClause | undefined {
  if (ts.isParameter(declaration)) return undefined;
  return ts.isCatchClause(declaration.parent) && declaration.parent.variableDeclaration === declaration ? declaration.parent : undefined;
}
function isAccessibleDeclaration(declaration: ts.VariableDeclaration | ts.ParameterDeclaration, use: ts.Node): boolean {
  const source = use.getSourceFile();
  if (declaration.name.getStart(source) >= use.getStart(source)) return false;
  const catchScope = catchBindingScope(declaration);
  if (catchScope) return nodeContains(catchScope.block, use);
  const scope = declarationScope(declaration);
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) return nodeContains(scope.statement, use);
  return ts.isSourceFile(scope) || nodeContains(scope, use);
}
function resolveBinding(identifier: ts.Identifier, use: ts.Node): BindingResolution {
  const source = use.getSourceFile();
  let best: ts.VariableDeclaration | ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text && isAccessibleDeclaration(node, use)) best = node;
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text && isAccessibleDeclaration(node, use)) best = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!best) return { immutable: false, evidence: ['binding_not_found'] };
  const immutable = ts.isVariableDeclaration(best) && (best.parent.flags & ts.NodeFlags.Const) !== 0;
  return { declaration: best, initializer: ts.isVariableDeclaration(best) ? best.initializer : undefined, immutable, evidence: [immutable ? 'lexical_const_binding_before_use' : 'lexical_mutable_or_parameter_binding'] };
}
function resolveExpression(expr: ts.Expression | undefined, use: ts.Node, policy: 'operation_path' | 'external' | 'literal', depth = 0, seen = new Set<ts.Node>()): ExpressionResolution {
  if (!expr) return { status: 'unknown', sourceKind: 'dynamic_expression', placeholderKeys: [], evidence: ['expression_missing'] };
  if (ts.isStringLiteral(expr)) return { status: 'static', sourceKind: 'string_literal', value: expr.text, rawExpression: safeRaw(expr), placeholderKeys: [], evidence: ['string_literal'] };
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return { status: 'static', sourceKind: 'no_substitution_template', value: expr.text, rawExpression: safeRaw(expr), placeholderKeys: [], evidence: ['no_substitution_template'] };
  if (ts.isTemplateExpression(expr)) {
    const keys = placeholders(expr);
    if (policy === 'operation_path') return { status: 'dynamic', sourceKind: 'template_with_substitutions', value: stripQuotes(expr.getText(expr.getSourceFile())), rawExpression: safeRaw(expr), placeholderKeys: keys, evidence: ['operation_path_template_placeholders_retained'] };
    return { status: 'dynamic', sourceKind: 'template_with_substitutions', placeholderKeys: keys, evidence: ['template_substitutions_not_static_external_target'] };
  }
  if (ts.isIdentifier(expr)) {
    if (depth >= maxAliasDepth) return { status: 'unknown', sourceKind: 'const_alias', rawExpression: safeRaw(expr), placeholderKeys: [], evidence: ['alias_depth_exceeded'], constName: expr.text };
    const binding = resolveBinding(expr, use);
    if (!binding.declaration || !binding.initializer || !binding.immutable) return { status: 'dynamic', sourceKind: 'dynamic_expression', rawExpression: safeRaw(expr), placeholderKeys: [], evidence: binding.evidence, constName: expr.text };
    if (seen.has(binding.declaration)) return { status: 'unknown', sourceKind: 'const_alias', rawExpression: safeRaw(expr), placeholderKeys: [], evidence: ['alias_cycle_detected'], constName: expr.text };
    seen.add(binding.declaration);
    const resolved = resolveExpression(binding.initializer, binding.declaration, policy, depth + 1, seen);
    return { ...resolved, sourceKind: 'const_alias', rawExpression: safeRaw(expr), constName: expr.text, evidence: [...binding.evidence, ...resolved.evidence] };
  }
  return { status: 'dynamic', sourceKind: 'dynamic_expression', rawExpression: safeRaw(expr), placeholderKeys: [], evidence: [`unsupported_${ts.SyntaxKind[expr.kind] ?? 'expression'}`] };
}
function staticExpressionText(expr: ts.Expression | undefined, initializers: Map<string, ts.Expression>): string | undefined {
  if (!expr) return undefined;
  if (isStringLike(expr)) return expr.text;
  if (ts.isIdentifier(expr) && initializers.has(expr.text)) return staticExpressionText(initializers.get(expr.text), initializers);
  return undefined;
}
function operationPathFromStatic(text: string | undefined): string | undefined {
  return text ? `/${stripQuotes(text).replace(/^\//, '')}` : undefined;
}
function destinationExpressionShape(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isIdentifier(expr)) return 'identifier';
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return 'property_read';
  if (ts.isCallExpression(expr)) return 'function_call';
  if (ts.isConditionalExpression(expr)) return 'conditional';
  if (ts.isBinaryExpression(expr)) return 'binary_expression';
  if (ts.isTemplateExpression(expr)) return 'template_expression';
  return ts.SyntaxKind[expr.kind] ?? 'expression';
}
function staticConditionalCandidates(expr: ts.Expression | undefined, initializers: Map<string, ts.Expression>): string[] | undefined {
  const resolved = expr && ts.isIdentifier(expr) && initializers.has(expr.text) ? initializers.get(expr.text) : expr;
  if (!resolved || !ts.isConditionalExpression(resolved)) return undefined;
  const left = staticExpressionText(resolved.whenTrue, initializers);
  const right = staticExpressionText(resolved.whenFalse, initializers);
  if (!left || !right) return undefined;
  return [...new Set([left, right])];
}
function propertyInitializer(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && nameOfProperty(property.name) === key) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
  }
  return undefined;
}
function httpMethodFromObject(object: ts.ObjectLiteralExpression, use: ts.Node): string | undefined {
  const text = resolveExpression(propertyInitializer(object, 'method'), use, 'literal').value;
  return text ? stripQuotes(text).toUpperCase() : undefined;
}
const supportedHttpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
function safeOperationName(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$]*)*$/.test(value)) return undefined;
  return operationPathFromStatic(value);
}
function wrapperSourceKind(sourceKind: string): string {
  if (sourceKind.includes('const_alias')) return 'const';
  if (sourceKind.includes('template')) return 'template';
  if (sourceKind.includes('string_literal')) return 'literal';
  return sourceKind.includes('conditional') ? 'ambiguous' : 'dynamic';
}
function literalPathSource(analysis: OperationPathAnalysis): string | undefined {
  if (analysis.status !== 'static') return undefined;
  if (analysis.sourceKind.includes('const_alias')) return 'same_scope_const_initializer';
  if (analysis.sourceKind.includes('no_substitution_template')) return 'template';
  return analysis.sourceKind.includes('string_literal') ? 'literal' : analysis.sourceKind;
}
function legacyPathCandidates(analysis: OperationPathAnalysis): Record<string, unknown> | undefined {
  if (analysis.candidateRawPaths.length < 2 && analysis.dynamicReassignments.length === 0)
    return undefined;
  return {
    candidatePaths: analysis.candidateRawPaths,
    normalizedCandidateOperations: analysis.candidateNormalizedOperationPaths
      .map((value) => value.replace(/^\//, '')),
    candidateSourceKind: analysis.sourceKind,
    candidateIdentifier: analysis.candidateIdentifier,
    hasDynamicAssignments: analysis.dynamicReassignments.length > 0,
    conservativeReason: analysis.dynamicReassignments.length > 0
      ? 'dynamic_assignment_observed'
      : 'candidate_tie',
  };
}
function hasTemplatePlaceholder(value: string): boolean { return /\$\{|%7B|%7D/i.test(value); }
function urlTargetFromExpression(expr: ts.Expression | undefined, use: ts.Node): Record<string, unknown> {
  const resolved = resolveExpression(expr, use, 'external');
  if (resolved.status === 'static' && resolved.value && !hasTemplatePlaceholder(resolved.value)) return { kind: 'static_url', expression: resolved.value, dynamic: false, sourceKind: resolved.sourceKind };
  if (expr) return { kind: 'url_expression', dynamic: true, expression: `${resolved.sourceKind}:${resolved.placeholderKeys.join('|')}`, expressionShape: resolved.sourceKind, placeholderKeys: resolved.placeholderKeys };
  return { kind: 'unknown', dynamic: false };
}
function destinationTargetFromExpression(expr: ts.Expression | undefined, use: ts.Node): Record<string, unknown> | undefined {
  const resolved = resolveExpression(expr, use, 'external');
  const text = resolved.value;
  if (resolved.status === 'static' && text && !hasTemplatePlaceholder(text)) return { kind: 'destination', expression: text, dynamic: false, sourceKind: resolved.sourceKind };
  const candidates = staticConditionalCandidates(expr, new Map<string, ts.Expression>());
  if (candidates) return { kind: 'destination', dynamic: true, expressionShape: 'conditional', candidateLiterals: candidates };
  const shape = destinationExpressionShape(expr);
  if (shape) return { kind: 'destination', dynamic: true, expressionShape: shape };
  return undefined;
}
function externalHttpEvidence(node: ts.CallExpression, source: ts.SourceFile): { method?: string; externalTarget: Record<string, unknown>; classifier: string; sourceCallShape: string } | undefined {
  const expr = node.expression;
  const exprText = expr.getText(source);
  if (exprText === 'useOrFetchDestination') {
    const objectArg = node.arguments[0];
    if (objectArg && ts.isObjectLiteralExpression(objectArg)) {
      const destination = destinationTargetFromExpression(propertyInitializer(objectArg, 'destinationName'), node);
      return { externalTarget: destination ?? { kind: 'unknown', dynamic: false }, classifier: 'sap_destination_lookup', sourceCallShape: 'useOrFetchDestination' };
    }
  }
  if (exprText === 'executeHttpRequest') {
    const destination = destinationTargetFromExpression(node.arguments[0], node);
    const config = node.arguments[1];
    const method = config && ts.isObjectLiteralExpression(config) ? httpMethodFromObject(config, node) : undefined;
    const url = config && ts.isObjectLiteralExpression(config) ? urlTargetFromExpression(propertyInitializer(config, 'url'), node) : { kind: 'unknown', dynamic: false };
    return { method, externalTarget: destination ? { ...url, destination } : url, classifier: 'sap_execute_http_request', sourceCallShape: 'executeHttpRequest' };
  }
  if (exprText === 'axios') {
    const config = node.arguments[0];
    if (config && ts.isObjectLiteralExpression(config)) {
      const method = httpMethodFromObject(config, node);
      return { method, externalTarget: urlTargetFromExpression(propertyInitializer(config, 'url'), node), classifier: 'axios_config_call', sourceCallShape: 'axios(config)' };
    }
    return { externalTarget: { kind: 'unknown', dynamic: false }, classifier: 'axios_unknown_call', sourceCallShape: 'axios(...)' };
  }
  if (exprText === 'fetch') {
    const init = node.arguments[1];
    const method = init && ts.isObjectLiteralExpression(init) ? httpMethodFromObject(init, node) : undefined;
    return { method, externalTarget: urlTargetFromExpression(node.arguments[0], node), classifier: 'fetch_call', sourceCallShape: 'fetch' };
  }
  if (ts.isPropertyAccessExpression(expr) && ['get','post','put','patch','delete','head'].includes(expr.name.text) && expr.expression.getText(source) === 'axios') {
    return { method: expr.name.text.toUpperCase(), externalTarget: urlTargetFromExpression(node.arguments[0], node), classifier: 'axios_member_call', sourceCallShape: `axios.${expr.name.text}` };
  }
  return undefined;
}

function collectServiceVariables(source: ts.SourceFile): Set<string> {
  const vars = new Set<string>(['cds', 'messaging', 'messageClient', 'eventClient']);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = node.initializer.getText(source);
      if (/cds\.connect\.(to|messaging)\s*\(/.test(text)) vars.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return vars;
}
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.getText(sourceOf(expr));
  return undefined;
}
function sourceOf(node: ts.Node): ts.SourceFile {
  return node.getSourceFile();
}
function rootReceiverName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return rootReceiverName(expr.expression);
  if (ts.isCallExpression(expr)) return rootReceiverName(expr.expression);
  return undefined;
}
function isSupportedEventReceiver(receiver: string | undefined, rootReceiver: string | undefined, serviceVariables: Set<string>): boolean {
  const candidate = rootReceiver ?? receiver;
  if (!candidate) return false;
  if (candidate === 'cds') return true;
  if (serviceVariables.has(candidate)) return true;
  if (receiver && serviceVariables.has(receiver)) return true;
  if (/^(srv|service|serviceClient|messaging|messageClient|eventClient)$/.test(candidate)) return true;
  return false;
}
interface WrapperSpec { clientIndex?: number; clientName?: string; pathIndex: number; methodIndex?: number; methodName?: string; methodLiteral?: string; nestedWrapperFunction?: string; definitionLine: number; internalStart: number; internalEnd: number }
function collectWrapperSpecs(source: ts.SourceFile): Map<string, WrapperSpec> {
  const specs = new Map<string, WrapperSpec>();
  const serviceVariables = collectServiceVariables(source);
  const calledNames = new Set<string>();
  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      calledNames.add(node.expression.text);
    if (ts.isCallExpression(node) && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression))
      calledNames.add(node.expression.expression.text);
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(source);
  const scanFunction = (name: string, fn: ts.FunctionLikeDeclaration): void => {
    if (!calledNames.has(name) && !isExportedWrapper(fn)) return;
    const params = fn.parameters.map((param) => ts.isIdentifier(param.name) ? param.name.text : undefined);
    const sends: Array<{ client: string; path: string; method?: string; methodLiteral?: string; nestedWrapperFunction?: string; start: number; end: number }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'send' && ts.isIdentifier(node.expression.expression)) {
        const objectArg = node.arguments[0];
        if (objectArg && ts.isObjectLiteralExpression(objectArg)) {
          const pathProp = propertyInitializer(objectArg, 'path');
          const methodProp = propertyInitializer(objectArg, 'method');
          const pathName = pathProp && ts.isIdentifier(pathProp) ? pathProp.text : undefined;
          const methodName = methodProp && ts.isIdentifier(methodProp) ? methodProp.text : undefined;
          const methodLiteral = resolveExpression(methodProp, node, 'literal').value;
          if (pathName) sends.push({ client: node.expression.expression.text, path: pathName, method: methodName, methodLiteral, start: node.getStart(source), end: node.getEnd() });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && specs.has(node.expression.text)) {
        const nested = specs.get(node.expression.text);
        const pathArg = nested ? node.arguments[nested.pathIndex] : undefined;
        const clientArg = nested?.clientIndex === undefined ? undefined : node.arguments[nested.clientIndex];
        const pathName = pathArg && ts.isIdentifier(pathArg) ? pathArg.text : undefined;
        const clientName = clientArg && ts.isIdentifier(clientArg) ? clientArg.text : nested?.clientName;
        if (nested && pathName && clientName) sends.push({ client: clientName, path: pathName, method: nested.methodName, methodLiteral: nested.methodLiteral, nestedWrapperFunction: node.expression.text, start: node.getStart(source), end: node.getEnd() });
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    if (sends.length !== 1) return;
    const found = sends[0];
    const clientIndex = params.indexOf(found.client);
    const pathIndex = params.indexOf(found.path);
    const methodIndex = found.method ? params.indexOf(found.method) : -1;
    const capturesKnownClient = serviceVariables.has(found.client) || /^(srv|service|serviceClient|client|.*Client)$/.test(found.client);
    if (pathIndex >= 0 && (clientIndex >= 0 || capturesKnownClient)) specs.set(name, { clientIndex: clientIndex >= 0 ? clientIndex : undefined, clientName: clientIndex >= 0 ? undefined : found.client, pathIndex, methodIndex: methodIndex >= 0 ? methodIndex : undefined, methodName: found.method, methodLiteral: found.methodLiteral, nestedWrapperFunction: found.nestedWrapperFunction, definitionLine: lineOf(source.text, fn.getStart(source)), internalStart: found.start, internalEnd: found.end });
  };
  const visitTop = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) scanFunction(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) scanFunction(node.name.text, node.initializer);
    ts.forEachChild(node, visitTop);
  };
  visitTop(source);
  return specs;
}
function isExportedWrapper(fn: ts.FunctionLikeDeclaration): boolean {
  const declaration = ts.isFunctionDeclaration(fn)
    ? fn
    : ts.isVariableDeclaration(fn.parent)
      ? fn.parent.parent.parent
      : undefined;
  if (!declaration || !ts.canHaveModifiers(declaration)) return false;
  return ts.getModifiers(declaration)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
export function classifyOutboundCallsInSource(source: ts.SourceFile, filePath: string): ClassifiedOutboundCall[] {
  const calls: ClassifiedOutboundCall[] = [];
  const sourceFile = normalizePath(filePath);
  const initializers = variableInitializers(source);
  const serviceVariables = collectServiceVariables(source);
  const wrapperSpecs = collectWrapperSpecs(source);
  const wrapperInternalRanges = [...wrapperSpecs.values()].map((spec) => ({ start: spec.internalStart, end: spec.internalEnd }));
  const add = (node: ts.CallExpression, fact: Omit<OutboundCallFact, 'sourceFile' | 'sourceLine' | 'confidence'> & { confidence?: number }, extra?: Record<string, unknown>): void => {
    calls.push({ node, fact: { ...fact, sourceFile, sourceLine: lineOf(source.text, node.getStart(source)), confidence: fact.confidence ?? 0.8, evidence: parserEvidence(source, node, extra) } });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (wrapperInternalRanges.some((range) => node.getStart(source) >= range.start && node.getEnd() <= range.end)) {
        return;
      }
      const expr = node.expression;
      const exprText = expr.getText(source);
      if (exprText === 'cds.run') {
        const arg = node.arguments[0];
        const entity = arg ? queryEntityFromAst(arg, initializers) : undefined;
        const payload = arg?.getText(source) ?? '';
        add(node, { callType: 'local_db_query', queryEntity: entity, payloadSummary: summarizeExpression(payload), confidence: entity ? 0.9 : 0.55, unresolvedReason: entity ? undefined : queryWarning(payload) });
      } else if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'send' && (ts.isIdentifier(expr.expression) || ts.isPropertyAccessExpression(expr.expression))) {
        const objectArg = node.arguments[0];
        if (objectArg && ts.isObjectLiteralExpression(objectArg)) {
          const receiver = receiverName(expr.expression);
          const query = objectPropertyText(objectArg, 'query');
          const method = stripQuotes(resolveExpression(propertyInitializer(objectArg, 'method'), node, 'literal').value ?? objectPropertyText(objectArg, 'method') ?? 'POST');
          const pathExpr = propertyInitializer(objectArg, 'path') ?? propertyInitializer(objectArg, 'event');
          const pathAnalysis = analyzeOperationPath(pathExpr, node, method);
          const op = pathExpr ? operationPathExpression(pathAnalysis) ?? pathExpr.getText(source) : undefined;
          const shorthandPath = objectPropertyIsShorthand(objectArg, 'path');
          const operationPathExpr = operationPathExpression(pathAnalysis);
          const intent = classifyODataPathIntent(operationPathExpr, method);
          const entityCallTypes: Record<string, OutboundCallFact['callType']> = { entity_mutation: 'remote_entity_mutation', entity_delete: 'remote_entity_delete', entity_media: 'remote_entity_media', entity_candidate: 'remote_entity_candidate' };
          const entityCallType = entityCallTypes[intent.kind];
          const isODataQueryRead = method.toUpperCase() === 'GET' && ['entity_query', 'entity_key_read', 'entity_navigation_query'].includes(intent.kind);
          const unresolvedReason = !query && pathExpr ? pathUnresolvedReason(pathAnalysis) : undefined;
          add(node, { callType: query ? 'remote_query' : entityCallType ?? (isODataQueryRead ? 'remote_query' : 'remote_action'), serviceVariableName: receiver, method, operationPathExpr, queryEntity: query ? extractQueryEntity(query) : isODataQueryRead ? intent.entitySegment : undefined, payloadSummary: summarizeExpression(objectArg.getText(source)), confidence: op || query ? 0.8 : 0.4, unresolvedReason }, { receiver, classifier: 'service_client_send_object', operationPathExpression: shorthandPath ? op : undefined, rawPathExpression: pathAnalysis.rawExpression, literalPathSource: literalPathSource(pathAnalysis), odataPathIntent: operationPathExpr ? intent : undefined, pathAnalysis, staticPathCandidates: legacyPathCandidates(pathAnalysis), parserWarning: unresolvedReason });
        } else {
          const receiver = receiverName(expr.expression);
          const rootReceiver = rootReceiverName(expr.expression);
          const firstArg = resolveExpression(node.arguments[0], node, 'literal');
          const method = firstArg.value?.toUpperCase();
          const pathArg = node.arguments[1];
          const supported = method && supportedHttpMethods.has(method);
          if (receiver && supported && serviceVariables.has(rootReceiver ?? receiver)) {
            const pathAnalysis = analyzeOperationPath(pathArg, node, method);
            const operationPathExpr = operationPathExpression(pathAnalysis);
            const intent = classifyODataPathIntent(operationPathExpr, method);
            const unresolvedReason = pathUnresolvedReason(pathAnalysis);
            add(node, { callType: 'remote_action', serviceVariableName: rootReceiver ?? receiver, method, operationPathExpr, payloadSummary: summarizeExpression(node.getText(source)), confidence: operationPathExpr ? 0.8 : 0.45, unresolvedReason }, { receiver, rootReceiver, classifier: 'service_client_send_method_path', rawPathExpression: pathAnalysis.rawExpression, literalPathSource: literalPathSource(pathAnalysis), odataPathIntent: operationPathExpr ? intent : undefined, pathAnalysis, staticPathCandidates: legacyPathCandidates(pathAnalysis), parserWarning: unresolvedReason });
          } else if (receiver && serviceVariables.has(rootReceiver ?? receiver)) {
            const operationPathExpr = safeOperationName(firstArg.value);
            add(node, { callType: 'remote_action', serviceVariableName: rootReceiver ?? receiver, operationPathExpr, payloadSummary: summarizeExpression(node.getText(source)), confidence: operationPathExpr ? 0.75 : 0.35, unresolvedReason: operationPathExpr ? undefined : 'unsupported_cap_send_signature' }, { receiver, rootReceiver, classifier: operationPathExpr ? 'service_client_send_operation_event' : 'service_client_send_unsupported_signature', rawOperationExpression: firstArg.rawExpression, literalOperationSource: firstArg.value ? firstArg.sourceKind : undefined, parserWarning: operationPathExpr ? undefined : 'unsupported_cap_send_signature' });
          }
        }
      } else if (((ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && wrapperSpecs.has(expr.expression.text)) || (ts.isIdentifier(expr) && wrapperSpecs.has(expr.text)))) {
        const wrapperName = ts.isIdentifier(expr) ? expr.text : ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) ? expr.expression.text : '';
        const wrapperArgs = ts.isIdentifier(expr) ? node.arguments : ts.isCallExpression(expr) ? expr.arguments : node.arguments;
        const spec = wrapperSpecs.get(wrapperName);
        const clientArg = spec?.clientIndex === undefined ? undefined : wrapperArgs[spec.clientIndex];
        const pathArg = spec ? wrapperArgs[spec.pathIndex] : undefined;
        const methodArg = spec?.methodIndex === undefined ? undefined : wrapperArgs[spec.methodIndex];
        const receiver = clientArg && ts.isIdentifier(clientArg) ? clientArg.text : spec?.clientName;
        const method = stripQuotes(resolveExpression(methodArg, node, 'literal').value ?? spec?.methodLiteral ?? 'POST');
        const pathAnalysis = analyzeOperationPath(pathArg, node, method);
        const operationPathExpr = operationPathExpression(pathAnalysis);
        const normalizedOperationPath = operationPathExpr ? classifyODataPathIntent(operationPathExpr, method).topLevelOperationName : undefined;
        const unresolvedReason = pathUnresolvedReason(pathAnalysis);
        if (spec && receiver && operationPathExpr) {
          add(node, { callType: 'remote_action', serviceVariableName: receiver, method, operationPathExpr, payloadSummary: summarizeExpression(node.getText(source)), confidence: 0.75, unresolvedReason }, { receiver, classifier: pathAnalysis.sourceKind.includes('string_literal') ? 'higher_order_wrapper_literal_path' : 'higher_order_wrapper_static_path', wrapperFunction: wrapperName, nestedWrapperFunction: spec.nestedWrapperFunction, wrapperDefinitionLine: spec.definitionLine, callerLine: lineOf(source.text, node.getStart(source)), wrapperPathSourceKind: wrapperSourceKind(pathAnalysis.sourceKind), rawPathExpression: pathAnalysis.rawExpression, normalizedOperationPath, literalPathSource: pathAnalysis.sourceKind.includes('const_alias') ? 'same_scope_const_initializer' : `wrapper_call_${wrapperSourceKind(pathAnalysis.sourceKind)}`, literalCallerArgumentDetected: true, pathAnalysis });
        } else if (spec && receiver) {
          add(node, { callType: 'remote_action', serviceVariableName: receiver, method, payloadSummary: summarizeExpression(node.getText(source)), confidence: 0.45, unresolvedReason }, { receiver, classifier: pathAnalysis.status === 'ambiguous' ? 'higher_order_wrapper_ambiguous_path' : 'higher_order_wrapper_dynamic_path', wrapperFunction: wrapperName, wrapperDefinitionLine: spec.definitionLine, callerLine: lineOf(source.text, node.getStart(source)), wrapperPathSourceKind: wrapperSourceKind(pathAnalysis.sourceKind), rawPathExpression: pathAnalysis.rawExpression, pathAnalysis, parserWarning: unresolvedReason });
        }
      } else if (ts.isPropertyAccessExpression(expr) && ['emit', 'publish', 'on'].includes(expr.name.text)) {
        const receiver = receiverName(expr.expression);
        const rootReceiver = rootReceiverName(expr.expression);
        if (isSupportedEventReceiver(receiver, rootReceiver, serviceVariables)) {
          const eventName = literalText(node.arguments[0]);
          if (eventName) add(node, { callType: expr.name.text === 'on' ? 'async_subscribe' : 'async_emit', serviceVariableName: rootReceiver ?? receiver, eventNameExpr: eventName }, { receiver, rootReceiver, classifier: expr.name.text === 'on' ? 'cap_service_event_subscription' : 'cap_service_event_emit', receiverClassification: 'cap_evidence' });
        }
      } else {
        const external = externalHttpEvidence(node, source);
        if (external) {
          const evidenceTarget = { ...external.externalTarget, method: external.method, parserClassifier: external.classifier, sourceCallShape: external.sourceCallShape };
          const safeTarget = externalHttpTarget({ method: external.method, evidence_json: JSON.stringify({ externalTarget: evidenceTarget }) });
          add(node, { callType: 'external_http', method: external.method, payloadSummary: undefined, confidence: 0.7, unresolvedReason: 'External HTTP destination is outside indexed CAP services', externalTarget: { kind: safeTarget.kind, stableId: safeTarget.toId, label: safeTarget.label, dynamic: safeTarget.dynamic } }, { classifier: external.classifier, externalTarget: safeTarget, sourceCallShape: external.sourceCallShape });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
export function containsSupportedOutboundCall(node: ts.Node): boolean {
  const source = node.getSourceFile();
  const start = node.getFullStart();
  const end = node.getEnd();
  return classifyOutboundCallsInSource(source, source.fileName).some((call) => call.node.getStart(source) >= start && call.node.getEnd() <= end);
}
export async function parseOutboundCalls(
  repoPath: string,
  filePath: string,
  context?: RepositorySourceContext,
): Promise<OutboundCallFact[]> {
  const snapshot = context?.get(filePath);
  const text = snapshot?.text
    ?? await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const source = snapshot?.sourceFile() ?? ts.createSourceFile(
    filePath, text, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const bindingNames = new Set((await parseServiceBindings(
    repoPath, filePath, context,
  )).map((binding) => binding.variableName));
  const importedWrappers = await parseImportedWrapperCalls(
    repoPath, filePath, source, bindingNames, context,
  );
  return [...classifyOutboundCallsInSource(source, filePath).map((call) => call.fact), ...importedWrappers, ...parseLocalServiceCalls(text, filePath, source)];
}
function parseLocalServiceCalls(
  text: string,
  filePath: string,
  source = ts.createSourceFile(
    filePath, text, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  ),
): OutboundCallFact[] {
  const aliases = new Map<string, { service: string; lookup: string; chain: string[] }>();
  const calls: OutboundCallFact[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const origin = serviceLookup(node.initializer, aliases);
      if (origin) aliases.set(node.name.text, { ...origin, chain: [...origin.chain, node.name.text] });
    }
    if (ts.isCallExpression(node)) {
      const parsed = serviceOperationCall(node, aliases);
      if (parsed && parsed.operation !== 'entities') calls.push({
        callType: 'local_service_call',
        operationPathExpr: `/${parsed.operation}`,
        payloadSummary: parsed.service,
        localServiceName: parsed.service,
        localServiceLookup: parsed.lookup,
        aliasChain: parsed.chain,
        sourceFile: normalizePath(filePath),
        sourceLine: lineOf(text, node.getStart(source)),
        confidence: 0.9,
        unresolvedReason: ['send', 'emit', 'publish', 'on'].includes(parsed.operation) ? 'transport_client_method' : undefined,
        evidence: parserEvidence(source, node, {
          classifier: parsed.classifier,
          parserCallType: parsed.operation === 'send' ? 'transport_client_method' : parsed.classifier,
          localServiceLookup: parsed.lookup,
          localServiceName: parsed.service,
          operation: parsed.operation,
          aliasChain: parsed.chain,
        }),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
function serviceLookup(expr: ts.Expression, aliases: Map<string, { service: string; lookup: string; chain: string[] }>): { service: string; lookup: string; chain: string[] } | undefined {
  if (ts.isIdentifier(expr)) return aliases.get(expr.text);
  if (ts.isPropertyAccessExpression(expr) && expr.expression.getText() === 'cds.services') return { service: expr.name.text, lookup: expr.getText(), chain: [expr.getText()] };
  if (ts.isElementAccessExpression(expr) && expr.expression.getText() === 'cds.services' && ts.isStringLiteral(expr.argumentExpression)) return { service: expr.argumentExpression.text, lookup: expr.getText(), chain: [expr.getText()] };
  return undefined;
}
function serviceOperationCall(node: ts.CallExpression, aliases: Map<string, { service: string; lookup: string; chain: string[] }>): { service: string; lookup: string; chain: string[]; operation: string; classifier: string } | undefined {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const origin = serviceLookup(expr.expression, aliases);
  if (!origin) return undefined;
  if (expr.name.text === 'send') {
    const first = literalText(node.arguments[0]);
    const second = literalText(node.arguments[1]);
    const method = first?.toUpperCase();
    if (method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method) && second) return { ...origin, operation: second.replace(/^\//, ''), classifier: 'cap_service_send_method_path' };
    if (first) return { ...origin, operation: first.replace(/^\//, ''), classifier: 'cap_service_send_local_dispatch' };
  }
  return { ...origin, operation: expr.name.text, classifier: 'local_cap_service_call' };
}
