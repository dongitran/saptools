export function readableIdentifier(value: string): string {
  if (!value.trimStart().startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0
      || !parsed.every((item) =>
        typeof item === 'string' || typeof item === 'number')) return value;
    const parts = parsed.map(String);
    return parts.every((part) => part.startsWith('/'))
      ? parts.join('')
      : parts.join(' / ');
  } catch {
    return value;
  }
}
