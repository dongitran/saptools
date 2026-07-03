import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServiceBindingFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}
function placeholders(value?: string): string[] {
  return [...(value ?? '').matchAll(/\$\{\s*(\w+)\s*\}/g)]
    .map((m) => m[1] ?? '')
    .filter(Boolean);
}
export async function parseServiceBindings(
  repoPath: string,
  filePath: string
): Promise<ServiceBindingFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const out: ServiceBindingFact[] = [];
  for (const m of text.matchAll(
    /(?:const|let|this\.)\s*(\w+)\s*=\s*(?:await\s*)?cds\.connect\.to\((['"`])([^'"`]+)\2\)/g
  ))
    out.push({
      variableName: m[1] ?? 'service',
      alias: m[3],
      isDynamic: false,
      placeholders: [],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0)
    });
  for (const m of text.matchAll(
    /(?:const|let|this\.)\s*(\w+)\s*=\s*(?:await\s*)?cds\.connect\.to\(\{([\s\S]*?)\}\s*\)/g
  )) {
    const body = m[2] ?? '';
    const destination = /destination\s*:\s*([^,\n]+)/.exec(body)?.[1];
    const servicePath = /path\s*:\s*([^,\n]+)/.exec(body)?.[1];
    const dest = destination ? stripQuotes(destination.trim()) : undefined;
    const svc = servicePath ? stripQuotes(servicePath.trim()) : undefined;
    const ph = [...placeholders(dest), ...placeholders(svc)];
    out.push({
      variableName: m[1] ?? 'service',
      destinationExpr: dest,
      servicePathExpr: svc,
      isDynamic: ph.length > 0,
      placeholders: ph,
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0)
    });
  }
  for (const m of text.matchAll(
    /(?:function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]*?return|const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s+(?:await\s*)?cds\.connect\.to\((['"`])([^'"`]+)\3\)/g
  ))
    out.push({
      variableName: m[1] ?? m[2] ?? 'connect',
      alias: m[4],
      isDynamic: false,
      placeholders: [],
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0)
    });

  const helperAliases = new Map(out.filter((b) => b.alias).map((b) => [b.variableName, b]));
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s*)?(\w+)\s*\(/g)) {
    const helper = helperAliases.get(m[2] ?? '');
    if (!helper) continue;
    out.push({
      ...helper,
      variableName: m[1] ?? 'service',
      sourceFile: normalizePath(filePath),
      sourceLine: lineOf(text, m.index ?? 0)
    });
  }
  return out;
}
