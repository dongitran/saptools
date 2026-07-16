const SENSITIVE = /authorization|cookie|token|secret|password|key|credential/i;
const SENSITIVE_KEYWORD = /authorization|cookie|token|secret|password|key|credential/gi;

interface RedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly keyword: string;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function redactionSpan(text: string, start: number, keyword: string): RedactionSpan | undefined {
  let cursor = start + keyword.length;
  while (isWhitespace(text[cursor])) cursor += 1;
  if (text[cursor] !== ':' && text[cursor] !== '=') return undefined;
  cursor += 1;
  while (isWhitespace(text[cursor])) cursor += 1;
  const candidateQuote = text[cursor];
  const quote = candidateQuote === "'" || candidateQuote === '"' || candidateQuote === '`'
    ? candidateQuote
    : undefined;
  if (quote !== undefined) cursor += 1;
  const valueStart = cursor;
  while (cursor < text.length && !/[,'"`}\s]/u.test(text[cursor] ?? '')) cursor += 1;
  if (cursor === valueStart) return undefined;
  if (quote !== undefined) {
    if (text[cursor] !== quote) return undefined;
    cursor += 1;
  }
  return { start, end: cursor, keyword };
}

export function redactText(text: string): string {
  let cursor = 0;
  let output = '';
  for (const match of text.matchAll(SENSITIVE_KEYWORD)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const span = redactionSpan(text, start, match[0]);
    if (span === undefined) continue;
    output += text.slice(cursor, span.start) + `${span.keyword}: [REDACTED]`;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redactValue(v);
    return out;
  }
  return typeof value === 'string' ? redactText(value) : value;
}
export function summarizeExpression(text: string): string {
  return redactText(text).slice(0, 240);
}
