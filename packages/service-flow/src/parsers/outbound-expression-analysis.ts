import ts from 'typescript';
import {
  chainIncludesForUpdate,
  queryBuilderRoot,
  type DirectQueryBuilderStatement,
} from './direct-query-execution.js';
import {
  expressionName,
  maxAliasDepth,
  resolveBinding,
} from './query-entity-resolution.js';
import type { OperationPathAnalysis } from './operation-path-analysis.js';
import { stripQuotes } from '../utils/path-utils.js';
export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
export function queryBuilderEvidence(
  source: ts.SourceFile,
  statement: DirectQueryBuilderStatement,
): Record<string, unknown> {
  const hasForUpdate = chainIncludesForUpdate(statement.logicalCall);
  return {
    classifier: 'cap_query_builder_direct',
    queryDispatch: 'direct_query_builder',
    queryRoot: expressionName(statement.root.expression),
    queryRootStartOffset: statement.root.getStart(source),
    queryRootEndOffset: statement.root.getEnd(),
    queryStatementStartOffset: statement.statement.getStart(source),
    queryStatementEndOffset: statement.statement.getEnd(),
    queryExecutionContext: statement.executionContext,
    ...(hasForUpdate ? { hasForUpdate: true } : {}),
  };
}
export function queryRunEvidence(
  source: ts.SourceFile,
  argument: ts.Expression | undefined,
): Record<string, unknown> {
  const root = argument ? queryBuilderRoot(argument) : undefined;
  const hasForUpdate = argument
    ? chainIncludesForUpdate(argument) : false;
  return {
    classifier: 'cap_query_run_wrapper',
    queryDispatch: 'cds_run_wrapper',
    ...(root ? {
      queryRoot: expressionName(root.expression),
      queryRootStartOffset: root.getStart(source),
      queryRootEndOffset: root.getEnd(),
    } : {}),
    ...(hasForUpdate ? { hasForUpdate: true } : {}),
  };
}
export function queryWarning(expression: string): string {
  if (/^\s*[`'"]/.test(expression)) return 'raw_sql_or_cql_expression';
  if (/^\s*\w+\s*$/.test(expression))
    return 'query_variable_without_static_initializer';
  return 'dynamic_entity_expression';
}

export function parserEvidence(
  source: ts.SourceFile,
  node: ts.CallExpression,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    parser: 'typescript_ast',
    startOffset: node.getStart(source),
    endOffset: node.getEnd(),
    ...extra,
  };
}

function isStringLike(
  expression: ts.Expression | undefined,
): expression is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return Boolean(expression && (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
  ));
}

export function literalText(
  expression: ts.Expression | undefined,
): string | undefined {
  return isStringLike(expression) ? expression.text : undefined;
}

export const CDS_LIFECYCLE_EVENTS = new Set([
  'bootstrap', 'loaded', 'connect', 'serving', 'served', 'listening',
  'shutdown',
]);

export function objectPropertyIsShorthand(
  object: ts.ObjectLiteralExpression,
  key: string,
): boolean {
  return object.properties.some((property) =>
    ts.isShorthandPropertyAssignment(property)
    && property.name.text === key);
}

function nameOfProperty(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

type ExpressionStatus = 'static' | 'dynamic' | 'ambiguous' | 'unknown';
type ExpressionSourceKind =
  | 'string_literal'
  | 'no_substitution_template'
  | 'template_with_substitutions'
  | 'const_alias'
  | 'conditional_candidates'
  | 'dynamic_expression';

export interface ExpressionResolution {
  status: ExpressionStatus;
  sourceKind: ExpressionSourceKind;
  value?: string;
  rawExpression?: string;
  placeholderKeys: string[];
  evidence: string[];
  constName?: string;
}

function safeRaw(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
    || ts.isIdentifier(expression)
    || ts.isTemplateExpression(expression))
    return expression.getText(expression.getSourceFile());
  return undefined;
}

function staticResolution(
  expression: ts.Expression,
): ExpressionResolution | undefined {
  if (ts.isStringLiteral(expression)) return {
    status: 'static', sourceKind: 'string_literal',
    value: expression.text, rawExpression: safeRaw(expression),
    placeholderKeys: [], evidence: ['string_literal'],
  };
  if (!ts.isNoSubstitutionTemplateLiteral(expression)) return undefined;
  return {
    status: 'static', sourceKind: 'no_substitution_template',
    value: expression.text, rawExpression: safeRaw(expression),
    placeholderKeys: [], evidence: ['no_substitution_template'],
  };
}

function templateResolution(
  expression: ts.TemplateExpression,
  policy: 'operation_path' | 'external' | 'literal',
): ExpressionResolution {
  const placeholderKeys = expression.templateSpans.map((span) =>
    span.expression.getText(expression.getSourceFile()));
  if (policy === 'operation_path') return {
    status: 'dynamic',
    sourceKind: 'template_with_substitutions',
    value: stripQuotes(expression.getText(expression.getSourceFile())),
    rawExpression: safeRaw(expression),
    placeholderKeys,
    evidence: ['operation_path_template_placeholders_retained'],
  };
  return {
    status: 'dynamic',
    sourceKind: 'template_with_substitutions',
    placeholderKeys,
    evidence: ['template_substitutions_not_static_external_target'],
  };
}

function identifierResolution(
  expression: ts.Identifier,
  use: ts.Node,
  policy: 'operation_path' | 'external' | 'literal',
  depth: number,
  seen: Set<ts.Node>,
): ExpressionResolution {
  if (depth >= maxAliasDepth) return {
    status: 'unknown', sourceKind: 'const_alias',
    rawExpression: safeRaw(expression), placeholderKeys: [],
    evidence: ['alias_depth_exceeded'], constName: expression.text,
  };
  const binding = resolveBinding(expression, use);
  if (!binding.declaration || !binding.initializer || !binding.immutable)
    return {
      status: 'dynamic', sourceKind: 'dynamic_expression',
      rawExpression: safeRaw(expression), placeholderKeys: [],
      evidence: binding.evidence, constName: expression.text,
    };
  if (seen.has(binding.declaration)) return {
    status: 'unknown', sourceKind: 'const_alias',
    rawExpression: safeRaw(expression), placeholderKeys: [],
    evidence: ['alias_cycle_detected'], constName: expression.text,
  };
  seen.add(binding.declaration);
  const resolved = resolveExpression(
    binding.initializer, binding.declaration, policy, depth + 1, seen,
  );
  return {
    ...resolved,
    sourceKind: 'const_alias',
    rawExpression: safeRaw(expression),
    constName: expression.text,
    evidence: [...binding.evidence, ...resolved.evidence],
  };
}

export function resolveExpression(
  expression: ts.Expression | undefined,
  use: ts.Node,
  policy: 'operation_path' | 'external' | 'literal',
  depth = 0,
  seen = new Set<ts.Node>(),
): ExpressionResolution {
  if (!expression) return {
    status: 'unknown', sourceKind: 'dynamic_expression',
    placeholderKeys: [], evidence: ['expression_missing'],
  };
  const literal = staticResolution(expression);
  if (literal) return literal;
  if (ts.isTemplateExpression(expression))
    return templateResolution(expression, policy);
  if (ts.isIdentifier(expression))
    return identifierResolution(expression, use, policy, depth, seen);
  return {
    status: 'dynamic', sourceKind: 'dynamic_expression',
    rawExpression: safeRaw(expression), placeholderKeys: [],
    evidence: [
      `unsupported_${ts.SyntaxKind[expression.kind] ?? 'expression'}`,
    ],
  };
}

function staticExpressionText(
  expression: ts.Expression | undefined,
  initializers: Map<string, ts.Expression>,
): string | undefined {
  if (!expression) return undefined;
  if (isStringLike(expression)) return expression.text;
  if (ts.isIdentifier(expression) && initializers.has(expression.text))
    return staticExpressionText(initializers.get(expression.text), initializers);
  return undefined;
}

function operationPathFromStatic(
  text: string | undefined,
): string | undefined {
  return text ? `/${stripQuotes(text).replace(/^\//, '')}` : undefined;
}

function destinationExpressionShape(
  expression: ts.Expression | undefined,
): string | undefined {
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) return 'identifier';
  if (ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)) return 'property_read';
  if (ts.isCallExpression(expression)) return 'function_call';
  if (ts.isConditionalExpression(expression)) return 'conditional';
  if (ts.isBinaryExpression(expression)) return 'binary_expression';
  if (ts.isTemplateExpression(expression)) return 'template_expression';
  return ts.SyntaxKind[expression.kind] ?? 'expression';
}

function staticConditionalCandidates(
  expression: ts.Expression | undefined,
  initializers: Map<string, ts.Expression>,
): string[] | undefined {
  const resolved = expression && ts.isIdentifier(expression)
    && initializers.has(expression.text)
    ? initializers.get(expression.text) : expression;
  if (!resolved || !ts.isConditionalExpression(resolved)) return undefined;
  const left = staticExpressionText(resolved.whenTrue, initializers);
  const right = staticExpressionText(resolved.whenFalse, initializers);
  return left && right ? [...new Set([left, right])] : undefined;
}

export function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)
      && nameOfProperty(property.name) === key) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)
      && property.name.text === key) return property.name;
  }
  return undefined;
}

function httpMethodFromObject(
  object: ts.ObjectLiteralExpression,
  use: ts.Node,
): string | undefined {
  const text = resolveExpression(
    propertyInitializer(object, 'method'), use, 'literal',
  ).value;
  return text ? stripQuotes(text).toUpperCase() : undefined;
}

export const supportedHttpMethods = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD',
]);

export function safeOperationName(
  value: string | undefined,
): string | undefined {
  if (!value || !/^[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$]*)*$/.test(value))
    return undefined;
  return operationPathFromStatic(value);
}

export function wrapperSourceKind(sourceKind: string): string {
  if (sourceKind.includes('const_alias')) return 'const';
  if (sourceKind.includes('template')) return 'template';
  if (sourceKind.includes('string_literal')) return 'literal';
  return sourceKind.includes('conditional') ? 'ambiguous' : 'dynamic';
}

export function literalPathSource(
  analysis: OperationPathAnalysis,
): string | undefined {
  if (analysis.status !== 'static') return undefined;
  if (analysis.sourceKind.includes('const_alias'))
    return 'same_scope_const_initializer';
  if (analysis.sourceKind.includes('no_substitution_template'))
    return 'template';
  return analysis.sourceKind.includes('string_literal')
    ? 'literal' : analysis.sourceKind;
}

export function legacyPathCandidates(
  analysis: OperationPathAnalysis,
): Record<string, unknown> | undefined {
  if (analysis.candidateRawPaths.length < 2
    && analysis.dynamicReassignments.length === 0) return undefined;
  return {
    candidatePaths: analysis.candidateRawPaths,
    normalizedCandidateOperations: analysis.candidateNormalizedOperationPaths
      .map((value) => value.replace(/^\//, '')),
    candidateSourceKind: analysis.sourceKind,
    candidateIdentifier: analysis.candidateIdentifier,
    hasDynamicAssignments: analysis.dynamicReassignments.length > 0,
    conservativeReason: analysis.dynamicReassignments.length > 0
      ? 'dynamic_assignment_observed' : 'candidate_tie',
  };
}

function hasTemplatePlaceholder(value: string): boolean {
  return /\$\{|%7B|%7D/i.test(value);
}

function urlTargetFromExpression(
  expression: ts.Expression | undefined,
  use: ts.Node,
): Record<string, unknown> {
  const resolved = resolveExpression(expression, use, 'external');
  if (resolved.status === 'static' && resolved.value
    && !hasTemplatePlaceholder(resolved.value)) return {
    kind: 'static_url', expression: resolved.value, dynamic: false,
    sourceKind: resolved.sourceKind,
  };
  if (expression) return {
    kind: 'url_expression', dynamic: true,
    expression: `${resolved.sourceKind}:${resolved.placeholderKeys.join('|')}`,
    expressionShape: resolved.sourceKind,
    placeholderKeys: resolved.placeholderKeys,
  };
  return { kind: 'unknown', dynamic: false };
}

function destinationTargetFromExpression(
  expression: ts.Expression | undefined,
  use: ts.Node,
): Record<string, unknown> | undefined {
  const resolved = resolveExpression(expression, use, 'external');
  if (resolved.status === 'static' && resolved.value
    && !hasTemplatePlaceholder(resolved.value)) return {
    kind: 'destination', expression: resolved.value, dynamic: false,
    sourceKind: resolved.sourceKind,
  };
  const candidates = staticConditionalCandidates(
    expression, new Map<string, ts.Expression>(),
  );
  if (candidates) return {
    kind: 'destination', dynamic: true,
    expressionShape: 'conditional', candidateLiterals: candidates,
  };
  const shape = destinationExpressionShape(expression);
  return shape
    ? { kind: 'destination', dynamic: true, expressionShape: shape }
    : undefined;
}

export interface ExternalHttpEvidence {
  method?: string;
  externalTarget: Record<string, unknown>;
  classifier: string;
  sourceCallShape: string;
}

function destinationLookupEvidence(
  node: ts.CallExpression,
): ExternalHttpEvidence | undefined {
  const object = node.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const destination = destinationTargetFromExpression(
    propertyInitializer(object, 'destinationName'), node,
  );
  return {
    externalTarget: destination ?? { kind: 'unknown', dynamic: false },
    classifier: 'sap_destination_lookup',
    sourceCallShape: 'useOrFetchDestination',
  };
}

function executeHttpEvidence(node: ts.CallExpression): ExternalHttpEvidence {
  const destination = destinationTargetFromExpression(node.arguments[0], node);
  const config = node.arguments[1];
  const object = config && ts.isObjectLiteralExpression(config)
    ? config : undefined;
  const method = object ? httpMethodFromObject(object, node) : undefined;
  const url = object
    ? urlTargetFromExpression(propertyInitializer(object, 'url'), node)
    : { kind: 'unknown', dynamic: false };
  return {
    method,
    externalTarget: destination ? { ...url, destination } : url,
    classifier: 'sap_execute_http_request',
    sourceCallShape: 'executeHttpRequest',
  };
}

function axiosEvidence(node: ts.CallExpression): ExternalHttpEvidence {
  const config = node.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) return {
    externalTarget: { kind: 'unknown', dynamic: false },
    classifier: 'axios_unknown_call',
    sourceCallShape: 'axios(...)',
  };
  return {
    method: httpMethodFromObject(config, node),
    externalTarget: urlTargetFromExpression(
      propertyInitializer(config, 'url'), node,
    ),
    classifier: 'axios_config_call',
    sourceCallShape: 'axios(config)',
  };
}

function fetchEvidence(node: ts.CallExpression): ExternalHttpEvidence {
  const init = node.arguments[1];
  const object = init && ts.isObjectLiteralExpression(init) ? init : undefined;
  return {
    method: object ? httpMethodFromObject(object, node) : undefined,
    externalTarget: urlTargetFromExpression(node.arguments[0], node),
    classifier: 'fetch_call',
    sourceCallShape: 'fetch',
  };
}

function axiosMemberEvidence(
  node: ts.CallExpression,
  source: ts.SourceFile,
): ExternalHttpEvidence | undefined {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)
    || !['get', 'post', 'put', 'patch', 'delete', 'head']
      .includes(expression.name.text)
    || expression.expression.getText(source) !== 'axios') return undefined;
  return {
    method: expression.name.text.toUpperCase(),
    externalTarget: urlTargetFromExpression(node.arguments[0], node),
    classifier: 'axios_member_call',
    sourceCallShape: `axios.${expression.name.text}`,
  };
}

export function externalHttpEvidence(
  node: ts.CallExpression,
  source: ts.SourceFile,
): ExternalHttpEvidence | undefined {
  const expression = node.expression.getText(source);
  if (expression === 'useOrFetchDestination')
    return destinationLookupEvidence(node);
  if (expression === 'executeHttpRequest') return executeHttpEvidence(node);
  if (expression === 'axios') return axiosEvidence(node);
  if (expression === 'fetch') return fetchEvidence(node);
  return axiosMemberEvidence(node, source);
}

export function collectServiceVariables(source: ts.SourceFile): Set<string> {
  const variables = new Set([
    'cds', 'messaging', 'messageClient', 'eventClient',
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer
      && /cds\.connect\.(to|messaging)\s*\(/.test(
        node.initializer.getText(source),
      )) variables.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return variables;
}

export function receiverName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  return ts.isPropertyAccessExpression(expression)
    ? expression.getText(expression.getSourceFile()) : undefined;
}

export function rootReceiverName(
  expression: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression))
    return rootReceiverName(expression.expression);
  if (ts.isCallExpression(expression))
    return rootReceiverName(expression.expression);
  return undefined;
}

export function isSupportedEventReceiver(
  receiver: string | undefined,
  rootReceiver: string | undefined,
  serviceVariables: Set<string>,
): boolean {
  const candidate = rootReceiver ?? receiver;
  if (!candidate) return false;
  if (candidate === 'cds' || serviceVariables.has(candidate)) return true;
  if (receiver && serviceVariables.has(receiver)) return true;
  return /^(srv|service|serviceClient|messaging|messageClient|eventClient)$/
    .test(candidate);
}

export interface WrapperSpec {
  clientIndex?: number;
  clientName?: string;
  pathIndex: number;
  methodIndex?: number;
  methodName?: string;
  methodLiteral?: string;
  nestedWrapperFunction?: string;
  definitionLine: number;
  internalStart: number;
  internalEnd: number;
}

interface WrapperSend {
  client: string;
  path: string;
  method?: string;
  methodLiteral?: string;
  nestedWrapperFunction?: string;
  start: number;
  end: number;
}

export function calledWrapperNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      names.add(node.expression.text);
    const expression = ts.isCallExpression(node) ? node.expression : undefined;
    if (expression && ts.isCallExpression(expression)
      && ts.isIdentifier(expression.expression))
      names.add(expression.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function directWrapperSend(
  node: ts.CallExpression,
  source: ts.SourceFile,
): WrapperSend | undefined {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)
    || expression.name.text !== 'send'
    || !ts.isIdentifier(expression.expression)) return undefined;
  const object = node.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const path = propertyInitializer(object, 'path');
  if (!path || !ts.isIdentifier(path)) return undefined;
  const method = propertyInitializer(object, 'method');
  return {
    client: expression.expression.text,
    path: path.text,
    method: method && ts.isIdentifier(method) ? method.text : undefined,
    methodLiteral: resolveExpression(method, node, 'literal').value,
    start: node.getStart(source),
    end: node.getEnd(),
  };
}

function nestedWrapperSend(
  node: ts.CallExpression,
  source: ts.SourceFile,
  specs: Map<string, WrapperSpec>,
): WrapperSend | undefined {
  if (!ts.isIdentifier(node.expression)) return undefined;
  const nested = specs.get(node.expression.text);
  if (!nested) return undefined;
  const path = node.arguments[nested.pathIndex];
  const client = nested.clientIndex === undefined
    ? undefined : node.arguments[nested.clientIndex];
  const pathName = path && ts.isIdentifier(path) ? path.text : undefined;
  const clientName = client && ts.isIdentifier(client)
    ? client.text : nested.clientName;
  if (!pathName || !clientName) return undefined;
  return {
    client: clientName,
    path: pathName,
    method: nested.methodName,
    methodLiteral: nested.methodLiteral,
    nestedWrapperFunction: node.expression.text,
    start: node.getStart(source),
    end: node.getEnd(),
  };
}

function wrapperSends(
  fn: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
  specs: Map<string, WrapperSpec>,
): WrapperSend[] {
  const sends: WrapperSend[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const send = directWrapperSend(node, source)
        ?? nestedWrapperSend(node, source, specs);
      if (send) sends.push(send);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return sends;
}

function isExportedWrapper(fn: ts.FunctionLikeDeclaration): boolean {
  const declaration = ts.isFunctionDeclaration(fn)
    ? fn
    : ts.isVariableDeclaration(fn.parent)
      ? fn.parent.parent.parent : undefined;
  if (!declaration || !ts.canHaveModifiers(declaration)) return false;
  return ts.getModifiers(declaration)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function optionalIndex(index: number): number | undefined {
  return index >= 0 ? index : undefined;
}

function knownWrapperClient(
  client: string,
  serviceVariables: Set<string>,
): boolean {
  if (serviceVariables.has(client)) return true;
  return /^(srv|service|serviceClient|client|.*Client)$/.test(client);
}

export function wrapperSpec(
  name: string,
  fn: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
  calledNames: Set<string>,
  serviceVariables: Set<string>,
  specs: Map<string, WrapperSpec>,
): WrapperSpec | undefined {
  if (!calledNames.has(name) && !isExportedWrapper(fn)) return undefined;
  const sends = wrapperSends(fn, source, specs);
  if (sends.length !== 1) return undefined;
  const found = sends[0];
  if (!found) return undefined;
  const parameters = fn.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : undefined);
  const clientIndex = parameters.indexOf(found.client);
  const pathIndex = parameters.indexOf(found.path);
  const methodIndex = parameters.indexOf(found.method ?? '');
  if (pathIndex < 0) return undefined;
  if (clientIndex < 0
    && !knownWrapperClient(found.client, serviceVariables)) return undefined;
  return {
    clientIndex: optionalIndex(clientIndex),
    clientName: clientIndex >= 0 ? undefined : found.client,
    pathIndex,
    methodIndex: optionalIndex(methodIndex),
    methodName: found.method,
    methodLiteral: found.methodLiteral,
    nestedWrapperFunction: found.nestedWrapperFunction,
    definitionLine: lineOf(source.text, fn.getStart(source)),
    internalStart: found.start,
    internalEnd: found.end,
  };
}
