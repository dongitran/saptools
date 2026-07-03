import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { OutboundCallFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
import { summarizeExpression } from '../utils/redaction.js';
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}
function firstArg(body: string, key: string): string | undefined {
  return new RegExp(`${key}\\s*:\\s*([^,}\\n]+)`).exec(body)?.[1]?.trim();
}
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
export async function parseOutboundCalls(
  repoPath: string,
  filePath: string,
): Promise<OutboundCallFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const out: OutboundCallFact[] = [];
  for (const m of text.matchAll(/(\w+)\.send\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const body = m[2] ?? '';
    const query = firstArg(body, 'query');
    const op = firstArg(body, 'path') ?? firstArg(body, 'event');
    out.push({
      callType: query ? 'remote_query' : 'remote_action',
      serviceVariableName: m[1],
      method: stripQuotes(firstArg(body, 'method') ?? 'POST'),
      operationPathExpr: op
        ? `/${stripQuotes(op).replace(/^\//, '')}`
        : undefined,
      queryEntity: extractQueryEntity(query ?? ''),
      payloadSummary: summarizeExpression(body),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: op || query ? 0.8 : 0.4,
    });
  }
  for (const m of text.matchAll(/cds\.run\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].lastIndexOf('(');
    const close = matchingParen(text, open);
    const expr = close > open ? text.slice(open + 1, close) : '';
    const entity = extractQueryEntity(expr);
    out.push({
      callType: 'local_db_query',
      queryEntity: entity,
      payloadSummary: summarizeExpression(expr),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: entity ? 0.9 : 0.55,
      unresolvedReason: entity ? undefined : queryWarning(expr),
    });
  }
  for (const m of text.matchAll(
    /(\w+)\.(emit|publish|on)\s*\(\s*(['"`])([^'"`]+)\3/g,
  ))
    out.push({
      callType: m[2] === 'on' ? 'async_subscribe' : 'async_emit',
      serviceVariableName: m[1],
      eventNameExpr: m[4],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.8,
    });
  for (const m of text.matchAll(
    /(?:axios\s*\(|executeHttpRequest\s*\(|useOrFetchDestination\s*\()([\s\S]*?)\)/g,
  ))
    out.push({
      callType: 'external_http',
      payloadSummary: summarizeExpression(m[1] ?? ''),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.7,
      unresolvedReason:
        'External HTTP destination is outside indexed CAP services',
    });
  out.push(...parseLocalServiceCalls(text, filePath));
  return out;
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
