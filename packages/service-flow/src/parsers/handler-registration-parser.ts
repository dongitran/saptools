import fs from 'node:fs/promises';
import path from 'node:path';
import type { HandlerRegistrationFact } from '../types.js';
import { normalizePath } from '../utils/path-utils.js';
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}
export async function parseHandlerRegistrations(
  repoPath: string,
  filePath: string
): Promise<HandlerRegistrationFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  const out: HandlerRegistrationFact[] = [];
  const imports = new Map<string, string>();
  for (const m of text.matchAll(/import\s+\{?\s*([A-Za-z0-9_,\s]+)\s*\}?\s+from\s+['"]([^'"]+)['"]/g)) {
    const source = m[2];
    for (const name of (m[1] ?? '').split(',')) {
      const symbol = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (symbol) imports.set(symbol, source);
    }
  }
  for (const m of text.matchAll(
    /createCombinedHandler\s*\(|srv\.prepend\s*\(|cds\.serve\s*\(/g
  ))
    out.push({
      registrationFile: normalizePath(filePath),
      registrationLine: lineOf(text, m.index ?? 0),
      registrationKind: m[0].startsWith('cds')
        ? 'cds.serve'
        : 'combined-handler',
      confidence: 0.8
    });
  for (const m of text.matchAll(
    /(?:const|export\s+const)\s+handlers\s*=\s*\[([\s\S]*?)\]/g
  ))
    for (const c of (m[1] ?? '').matchAll(/\b(\w+Handler)\b/g))
      out.push({
        className: c[1],
        importSource: imports.get(c[1]),
        registrationFile: normalizePath(filePath),
        registrationLine: lineOf(text, (m.index ?? 0) + (c.index ?? 0)),
        registrationKind: 'handler-array',
        confidence: 0.9
      });
  return out;
}
