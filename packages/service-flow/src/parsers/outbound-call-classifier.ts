import ts from 'typescript';
import { externalHttpTarget } from '../linker/external-http-target.js';
import { classifyODataPathIntent } from '../linker/odata-path-normalizer.js';
import type { OutboundCallFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
import { summarizeExpression } from '../utils/redaction.js';
import { directQueryBuilderStatement } from './direct-query-execution.js';
import {
  expressionName,
  queryEntityFromAst,
  variableInitializers,
} from './query-entity-resolution.js';
import {
  CDS_LIFECYCLE_EVENTS,
  calledWrapperNames,
  collectServiceVariables,
  externalHttpEvidence,
  isSupportedEventReceiver,
  legacyPathCandidates,
  lineOf,
  literalPathSource,
  objectPropertyIsShorthand,
  parserEvidence,
  propertyInitializer,
  queryBuilderEvidence,
  queryRunEvidence,
  queryWarning,
  receiverName,
  resolveExpression,
  rootReceiverName,
  safeOperationName,
  supportedHttpMethods,
  wrapperSourceKind,
  wrapperSpec,
  type ExpressionResolution,
  type WrapperSpec,
} from './outbound-expression-analysis.js';
import {
  analyzeOperationPath,
  operationPathExpression,
  pathUnresolvedReason,
  type OperationPathAnalysis,
} from './operation-path-analysis.js';

export interface ClassifiedOutboundCall {
  fact: OutboundCallFact;
  node: ts.CallExpression;
}

function namedFunctionLike(
  node: ts.Node,
): { name: string; fn: ts.FunctionLikeDeclaration } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name)
    return { name: node.name.text, fn: node };
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)
    || !node.initializer) return undefined;
  return ts.isArrowFunction(node.initializer)
    || ts.isFunctionExpression(node.initializer)
    ? { name: node.name.text, fn: node.initializer } : undefined;
}

function collectWrapperSpecs(
  source: ts.SourceFile,
): Map<string, WrapperSpec> {
  const specs = new Map<string, WrapperSpec>();
  const calledNames = calledWrapperNames(source);
  const serviceVariables = collectServiceVariables(source);
  const visit = (node: ts.Node): void => {
    const named = namedFunctionLike(node);
    if (named) {
      const spec = wrapperSpec(
        named.name, named.fn, source, calledNames, serviceVariables, specs,
      );
      if (spec) specs.set(named.name, spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

interface EventCallClassification {
  fact: Pick<OutboundCallFact,
    'callType' | 'serviceVariableName' | 'eventNameExpr'
    | 'confidence' | 'unresolvedReason'>;
  evidence: Record<string, unknown>;
}

interface EventReceiver {
  effectiveReceiver: string;
  receiver?: string;
  rootReceiver?: string;
}

function eventReceiver(
  expression: ts.PropertyAccessExpression,
  serviceVariables: Set<string>,
): EventReceiver | undefined {
  const receiver = receiverName(expression.expression);
  const rootReceiver = rootReceiverName(expression.expression);
  if (!isSupportedEventReceiver(receiver, rootReceiver, serviceVariables))
    return undefined;
  const effectiveReceiver = rootReceiver ?? receiver;
  return effectiveReceiver
    ? { receiver, rootReceiver, effectiveReceiver } : undefined;
}

function eventUnresolvedReason(
  resolved: ExpressionResolution,
): string | undefined {
  if (resolved.status === 'static') return undefined;
  return resolved.value !== undefined && resolved.placeholderKeys.length > 0
    ? 'dynamic_event_name_identifier'
    : 'dynamic_event_name_unsupported_expression';
}

function eventConfidence(reason: string | undefined): number {
  if (!reason) return 0.8;
  return reason === 'dynamic_event_name_identifier' ? 0.6 : 0.3;
}

function eventClassificationEvidence(
  expression: ts.PropertyAccessExpression,
  receiver: EventReceiver,
  resolved: ExpressionResolution,
): Record<string, unknown> {
  return {
    receiver: receiver.receiver,
    rootReceiver: receiver.rootReceiver,
    classifier: expression.name.text === 'on'
      ? 'cap_service_event_subscription' : 'cap_service_event_emit',
    receiverClassification: 'cap_evidence',
    ...(resolved.status === 'static' ? {} : {
      eventNameStatus: resolved.status,
      eventNameSourceKind: resolved.sourceKind,
      eventNamePlaceholderKeys: resolved.placeholderKeys,
    }),
  };
}

interface EventNameState {
  eventName: string;
  resolved: ExpressionResolution;
  unresolvedReason?: string;
}

function eventNameState(node: ts.CallExpression): EventNameState | undefined {
  const expression = node.arguments[0];
  const resolved = resolveExpression(expression, node, 'operation_path');
  let eventName = resolved.value;
  if (eventName === undefined) eventName = resolved.rawExpression;
  if (eventName === undefined && expression)
    eventName = expression.getText(node.getSourceFile());
  if (!eventName) return undefined;
  return {
    eventName,
    resolved,
    unresolvedReason: eventUnresolvedReason(resolved),
  };
}

function excludedEventName(
  expression: ts.PropertyAccessExpression,
  receiver: EventReceiver,
  state: EventNameState,
): boolean {
  if (state.resolved.status !== 'static') return false;
  if (receiver.effectiveReceiver === 'cds'
    && CDS_LIFECYCLE_EVENTS.has(state.eventName)) return true;
  return expression.name.text === 'on' && state.eventName === 'error';
}

function eventCallClassification(
  node: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
  serviceVariables: Set<string>,
): EventCallClassification | undefined {
  const receiver = eventReceiver(expression, serviceVariables);
  if (!receiver) return undefined;
  const state = eventNameState(node);
  if (!state || excludedEventName(expression, receiver, state))
    return undefined;
  return {
    fact: {
      callType: expression.name.text === 'on'
        ? 'async_subscribe' : 'async_emit',
      serviceVariableName: receiver.effectiveReceiver,
      eventNameExpr: state.eventName,
      confidence: eventConfidence(state.unresolvedReason),
      unresolvedReason: state.unresolvedReason,
    },
    evidence: eventClassificationEvidence(
      expression, receiver, state.resolved,
    ),
  };
}

type OutboundFactInput = Omit<
  OutboundCallFact, 'sourceFile' | 'sourceLine' | 'confidence'
> & { confidence?: number };
type AddOutboundCall = (
  node: ts.CallExpression,
  fact: OutboundFactInput,
  extra?: Record<string, unknown>,
) => void;

interface OutboundCallContext {
  source: ts.SourceFile;
  initializers: Map<string, ts.Expression>;
  serviceVariables: Set<string>;
  wrapperSpecs: Map<string, WrapperSpec>;
  add: AddOutboundCall;
}

function classifyQueryDispatch(
  node: ts.CallExpression,
  context: OutboundCallContext,
): boolean {
  const { source, initializers, add } = context;
  if (expressionName(node.expression) === 'cds.run') {
    const argument = node.arguments[0];
    const entity = argument
      ? queryEntityFromAst(argument, initializers) : undefined;
    const payload = argument?.getText(source) ?? '';
    add(node, {
      callType: 'local_db_query',
      queryEntity: entity,
      payloadSummary: summarizeExpression(payload),
      confidence: entity ? 0.9 : 0.55,
      unresolvedReason: entity ? undefined : queryWarning(payload),
    }, queryRunEvidence(source, argument));
    return true;
  }
  const direct = directQueryBuilderStatement(node);
  if (!direct) return false;
  const entity = queryEntityFromAst(direct.logicalCall, initializers);
  const payload = direct.logicalCall.getText(source);
  add(direct.logicalCall, {
    callType: 'local_db_query',
    queryEntity: entity,
    payloadSummary: summarizeExpression(payload),
    confidence: entity ? 0.9 : 0.55,
    unresolvedReason: entity ? undefined : queryWarning(payload),
  }, queryBuilderEvidence(source, direct));
  return true;
}

function sendExpression(
  node: ts.CallExpression,
): ts.PropertyAccessExpression | undefined {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)
    || expression.name.text !== 'send') return undefined;
  return ts.isIdentifier(expression.expression)
    || ts.isPropertyAccessExpression(expression.expression)
    ? expression : undefined;
}

function objectSendMethod(
  object: ts.ObjectLiteralExpression,
  node: ts.CallExpression,
): { method: string; dynamicDefaulted: boolean } {
  const expression = propertyInitializer(object, 'method');
  const resolution = resolveExpression(expression, node, 'literal');
  return {
    method: stripQuotes(resolution.value ?? 'POST'),
    dynamicDefaulted: Boolean(expression && resolution.value === undefined),
  };
}

function objectSendCallType(
  query: ts.Expression | undefined,
  entityType: OutboundCallFact['callType'] | undefined,
  queryRead: boolean,
): OutboundCallFact['callType'] {
  if (query) return 'remote_query';
  if (entityType) return entityType;
  return queryRead ? 'remote_query' : 'remote_action';
}

function objectSendQueryEntity(
  query: ts.Expression | undefined,
  initializers: Map<string, ts.Expression>,
  queryRead: boolean,
  entitySegment: string | undefined,
): string | undefined {
  if (query) return queryEntityFromAst(query, initializers);
  return queryRead ? entitySegment : undefined;
}

function objectSendUnresolvedReason(
  query: ts.Expression | undefined,
  queryEntity: string | undefined,
  pathExpression: ts.Expression | undefined,
  pathAnalysis: OperationPathAnalysis,
  source: ts.SourceFile,
): string | undefined {
  if (query)
    return queryEntity ? undefined : queryWarning(query.getText(source));
  return pathExpression ? pathUnresolvedReason(pathAnalysis) : undefined;
}

const objectSendEntityTypes: Readonly<Record<
  string, OutboundCallFact['callType']
>> = {
  entity_mutation: 'remote_entity_mutation',
  entity_delete: 'remote_entity_delete',
  entity_media: 'remote_entity_media',
  entity_candidate: 'remote_entity_candidate',
};

function objectSendEvidence(
  object: ts.ObjectLiteralExpression,
  receiver: string | undefined,
  rawOperation: string | undefined,
  operationPath: string | undefined,
  intent: ReturnType<typeof classifyODataPathIntent>,
  pathAnalysis: OperationPathAnalysis,
  unresolvedReason: string | undefined,
  dynamicMethodDefaulted: boolean,
): Record<string, unknown> {
  return {
    receiver,
    classifier: 'service_client_send_object',
    operationPathExpression: objectPropertyIsShorthand(object, 'path')
      ? rawOperation : undefined,
    rawPathExpression: pathAnalysis.rawExpression,
    literalPathSource: literalPathSource(pathAnalysis),
    odataPathIntent: operationPath ? intent : undefined,
    pathAnalysis,
    staticPathCandidates: legacyPathCandidates(pathAnalysis),
    parserWarning: unresolvedReason,
    ...(dynamicMethodDefaulted ? { dynamicMethodDefaulted: true } : {}),
  };
}

function classifyObjectSend(
  node: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
  object: ts.ObjectLiteralExpression,
  context: OutboundCallContext,
): void {
  const { source, initializers, add } = context;
  const receiver = receiverName(expression.expression);
  const query = propertyInitializer(object, 'query');
  const methodState = objectSendMethod(object, node);
  const path = propertyInitializer(object, 'path')
    ?? propertyInitializer(object, 'event');
  const pathAnalysis = analyzeOperationPath(path, node, methodState.method);
  const operationPath = operationPathExpression(pathAnalysis);
  const intent = classifyODataPathIntent(operationPath, methodState.method);
  const queryRead = methodState.method.toUpperCase() === 'GET'
    && ['entity_query', 'entity_key_read', 'entity_navigation_query']
      .includes(intent.kind);
  const queryEntity = objectSendQueryEntity(
    query, initializers, queryRead, intent.entitySegment,
  );
  const unresolvedReason = objectSendUnresolvedReason(
    query, queryEntity, path, pathAnalysis, source,
  );
  const rawOperation = path
    ? operationPath ?? path.getText(source) : undefined;
  add(node, {
    callType: objectSendCallType(
      query, objectSendEntityTypes[intent.kind], queryRead,
    ),
    serviceVariableName: receiver,
    method: methodState.method,
    operationPathExpr: operationPath,
    queryEntity,
    payloadSummary: summarizeExpression(object.getText(source)),
    confidence: rawOperation || query ? 0.8 : 0.4,
    unresolvedReason,
  }, objectSendEvidence(
    object, receiver, rawOperation, operationPath, intent, pathAnalysis,
    unresolvedReason, methodState.dynamicDefaulted,
  ));
}

function classifyPositionalSend(
  node: ts.CallExpression,
  expression: ts.PropertyAccessExpression,
  context: OutboundCallContext,
): void {
  const { source, serviceVariables, add } = context;
  const receiver = receiverName(expression.expression);
  const rootReceiver = rootReceiverName(expression.expression);
  const serviceVariable = rootReceiver ?? receiver;
  if (!receiver || !serviceVariable
    || !serviceVariables.has(serviceVariable)) return;
  const first = resolveExpression(node.arguments[0], node, 'literal');
  const method = first.value?.toUpperCase();
  if (!method || !supportedHttpMethods.has(method)) {
    const operationPath = safeOperationName(first.value);
    addUnsupportedPositionalSend(
      node, receiver, rootReceiver, first, operationPath, context,
    );
    return;
  }
  const pathAnalysis = analyzeOperationPath(node.arguments[1], node, method);
  const operationPath = operationPathExpression(pathAnalysis);
  const intent = classifyODataPathIntent(operationPath, method);
  const unresolvedReason = pathUnresolvedReason(pathAnalysis);
  add(node, {
    callType: 'remote_action',
    serviceVariableName: serviceVariable,
    method,
    operationPathExpr: operationPath,
    payloadSummary: summarizeExpression(node.getText(source)),
    confidence: operationPath ? 0.8 : 0.45,
    unresolvedReason,
  }, {
    receiver, rootReceiver,
    classifier: 'service_client_send_method_path',
    rawPathExpression: pathAnalysis.rawExpression,
    literalPathSource: literalPathSource(pathAnalysis),
    odataPathIntent: operationPath ? intent : undefined,
    pathAnalysis,
    staticPathCandidates: legacyPathCandidates(pathAnalysis),
    parserWarning: unresolvedReason,
  });
}

function addUnsupportedPositionalSend(
  node: ts.CallExpression,
  receiver: string,
  rootReceiver: string | undefined,
  first: ExpressionResolution,
  operationPath: string | undefined,
  context: OutboundCallContext,
): void {
  const unresolvedReason = operationPath
    ? undefined : 'unsupported_cap_send_signature';
  context.add(node, {
    callType: 'remote_action',
    serviceVariableName: rootReceiver ?? receiver,
    operationPathExpr: operationPath,
    payloadSummary: summarizeExpression(node.getText(context.source)),
    confidence: operationPath ? 0.75 : 0.35,
    unresolvedReason,
  }, {
    receiver, rootReceiver,
    classifier: operationPath
      ? 'service_client_send_operation_event'
      : 'service_client_send_unsupported_signature',
    rawOperationExpression: first.rawExpression,
    literalOperationSource: first.value ? first.sourceKind : undefined,
    parserWarning: unresolvedReason,
  });
}

function classifySendCall(
  node: ts.CallExpression,
  context: OutboundCallContext,
): boolean {
  const expression = sendExpression(node);
  if (!expression) return false;
  const object = node.arguments[0];
  if (object && ts.isObjectLiteralExpression(object))
    classifyObjectSend(node, expression, object, context);
  else classifyPositionalSend(node, expression, context);
  return true;
}

interface WrapperInvocation {
  name: string;
  arguments: readonly ts.Expression[];
  spec: WrapperSpec;
}

function wrapperInvocation(
  expression: ts.LeftHandSideExpression,
  specs: Map<string, WrapperSpec>,
): WrapperInvocation | undefined {
  if (ts.isIdentifier(expression)) {
    const spec = specs.get(expression.text);
    return spec
      ? { name: expression.text, arguments: [], spec } : undefined;
  }
  if (!ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)) return undefined;
  const spec = specs.get(expression.expression.text);
  return spec ? {
    name: expression.expression.text,
    arguments: expression.arguments,
    spec,
  } : undefined;
}

function wrapperArguments(
  node: ts.CallExpression,
  invocation: WrapperInvocation,
): readonly ts.Expression[] {
  return invocation.arguments.length > 0
    ? invocation.arguments : node.arguments;
}

function classifyWrapperCall(
  node: ts.CallExpression,
  context: OutboundCallContext,
): boolean {
  const invocation = wrapperInvocation(node.expression, context.wrapperSpecs);
  if (!invocation) return false;
  const args = wrapperArguments(node, invocation);
  const client = invocation.spec.clientIndex === undefined
    ? undefined : args[invocation.spec.clientIndex];
  const path = args[invocation.spec.pathIndex];
  const methodArgument = invocation.spec.methodIndex === undefined
    ? undefined : args[invocation.spec.methodIndex];
  const receiver = client && ts.isIdentifier(client)
    ? client.text : invocation.spec.clientName;
  const method = stripQuotes(resolveExpression(
    methodArgument, node, 'literal',
  ).value ?? invocation.spec.methodLiteral ?? 'POST');
  const analysis = analyzeOperationPath(path, node, method);
  if (receiver) addWrapperCall(
    node, receiver, method, analysis, invocation, context,
  );
  return true;
}

function addWrapperCall(
  node: ts.CallExpression,
  receiver: string,
  method: string,
  analysis: OperationPathAnalysis,
  invocation: WrapperInvocation,
  context: OutboundCallContext,
): void {
  const operationPath = operationPathExpression(analysis);
  const unresolvedReason = pathUnresolvedReason(analysis);
  const staticPath = Boolean(operationPath);
  context.add(node, {
    callType: 'remote_action',
    serviceVariableName: receiver,
    method,
    operationPathExpr: operationPath,
    payloadSummary: summarizeExpression(node.getText(context.source)),
    confidence: staticPath ? 0.75 : 0.45,
    unresolvedReason,
  }, wrapperEvidence(
    node, receiver, method, analysis, invocation, context, staticPath,
  ));
}

function wrapperEvidence(
  node: ts.CallExpression,
  receiver: string,
  method: string,
  analysis: OperationPathAnalysis,
  invocation: WrapperInvocation,
  context: OutboundCallContext,
  staticPath: boolean,
): Record<string, unknown> {
  const operationPath = operationPathExpression(analysis);
  return {
    receiver,
    classifier: staticPath
      ? analysis.sourceKind.includes('string_literal')
        ? 'higher_order_wrapper_literal_path'
        : 'higher_order_wrapper_static_path'
      : analysis.status === 'ambiguous'
        ? 'higher_order_wrapper_ambiguous_path'
        : 'higher_order_wrapper_dynamic_path',
    wrapperFunction: invocation.name,
    nestedWrapperFunction: invocation.spec.nestedWrapperFunction,
    wrapperDefinitionLine: invocation.spec.definitionLine,
    callerLine: lineOf(context.source.text, node.getStart(context.source)),
    wrapperPathSourceKind: wrapperSourceKind(analysis.sourceKind),
    rawPathExpression: analysis.rawExpression,
    normalizedOperationPath: operationPath
      ? classifyODataPathIntent(operationPath, method).topLevelOperationName
      : undefined,
    literalPathSource: staticPath
      ? analysis.sourceKind.includes('const_alias')
        ? 'same_scope_const_initializer'
        : `wrapper_call_${wrapperSourceKind(analysis.sourceKind)}`
      : undefined,
    literalCallerArgumentDetected: staticPath || undefined,
    pathAnalysis: analysis,
    parserWarning: staticPath ? undefined : pathUnresolvedReason(analysis),
  };
}

function classifyEventCall(
  node: ts.CallExpression,
  context: OutboundCallContext,
): boolean {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)
    || !['emit', 'publish', 'on'].includes(expression.name.text)) return false;
  const event = eventCallClassification(
    node, expression, context.serviceVariables,
  );
  if (event) context.add(node, event.fact, event.evidence);
  return true;
}

function classifyExternalCall(
  node: ts.CallExpression,
  context: OutboundCallContext,
): void {
  const external = externalHttpEvidence(node, context.source);
  if (!external) return;
  const evidenceTarget = {
    ...external.externalTarget,
    method: external.method,
    parserClassifier: external.classifier,
    sourceCallShape: external.sourceCallShape,
  };
  const safeTarget = externalHttpTarget({
    method: external.method,
    evidence_json: JSON.stringify({ externalTarget: evidenceTarget }),
  });
  context.add(node, {
    callType: 'external_http',
    method: external.method,
    payloadSummary: undefined,
    confidence: 0.7,
    unresolvedReason:
      'External HTTP destination is outside indexed CAP services',
    externalTarget: {
      kind: safeTarget.kind,
      stableId: safeTarget.toId,
      label: safeTarget.label,
      dynamic: safeTarget.dynamic,
    },
  }, {
    classifier: external.classifier,
    externalTarget: safeTarget,
    sourceCallShape: external.sourceCallShape,
  });
}

function classifyOutboundCall(
  node: ts.CallExpression,
  context: OutboundCallContext,
): void {
  if (classifyQueryDispatch(node, context)) return;
  if (classifySendCall(node, context)) return;
  if (classifyWrapperCall(node, context)) return;
  if (classifyEventCall(node, context)) return;
  classifyExternalCall(node, context);
}

function visitOutboundCalls(
  source: ts.SourceFile,
  internalRanges: readonly { start: number; end: number }[],
  classify: (node: ts.CallExpression) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && internalRanges.some((range) =>
      node.getStart(source) >= range.start && node.getEnd() <= range.end))
      return;
    if (ts.isCallExpression(node)) classify(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function classifyOutboundCallsInSource(
  source: ts.SourceFile,
  filePath: string,
): ClassifiedOutboundCall[] {
  const calls: ClassifiedOutboundCall[] = [];
  const sourceFile = normalizePath(filePath);
  const initializers = variableInitializers(source);
  const serviceVariables = collectServiceVariables(source);
  const wrapperSpecs = collectWrapperSpecs(source);
  const internalRanges = [...wrapperSpecs.values()].map((spec) => ({
    start: spec.internalStart, end: spec.internalEnd,
  }));
  const add: AddOutboundCall = (node, fact, extra): void => {
    calls.push({ node, fact: {
      ...fact,
      sourceFile,
      sourceLine: lineOf(source.text, node.getStart(source)),
      callSiteStartOffset: node.getStart(source),
      callSiteEndOffset: node.getEnd(),
      confidence: fact.confidence ?? 0.8,
      evidence: parserEvidence(source, node, extra),
    } });
  };
  const context = {
    source, initializers, serviceVariables, wrapperSpecs, add,
  };
  visitOutboundCalls(
    source, internalRanges,
    (node) => classifyOutboundCall(node, context),
  );
  return calls;
}
