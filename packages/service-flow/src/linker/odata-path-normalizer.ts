export interface NormalizedODataOperationPath {
  rawOperationPath: string;
  normalizedOperationPath: string;
  wasInvocation: boolean;
}

export type ODataPathIntentKind = 'operation_invocation' | 'entity_query' | 'entity_key_read' | 'entity_navigation_query' | 'unknown';

export interface ODataPathIntent {
  kind: ODataPathIntentKind;
  rawPath: string;
  method: string;
  pathWithoutQuery: string;
  queryString?: string;
  hasQueryString: boolean;
  entitySegment?: string;
  placeholderKeys: string[];
  reason: string;
}

export function normalizeODataOperationInvocationPath(path: string | undefined): NormalizedODataOperationPath | undefined {
  if (path === undefined) return undefined;
  const raw = path.trim();
  if (!raw) return undefined;
  const open = raw.indexOf('(');
  if (open < 0) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  const query = raw.indexOf('?');
  if (query >= 0) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  if (!raw.startsWith('/') || raw.slice(1, open).includes('/')) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  const close = matchingClose(raw, open);
  if (close === undefined || raw.slice(close + 1).trim().length > 0) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  const operationSegment = raw.slice(0, open).trim();
  if (operationSegment.length <= 1) return { rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false };
  return { rawOperationPath: raw, normalizedOperationPath: operationSegment, wasInvocation: true };
}

export function classifyODataPathIntent(path: string | undefined, method: string | undefined): ODataPathIntent {
  const rawPath = (path ?? '').trim();
  const normalizedMethod = (method ?? 'GET').trim().toUpperCase() || 'GET';
  const queryIndex = rawPath.indexOf('?');
  const pathWithoutQuery = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  const queryString = queryIndex >= 0 ? rawPath.slice(queryIndex + 1) : undefined;
  const segments = pathWithoutQuery.replace(/^\//, '').split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';
  const hasNavigationSegments = segments.length > 1;
  const entitySegment = entitySegmentFromPath(pathWithoutQuery);
  const placeholderKeys = [...new Set(extractTemplatePlaceholders(rawPath))];
  const base = { rawPath, method: normalizedMethod, pathWithoutQuery, queryString, hasQueryString: queryIndex >= 0, entitySegment, placeholderKeys };
  if (!rawPath || !rawPath.startsWith('/')) return { ...base, kind: 'unknown', reason: 'path_missing_or_not_absolute' };
  if (normalizedMethod !== 'GET') return { ...base, kind: 'operation_invocation', reason: 'non_get_service_send_defaults_to_operation' };
  if (queryIndex >= 0) {
    if (hasNavigationSegments) return { ...base, kind: 'entity_navigation_query', reason: 'get_path_has_navigation_and_query_string' };
    if (looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: 'unknown', reason: 'get_invocation_with_query_string_requires_indexed_operation_evidence' };
    return { ...base, kind: 'entity_query', reason: 'get_collection_path_has_query_string' };
  }
  if (hasNavigationSegments) return { ...base, kind: 'entity_navigation_query', reason: 'get_path_has_navigation_segments' };
  if (firstSegment.includes('(')) {
    return looksLikeLowerCamelInvocation(firstSegment)
      ? { ...base, kind: 'operation_invocation', reason: 'get_single_lower_camel_segment_has_top_level_invocation' }
      : { ...base, kind: 'entity_key_read', reason: 'get_entity_segment_has_key_predicate' };
  }
  return { ...base, kind: 'unknown', reason: 'get_path_has_no_query_key_or_navigation_signal' };
}

function entitySegmentFromPath(path: string): string | undefined {
  const first = path.replace(/^\//, '').split('/')[0]?.trim();
  if (!first) return undefined;
  const open = first.indexOf('(');
  const entity = (open >= 0 ? first.slice(0, open) : first).trim();
  return entity || undefined;
}

function looksLikeLowerCamelInvocation(segment: string): boolean {
  const open = segment.indexOf('(');
  if (open <= 0) return false;
  const name = segment.slice(0, open).split('.').at(-1) ?? segment.slice(0, open);
  return /^[a-z][A-Za-z0-9_]*$/.test(name);
}

function extractTemplatePlaceholders(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]*)\}/g)].map((match) => (match[1] ?? '').trim()).filter(Boolean);
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
