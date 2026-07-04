export interface NormalizedODataOperationPath {
  rawOperationPath: string;
  normalizedOperationPath: string;
  wasInvocation: boolean;
}

export function normalizeODataOperationInvocationPath(path: string | undefined): NormalizedODataOperationPath | undefined {
  if (path === undefined) return undefined;
  const raw = path.trim();
  if (!raw) return undefined;
  const open = raw.indexOf('(');
  if (open < 0) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  if (!raw.startsWith('/') || raw.slice(1, open).includes('/')) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  const close = matchingClose(raw, open);
  if (close === undefined || raw.slice(close + 1).trim().length > 0) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  const operationSegment = raw.slice(0, open).trim();
  if (operationSegment.length <= 1) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  return { rawOperationPath: raw, normalizedOperationPath: operationSegment, wasInvocation: true };
}

function matchingClose(text: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: 'single' | 'double' | 'template' | undefined;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === '\\') continue;
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"') || (quote === 'template' && char === '`')) quote = undefined;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '`') { quote = 'template'; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}
