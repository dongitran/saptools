import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { OutboundCallFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
import { summarizeExpression } from '../utils/redaction.js';
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
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (node.parent.flags & ts.NodeFlags.Const) !== 0) initializers.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
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
export function classifyOutboundCallsInSource(source: ts.SourceFile, filePath: string): ClassifiedOutboundCall[] {
  const calls: ClassifiedOutboundCall[] = [];
  const sourceFile = normalizePath(filePath);
  const initializers = variableInitializers(source);
  const serviceVariables = collectServiceVariables(source);
  const add = (node: ts.CallExpression, fact: Omit<OutboundCallFact, 'sourceFile' | 'sourceLine' | 'confidence'> & { confidence?: number }, extra?: Record<string, unknown>): void => {
    calls.push({ node, fact: { ...fact, sourceFile, sourceLine: lineOf(source.text, node.getStart(source)), confidence: fact.confidence ?? 0.8, evidence: parserEvidence(source, node, extra) } });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const exprText = expr.getText(source);
      if (exprText === 'cds.run') {
        const arg = node.arguments[0];
        const entity = arg ? queryEntityFromAst(arg, initializers) : undefined;
        const payload = arg?.getText(source) ?? '';
        add(node, { callType: 'local_db_query', queryEntity: entity, payloadSummary: summarizeExpression(payload), confidence: entity ? 0.9 : 0.55, unresolvedReason: entity ? undefined : queryWarning(payload) });
      } else if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'send' && ts.isIdentifier(expr.expression)) {
        const objectArg = node.arguments[0];
        if (objectArg && ts.isObjectLiteralExpression(objectArg)) {
          const receiver = expr.expression.text;
          const query = objectPropertyText(objectArg, 'query');
          const op = objectPropertyText(objectArg, 'path') ?? objectPropertyText(objectArg, 'event');
          const shorthandPath = objectPropertyIsShorthand(objectArg, 'path');
          add(node, { callType: query ? 'remote_query' : 'remote_action', serviceVariableName: receiver, method: stripQuotes(objectPropertyText(objectArg, 'method') ?? 'POST'), operationPathExpr: op && !shorthandPath ? `/${stripQuotes(op).replace(/^\//, '')}` : undefined, queryEntity: query ? extractQueryEntity(query) : undefined, payloadSummary: summarizeExpression(objectArg.getText(source)), confidence: op || query ? 0.8 : 0.4, unresolvedReason: !query && shorthandPath ? 'dynamic_operation_path_identifier' : undefined }, { receiver, classifier: 'service_client_send_object', operationPathExpression: shorthandPath ? op : undefined, parserWarning: shorthandPath ? 'dynamic_operation_path_identifier' : undefined });
        }
      } else if (ts.isPropertyAccessExpression(expr) && ['emit', 'publish', 'on'].includes(expr.name.text)) {
        const receiver = receiverName(expr.expression);
        const rootReceiver = rootReceiverName(expr.expression);
        if (isSupportedEventReceiver(receiver, rootReceiver, serviceVariables)) {
          const eventName = literalText(node.arguments[0]);
          if (eventName) add(node, { callType: expr.name.text === 'on' ? 'async_subscribe' : 'async_emit', serviceVariableName: rootReceiver ?? receiver, eventNameExpr: eventName }, { receiver, rootReceiver, classifier: expr.name.text === 'on' ? 'cap_service_event_subscription' : 'cap_service_event_emit', receiverClassification: 'cap_evidence' });
        }
      } else if (exprText === 'axios' || exprText === 'executeHttpRequest' || exprText === 'useOrFetchDestination') {
        add(node, { callType: 'external_http', payloadSummary: summarizeExpression(node.arguments.map((arg) => arg.getText(source)).join(', ')), confidence: 0.7, unresolvedReason: 'External HTTP destination is outside indexed CAP services' });
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
): Promise<OutboundCallFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  return [...classifyOutboundCallsInSource(source, filePath).map((call) => call.fact), ...parseLocalServiceCalls(text, filePath)];
}
function parseLocalServiceCalls(text: string, filePath: string): OutboundCallFact[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const aliases = new Map<string, { service: string; lookup: string; chain: string[] }>();
  const calls: OutboundCallFact[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const origin = serviceLookup(node.initializer, aliases);
      if (origin) aliases.set(node.name.text, { ...origin, chain: [...origin.chain, node.name.text] });
    }
    if (ts.isCallExpression(node)) {
      const parsed = serviceOperationCall(node.expression, aliases);
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
          classifier: 'local_cap_service_call',
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
function serviceOperationCall(expr: ts.Expression, aliases: Map<string, { service: string; lookup: string; chain: string[] }>): { service: string; lookup: string; chain: string[]; operation: string } | undefined {
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const operation = expr.name.text;
  const origin = serviceLookup(expr.expression, aliases);
  if (!origin) return undefined;
  return { ...origin, operation };
}
