import fs from 'node:fs/promises';
import path from 'node:path';
import type { CdsOperationFact, CdsServiceFact } from '../types.js';
import { ensureLeadingSlash, normalizePath } from '../utils/path-utils.js';

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function maskCommentsAndStrings(text: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
    'code';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    const n = text[i + 1] ?? '';
    if (mode === 'code' && c === '/' && n === '/') {
      mode = 'line';
      out += '  ';
      i += 1;
      continue;
    }
    if (mode === 'code' && c === '/' && n === '*') {
      mode = 'block';
      out += '  ';
      i += 1;
      continue;
    }
    if (mode === 'line' && c === '\n') mode = 'code';
    if (mode === 'block' && c === '*' && n === '/') {
      mode = 'code';
      out += '  ';
      i += 1;
      continue;
    }
    if (mode === 'code' && (c === "'" || c === '"' || c === '`')) {
      mode = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
      out += ' ';
      continue;
    }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`'))
      mode = 'code';
    out += mode === 'code' || c === '\n' ? c : ' ';
  }
  return out;
}

function readAnnotation(text: string, index: number): { end: number; raw: string } | undefined {
  if (text[index] !== '@') return undefined;
  let i = index + 1;
  while (/\s/.test(text[i] ?? '')) i += 1;
  if (text[i] !== '(') return undefined;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (depth === 0) return { end: i + 1, raw: text.slice(index, i + 1) };
  }
  return undefined;
}

function collectAnnotations(text: string, index: number): { end: number; raw: string } {
  let i = index;
  let raw = '';
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '')) i += 1;
    const annotation = readAnnotation(text, i);
    if (!annotation) break;
    raw += annotation.raw;
    i = annotation.end;
  }
  return { end: i, raw };
}

function pathAnnotation(raw: string): string | undefined {
  return /path\s*:\s*(['"])(.*?)\1/s.exec(raw)?.[2];
}

function matchingBrace(maskedText: string, open: number): number {
  let depth = 0;
  for (let i = open; i < maskedText.length; i += 1) {
    if (maskedText[i] === '{') depth += 1;
    if (maskedText[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return maskedText.length - 1;
}
function annotationRawAt(original: string, masked: string, index: number): { end: number; raw: string } {
  const collected = collectAnnotations(masked, index);
  return { end: collected.end, raw: original.slice(index, collected.end) };
}

function operationsFromBody(text: string, maskedBody: string, bodyOffset: number, filePath: string): CdsOperationFact[] {
  return [...maskedBody.matchAll(/\b(action|function|event)\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:returns\s+([^;{]+))?/g)].map((m) => ({
    operationType: (m[1] as 'action' | 'function' | 'event') ?? 'action',
    operationName: m[2] ?? 'unknown',
    operationPath: ensureLeadingSlash(m[2] ?? 'unknown'),
    paramsJson: JSON.stringify((m[3] ?? '').split(',').map((part) => part.trim()).filter(Boolean)),
    returnType: m[4]?.trim(),
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(text, bodyOffset + (m.index ?? 0))
  }));
}

export async function parseCdsFile(repoPath: string, filePath: string): Promise<CdsServiceFact[]> {
  const absolute = path.join(repoPath, filePath);
  const text = await fs.readFile(absolute, 'utf8');
  const masked = maskCommentsAndStrings(text);
  const namespace = /namespace\s+([\w.]+)\s*;/.exec(masked)?.[1];
  const services: CdsServiceFact[] = [];
  const pendingAnnotations: Array<{ end: number; raw: string }> = [];
  for (const a of masked.matchAll(/@\s*\(/g)) pendingAnnotations.push(annotationRawAt(text, masked, a.index ?? 0));
  const serviceRegex = /\b(?:(extend)\s+)?(?:(service)\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = serviceRegex.exec(masked))) {
    const isExtend = match[1] === 'extend';
    const hasServiceKeyword = match[2] === 'service';
    if (!isExtend && !hasServiceKeyword) continue;
    const afterName = annotationRawAt(text, masked, serviceRegex.lastIndex);
    const open = masked.indexOf('{', afterName.end);
    if (open === -1) continue;
    const between = masked.slice(afterName.end, open).trim();
    if (between.length > 0) continue;
    const matchIndex = match.index;
    const prefix = pendingAnnotations
      .filter((a) => a.end <= matchIndex && matchIndex - a.end < 8)
      .map((a) => a.raw)
      .join('');
    const annotations = `${prefix}${afterName.raw}`;
    const end = matchingBrace(masked, open);
    const body = masked.slice(open + 1, end);
    const name = match[3] ?? 'UnknownService';
    const serviceName = name.split('.').pop() ?? name;
    const servicePath = ensureLeadingSlash(pathAnnotation(annotations) ?? serviceName);
    services.push({
      namespace,
      serviceName,
      qualifiedName: name.includes('.') ? name : namespace ? `${namespace}.${name}` : name,
      servicePath,
      isExtend,
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, match.index),
      operations: operationsFromBody(text, body, open + 1, filePath)
    });
    serviceRegex.lastIndex = end + 1;
  }
  const baseOps = new Map(services.filter((s) => !s.isExtend).map((s) => [s.qualifiedName, s.operations]));
  for (const service of services.filter((s) => s.isExtend && s.operations.length === 0)) {
    const inherited = baseOps.get(service.qualifiedName) ?? baseOps.get(service.serviceName);
    if (inherited) service.operations = inherited.map((op) => ({ ...op, sourceFile: service.sourceFile, sourceLine: service.sourceLine }));
  }
  return services;
}
