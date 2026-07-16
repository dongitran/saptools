export interface PlaceholderSpan {
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

export function scanPlaceholders(value: string | undefined): readonly PlaceholderSpan[] {
  const input = value ?? '';
  const spans: PlaceholderSpan[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('${', cursor);
    if (start < 0) break;
    const closingBrace = input.indexOf('}', start + 2);
    if (closingBrace < 0) break;
    spans.push({
      start,
      end: closingBrace + 1,
      key: input.slice(start + 2, closingBrace),
    });
    cursor = closingBrace + 1;
  }
  return spans;
}

export function extractPlaceholderKeys(value: string | undefined): string[] {
  return scanPlaceholders(value)
    .map((span) => span.key.trim())
    .filter(Boolean);
}
