import fs from 'node:fs/promises';
import path from 'node:path';
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
function argumentForCall(expr: string, marker: string): string | undefined {
  const idx = expr.indexOf(marker);
  if (idx < 0) return undefined;
  const open = expr.indexOf('(', idx + marker.length);
  if (open < 0) return undefined;
  const close = matchingParen(expr, open);
  return close > open ? expr.slice(open + 1, close).trim() : undefined;
}
function entityFromArg(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  const first = arg.split(',')[0]?.trim();
  if (!first) return undefined;
  return stripQuotes(first).replace(/^this\./, '');
}
function extractQueryEntity(expr: string): string | undefined {
  return (
    entityFromArg(argumentForCall(expr, 'SELECT.one.from')) ??
    entityFromArg(argumentForCall(expr, 'SELECT.from')) ??
    entityFromArg(argumentForCall(expr, 'INSERT.into')) ??
    entityFromArg(argumentForCall(expr, 'UPDATE')) ??
    entityFromArg(argumentForCall(expr, 'DELETE.from'))
  );
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
      unresolvedReason: entity
        ? undefined
        : 'Could not resolve CAP query target entity from nested expression',
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
  for (const m of text.matchAll(
    /cds\.services(?:\[['"]([^'"]+)['"]\]|\.(\w+))\.(\w+)\s*\(/g,
  ))
    out.push({
      callType: 'local_service_call',
      operationPathExpr: `/${m[3] ?? ''}`,
      payloadSummary: m[1] ?? m[2],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.75,
    });
  return out;
}
