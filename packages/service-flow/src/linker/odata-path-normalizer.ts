export interface NormalizedODataOperationPath {
  rawOperationPath: string;
  normalizedOperationPath: string;
  wasInvocation: boolean;
  invocationArgumentPlaceholderKeys: string[];
  normalizationReason?: string;
  normalizationRejectedReason?: string;
}

export type ODataPathIntentKind = 'operation_invocation' | 'entity_query' | 'entity_key_read' | 'entity_navigation_query' | 'entity_mutation' | 'entity_delete' | 'entity_media' | 'entity_candidate' | 'unknown';

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
  const rejected = (reason: string): NormalizedODataOperationPath => ({ rawOperationPath: raw, normalizedOperationPath: raw, wasInvocation: false, invocationArgumentPlaceholderKeys: [], normalizationRejectedReason: reason });
  const open = raw.indexOf('(');
  if (open < 0) return rejected('no_top_level_parenthesis');
  const query = topLevelQueryIndex(raw);
  if (query >= 0) return rejected('query_string_paths_are_not_operation_invocations');
  if (!raw.startsWith('/')) return rejected('path_is_not_absolute');
  if (raw.slice(1, open).includes('/')) return rejected('operation_segment_contains_navigation_separator');
  const close = matchingClose(raw, open);
  if (close === undefined) return rejected('top_level_invocation_parenthesis_is_unbalanced');
  if (raw.slice(close + 1).trim().length > 0) return rejected('top_level_invocation_does_not_cover_remaining_path');
  const operationSegment = raw.slice(0, open).trim();
  if (operationSegment.length <= 1) return rejected('operation_segment_is_empty');
  return {
    rawOperationPath: raw,
    normalizedOperationPath: operationSegment,
    wasInvocation: true,
    invocationArgumentPlaceholderKeys: [...new Set(extractTemplatePlaceholders(raw.slice(open + 1, close)))],
    normalizationReason: 'balanced_top_level_operation_invocation',
  };
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
  const upperEntityLike = /^[A-Z][A-Za-z0-9_]*$/.test(entitySegment ?? firstSegment);
  const mediaLike = ['content', '$value'].includes((segments.at(-1) ?? '').toLowerCase());
  const invocation = normalizeODataOperationInvocationPath(pathWithoutQuery);
  if (normalizedMethod !== 'GET') {
    if (invocation?.wasInvocation && looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: 'operation_invocation', reason: 'non_get_balanced_top_level_operation_invocation' };
    if (mediaLike) return { ...base, kind: 'entity_media', reason: 'non_get_entity_media_stream_path' };
    if (hasNavigationSegments || firstSegment.includes('(')) return { ...base, kind: normalizedMethod === 'DELETE' ? 'entity_delete' : 'entity_mutation', reason: 'non_get_entity_path_shape' };
    if (upperEntityLike) return { ...base, kind: normalizedMethod === 'DELETE' ? 'entity_delete' : 'entity_mutation', reason: 'non_get_entity_path_shape' };
    return { ...base, kind: 'operation_invocation', reason: 'non_get_lowercase_path_may_be_operation' };
  }
  if (queryIndex >= 0) {
    if (hasNavigationSegments) return { ...base, kind: 'entity_navigation_query', reason: 'get_path_has_navigation_and_query_string' };
    if (looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: 'unknown', reason: 'get_invocation_with_query_string_requires_indexed_operation_evidence' };
    return { ...base, kind: 'entity_query', reason: 'get_collection_path_has_query_string' };
  }
  if (hasNavigationSegments) return mediaLike ? { ...base, kind: 'entity_media', reason: 'get_entity_media_stream_path' } : { ...base, kind: 'entity_navigation_query', reason: 'get_path_has_navigation_segments' };
  if (firstSegment.includes('(')) {
    if (invocation?.wasInvocation && looksLikeLowerCamelInvocation(firstSegment)) return { ...base, kind: 'operation_invocation', reason: 'get_balanced_top_level_operation_invocation' };
    return looksLikeLowerCamelInvocation(firstSegment)
      ? { ...base, kind: 'operation_invocation', reason: 'get_single_lower_camel_segment_has_top_level_invocation' }
      : { ...base, kind: 'entity_key_read', reason: 'get_entity_segment_has_key_predicate' };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(firstSegment)) return { ...base, kind: 'entity_candidate', reason: 'uppercase_collection_segment_without_indexed_entity_evidence' };
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
  const keys: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== '$' || text[index + 1] !== '{') continue;
    const close = matchingPlaceholderClose(text, index + 1);
    if (close === undefined) continue;
    const key = text.slice(index + 2, close).trim();
    if (key) keys.push(key);
    index = close;
  }
  return keys;
}

function matchingClose(text: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: 'single' | 'double' | 'template' | undefined;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === '\\') continue;
      if (quote === 'template' && char === '$' && text[index + 1] === '{') {
        const close = matchingPlaceholderClose(text, index + 1);
        if (close === undefined) return undefined;
        index = close;
        continue;
      }
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"') || (quote === 'template' && char === '`')) quote = undefined;
      continue;
    }
    if (char === '$' && text[index + 1] === '{') {
      const close = matchingPlaceholderClose(text, index + 1);
      if (close === undefined) return undefined;
      index = close;
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

function matchingPlaceholderClose(text: string, openBraceIndex: number): number | undefined {
  let depth = 0;
  let quote: 'single' | 'double' | 'template' | undefined;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === '\\') continue;
      if (quote === 'template' && char === '$' && text[index + 1] === '{') {
        depth += 1;
        index += 1;
        continue;
      }
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"') || (quote === 'template' && char === '`')) quote = undefined;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '`') { quote = 'template'; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function topLevelQueryIndex(text: string): number {
  let quote: 'single' | 'double' | 'template' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (prev === '\\') continue;
      if (quote === 'template' && char === '$' && text[index + 1] === '{') {
        const close = matchingPlaceholderClose(text, index + 1);
        if (close === undefined) return -1;
        index = close;
        continue;
      }
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"') || (quote === 'template' && char === '`')) quote = undefined;
      continue;
    }
    if (char === '$' && text[index + 1] === '{') {
      const close = matchingPlaceholderClose(text, index + 1);
      if (close === undefined) return -1;
      index = close;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '`') { quote = 'template'; continue; }
    if (char === '?') return index;
  }
  return -1;
}
