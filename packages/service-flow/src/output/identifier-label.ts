const SCOPE_SEGMENT_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/%/g, '%25'],
  [/\(/g, '%28'],
  [/\)/g, '%29'],
  [/,/g, '%2C'],
  [/#/g, '%23'],
];

function escapeScopeSegment(value: string): string {
  return SCOPE_SEGMENT_ESCAPES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

function scopeNumberField(value: number | null): string {
  return value === null ? '-' : String(value);
}

function scopeListField<T>(
  values: readonly T[] | null,
  render: (item: T) => string,
): string {
  if (values === null) return '()';
  if (values.length === 0) return '0()';
  const parts = values.map(render);
  return parts.length === 1
    ? String(parts[0])
    : `${parts.length}(${parts.join(',')})`;
}

function isScopeNumber(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value));
}

function isScopeStringList(value: unknown): value is string[] | null {
  return value === null
    || (Array.isArray(value)
      && value.every((item) => typeof item === 'string'));
}

function isScopeNumberList(value: unknown): value is number[] | null {
  return value === null
    || (Array.isArray(value)
      && value.every((item) => typeof item === 'number'));
}

export function readableIdentifier(value: string): string {
  if (!value.startsWith('[') || !value.endsWith(']')) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return value;
  const tuple: readonly unknown[] = parsed;
  const [workspaceId, repositoryId, files, symbolIds] = tuple;
  if (!isScopeNumber(workspaceId) || !isScopeNumber(repositoryId)
    || !isScopeStringList(files) || !isScopeNumberList(symbolIds)) return value;
  return `scope:${scopeNumberField(workspaceId)}/${
    scopeNumberField(repositoryId)}/${
    scopeListField(files, escapeScopeSegment)}#${
    scopeListField(symbolIds, String)}`;
}
