const SCOPE_SEGMENT_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/%/g, '%25'],
  [/\(/g, '%28'],
  [/\)/g, '%29'],
  [/,/g, '%2C'],
  [/#/g, '%23'],
];
const SCOPE_CAPTION_PREFIX = 'scope:';

// '%' must be escaped first or the other replacements become ambiguous.
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
  // Arity is explicit for 0 and 2+ members, and escaped members can contain
  // neither '(' nor ',', so the alternatives stay pairwise disjoint.
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

function flatArrayLabel(parsed: unknown, fallback: string): string {
  if (!Array.isArray(parsed) || parsed.length === 0
    || !parsed.every((item) =>
      typeof item === 'string' || typeof item === 'number')) return fallback;
  const parts = parsed.map(String);
  const rendered = parts.every((part) => part.startsWith('/'))
    ? parts.join('')
    : parts.join(' / ');
  // The structural grammar owns this namespace. Preserve a colliding flat
  // array verbatim so two distinct identifiers cannot share one caption.
  return rendered.startsWith(SCOPE_CAPTION_PREFIX) ? fallback : rendered;
}

export function readableIdentifier(value: string): string {
  if (!value.startsWith('[') || !value.endsWith(']')) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4)
    return flatArrayLabel(parsed, value);
  const tuple: readonly unknown[] = parsed;
  const [workspaceId, repositoryId, files, symbolIds] = tuple;
  if (!isScopeNumber(workspaceId) || !isScopeNumber(repositoryId)
    || !isScopeStringList(files) || !isScopeNumberList(symbolIds))
    return flatArrayLabel(parsed, value);
  return `${SCOPE_CAPTION_PREFIX}${scopeNumberField(workspaceId)}/${
    scopeNumberField(repositoryId)}/${
    scopeListField(files, escapeScopeSegment)}#${
    scopeListField(symbolIds, String)}`;
}
