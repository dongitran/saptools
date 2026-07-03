import fs from 'node:fs/promises';
import path from 'node:path';
import type { CdsServiceFact } from '../types.js';
import { ensureLeadingSlash, normalizePath } from '../utils/path-utils.js';
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
function pathAnno(prefix: string): string | undefined {
  return /@\s*\(?\s*path\s*:\s*['"]([^'"]+)['"]\s*\)?/.exec(prefix)?.[1];
}
export async function parseCdsFile(
  repoPath: string,
  filePath: string
): Promise<CdsServiceFact[]> {
  const absolute = path.join(repoPath, filePath);
  const text = await fs.readFile(absolute, 'utf8');
  const namespace = /namespace\s+([\w.]+)\s*;/.exec(text)?.[1];
  const services: CdsServiceFact[] = [];
  const serviceRegex =
    /((?:@\s*\(?\s*path\s*:\s*['"][^'"]+['"]\s*\)?\s*)?)(extend\s+)?service\s+(\w+)\s*(?:@\s*\(?\s*path\s*:\s*['"]([^'"]+)['"]\s*\)?\s*)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = serviceRegex.exec(text))) {
    const serviceName = match[3] ?? 'UnknownService';
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (depth === 0) break;
    }
    const body = text.slice(start, end);
    const servicePath = ensureLeadingSlash(
      match[4] ?? pathAnno(match[1] ?? '') ?? serviceName
    );
    const ops = [
      ...body.matchAll(
        /\b(action|function|event)\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:returns\s+([^;{]+))?/g
      )
    ].map((m) => ({
      operationType: (m[1] as 'action' | 'function' | 'event') ?? 'action',
      operationName: m[2] ?? 'unknown',
      operationPath: ensureLeadingSlash(m[2] ?? 'unknown'),
      paramsJson: JSON.stringify(
        (m[3] ?? '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      ),
      returnType: m[4]?.trim(),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, start + (m.index ?? 0))
    }));
    services.push({
      namespace,
      serviceName,
      qualifiedName: namespace ? `${namespace}.${serviceName}` : serviceName,
      servicePath,
      isExtend: Boolean(match[2]),
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, match.index),
      operations: ops
    });
    serviceRegex.lastIndex = end;
  }
  return services;
}
