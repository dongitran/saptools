import fs from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedConstantFact } from '../types.js';
import { normalizePath, stripQuotes } from '../utils/path-utils.js';
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}
export async function parseGeneratedConstants(
  repoPath: string,
  filePath: string
): Promise<GeneratedConstantFact[]> {
  const text = await fs.readFile(path.join(repoPath, filePath), 'utf8');
  return [
    ...text.matchAll(
      /(?:export\s+)?(?:const|static\s+readonly)\s+(\w+)\s*=\s*(['"])([^'"]+)\2/g
    )
  ].map((m) => ({
    name: m[1] ?? 'constant',
    value: stripQuotes(m[3] ?? ''),
    sourceFile: normalizePath(filePath),
    sourceLine: lineOf(text, m.index ?? 0)
  }));
}
