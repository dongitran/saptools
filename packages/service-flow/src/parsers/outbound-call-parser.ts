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
export async function parseOutboundCalls(
  repoPath: string,
  filePath: string
): Promise<OutboundCallFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const out: OutboundCallFact[] = [];
  for (const m of text.matchAll(/(\w+)\.send\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const body = m[2] ?? '';
    const query = firstArg(body, 'query');
    const op = firstArg(body, 'path');
    out.push({
      callType: query ? 'remote_query' : 'remote_action',
      serviceVariableName: m[1],
      method: stripQuotes(firstArg(body, 'method') ?? 'POST'),
      operationPathExpr: op ? stripQuotes(op) : undefined,
      queryEntity: /SELECT(?:\.one)?\.from\(([\w.]+)\)/.exec(query ?? '')?.[1],
      payloadSummary: summarizeExpression(body),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: op || query ? 0.8 : 0.4
    });
  }
  for (const m of text.matchAll(/cds\.run\s*\(([\s\S]*?)\)/g))
    out.push({
      callType: 'local_db_query',
      queryEntity: /(?:SELECT(?:\.one)?\.from|INSERT\.into|UPDATE|DELETE\.from)\(([\w.]+)\)/.exec(m[1] ?? '')?.[1],
      payloadSummary: summarizeExpression(m[1] ?? ''),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.85
    });
  for (const m of text.matchAll(
    /(\w+)\.(emit|publish|on)\s*\(\s*(['"`])([^'"`]+)\3/g
  ))
    out.push({
      callType: m[2] === 'on' ? 'async_subscribe' : 'async_emit',
      serviceVariableName: m[1],
      eventNameExpr: m[4],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.8
    });
  for (const m of text.matchAll(
    /(?:axios\s*\(|executeHttpRequest\s*\(|useOrFetchDestination\s*\()([\s\S]*?)\)/g
  ))
    out.push({
      callType: 'external_http',
      payloadSummary: summarizeExpression(m[1] ?? ''),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.7,
      unresolvedReason:
        'External HTTP destination is outside indexed CAP services'
    });
  for (const m of text.matchAll(
    /cds\.services(?:\[['"]([^'"]+)['"]\]|\.(\w+))\.(\w+)\s*\(/g
  ))
    out.push({
      callType: 'local_service_call',
      operationPathExpr: `/${m[3] ?? ''}`,
      payloadSummary: m[1] ?? m[2],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0),
      confidence: 0.75
    });
  return out;
}
