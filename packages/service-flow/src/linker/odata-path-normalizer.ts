import {
  analyzeODataPathStructure,
  type ODataPathStructure,
} from './odata-path-structure.js';

export interface NormalizedODataOperationPath {
  rawOperationPath: string;
  normalizedOperationPath: string;
  wasInvocation: boolean;
  invocationArguments?: string;
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
  keyPredicatePlaceholderKeys: string[];
  invocationArgumentPlaceholderKeys: string[];
  invocationArguments?: string;
  navigationSuffix?: string;
  mediaOrPropertySuffix?: string;
  hasEntityKeyPredicate: boolean;
  hasNavigationSuffix: boolean;
  hasMediaOrPropertySuffix: boolean;
  topLevelOperationName?: string;
  topLevelOperationNameCandidate: boolean;
  topLevelOperationInvocation: boolean;
  reason: string;
}

interface NavigationEvidence {
  readonly navigation: boolean;
  readonly suffix?: string;
  readonly navigationSuffix?: string;
}

interface OperationEvidence {
  readonly invocation: boolean;
  readonly name?: string;
}

export function normalizeODataOperationInvocationPath(
  path: string | undefined,
): NormalizedODataOperationPath | undefined {
  if (path === undefined) return undefined;
  const raw = path.trim();
  if (!raw) return undefined;
  const structure = analyzeODataPathStructure(raw);
  const rejection = normalizationRejection(raw, structure);
  if (rejection) return rejectedNormalization(raw, rejection);
  const operationSegment = raw.slice(
    0, structure.firstParenthesisOpen ?? 0,
  ).trim();
  if (operationSegment.length <= 1)
    return rejectedNormalization(raw, 'operation_segment_is_empty');
  return {
    rawOperationPath: raw,
    normalizedOperationPath: operationSegment,
    wasInvocation: true,
    invocationArguments: structure.firstParenthesisArguments,
    invocationArgumentPlaceholderKeys:
      structure.firstParenthesisPlaceholderKeys,
    normalizationReason: 'balanced_top_level_operation_invocation',
  };
}

function normalizationRejection(
  raw: string,
  structure: ODataPathStructure,
): string | undefined {
  if (structure.status === 'malformed')
    return structure.reason ?? 'path_structure_is_malformed';
  if (structure.firstParenthesisOpen === undefined)
    return 'no_top_level_parenthesis';
  if (structure.queryIndex !== undefined)
    return 'query_string_paths_are_not_operation_invocations';
  if (!raw.startsWith('/')) return 'path_is_not_absolute';
  if (structure.segments.length !== 1)
    return 'operation_segment_contains_navigation_separator';
  if (structure.firstSegmentHeadRuntimeDependent)
    return 'operation_segment_is_runtime_dependent';
  if (structure.firstParenthesisClose === undefined)
    return 'top_level_invocation_parenthesis_is_unbalanced';
  return undefined;
}

function rejectedNormalization(
  raw: string,
  reason: string,
): NormalizedODataOperationPath {
  return {
    rawOperationPath: raw, normalizedOperationPath: raw,
    wasInvocation: false, invocationArgumentPlaceholderKeys: [],
    normalizationRejectedReason: reason,
  };
}

export function classifyODataPathIntent(
  path: string | undefined,
  method: string | undefined,
): ODataPathIntent {
  const rawPath = (path ?? '').trim();
  const normalizedMethod = (method ?? 'GET').trim().toUpperCase() || 'GET';
  const structure = analyzeODataPathStructure(rawPath);
  const invocation = normalizeODataOperationInvocationPath(
    structure.pathWithoutQuery,
  );
  const base = intentBase(structure, normalizedMethod, invocation);
  if (!rawPath || !rawPath.startsWith('/'))
    return { ...base, kind: 'unknown', reason: 'path_missing_or_not_absolute' };
  if (structure.status === 'malformed')
    return {
      ...base, kind: 'unknown',
      reason: structure.reason ?? 'path_structure_is_malformed',
    };
  if (structure.firstSegmentHeadRuntimeDependent)
    return {
      ...base, kind: 'unknown',
      reason: 'path_classification_head_is_runtime_dependent',
    };
  return normalizedMethod === 'GET'
    ? classifyGet(structure, base, invocation)
    : classifyMutation(structure, base, invocation, normalizedMethod);
}

function intentBase(
  structure: ODataPathStructure,
  method: string,
  invocation: NormalizedODataOperationPath | undefined,
): Omit<ODataPathIntent, 'kind' | 'reason'> {
  const segments = structure.segments;
  const navigation = navigationEvidence(segments);
  const operation = operationEvidence(structure, invocation, navigation.navigation);
  return {
    rawPath: structure.rawPath, method,
    pathWithoutQuery: structure.pathWithoutQuery,
    queryString: structure.queryString,
    hasQueryString: structure.queryIndex !== undefined,
    entitySegment: structure.firstSegmentHead,
    placeholderKeys: structure.placeholderKeys,
    keyPredicatePlaceholderKeys: operation.invocation
      ? [] : structure.firstParenthesisPlaceholderKeys,
    invocationArgumentPlaceholderKeys:
      invocation?.invocationArgumentPlaceholderKeys ?? [],
    invocationArguments: invocation?.invocationArguments,
    navigationSuffix: navigation.navigationSuffix,
    mediaOrPropertySuffix: navigation.suffix,
    hasEntityKeyPredicate: structure.firstParenthesisOpen !== undefined,
    hasNavigationSuffix: navigation.navigation,
    hasMediaOrPropertySuffix: Boolean(
      navigation.suffix && isMediaOrPropertySuffix(navigation.suffix),
    ),
    topLevelOperationName: operation.name,
    topLevelOperationNameCandidate:
      operationNameIsCandidate(operation, structure, navigation.navigation),
    topLevelOperationInvocation: operation.invocation,
  };
}

function navigationEvidence(
  segments: readonly { text: string }[],
): NavigationEvidence {
  if (segments.length <= 1) return { navigation: false };
  return {
    navigation: true,
    suffix: segments.at(-1)?.text,
    navigationSuffix: segments.slice(1).map((item) => item.text).join('/'),
  };
}

function operationEvidence(
  structure: ODataPathStructure,
  normalized: NormalizedODataOperationPath | undefined,
  navigation: boolean,
): OperationEvidence {
  if (normalized?.wasInvocation)
    return {
      invocation: looksLikeLowerCamelHead(structure.firstSegmentHead),
      name: simpleName(normalized.normalizedOperationPath),
    };
  if (!navigation && structure.firstParenthesisOpen === undefined)
    return { invocation: false, name: structure.firstSegmentHead };
  return { invocation: false };
}

function operationNameIsCandidate(
  operation: OperationEvidence,
  structure: ODataPathStructure,
  navigation: boolean,
): boolean {
  return Boolean(
    operation.name && !navigation
    && structure.firstParenthesisOpen === undefined,
  );
}

function classifyGet(
  structure: ODataPathStructure,
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
  invocation: NormalizedODataOperationPath | undefined,
): ODataPathIntent {
  if (structure.queryIndex !== undefined) return classifyGetQuery(base);
  if (base.hasNavigationSuffix)
    return classifyGetNavigation(base);
  if (structure.firstParenthesisOpen !== undefined)
    return classifyGetParenthesis(base, invocation);
  if (isUpperEntity(base.entitySegment))
    return {
      ...base, kind: 'entity_candidate',
      reason: 'uppercase_collection_segment_without_indexed_entity_evidence',
    };
  return {
    ...base, kind: 'unknown',
    reason: 'get_path_has_no_query_key_or_navigation_signal',
  };
}

function classifyGetQuery(
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
): ODataPathIntent {
  if (base.hasNavigationSuffix)
    return {
      ...base, kind: 'entity_navigation_query',
      reason: 'get_path_has_navigation_and_query_string',
    };
  if (base.topLevelOperationInvocation)
    return {
      ...base, kind: 'unknown',
      reason: 'get_invocation_with_query_string_requires_indexed_operation_evidence',
    };
  return {
    ...base, kind: 'entity_query',
    reason: 'get_collection_path_has_query_string',
  };
}

function classifyGetNavigation(
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
): ODataPathIntent {
  return base.hasMediaOrPropertySuffix
    ? { ...base, kind: 'entity_media', reason: 'get_entity_media_stream_path' }
    : {
        ...base, kind: 'entity_navigation_query',
        reason: 'get_path_has_navigation_segments',
      };
}

function classifyGetParenthesis(
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
  invocation: NormalizedODataOperationPath | undefined,
): ODataPathIntent {
  if (invocation?.wasInvocation && base.topLevelOperationInvocation)
    return {
      ...base, kind: 'operation_invocation',
      reason: 'get_balanced_top_level_operation_invocation',
    };
  return {
    ...base, kind: 'entity_key_read',
    reason: 'get_entity_segment_has_key_predicate',
  };
}

function classifyMutation(
  structure: ODataPathStructure,
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
  invocation: NormalizedODataOperationPath | undefined,
  method: string,
): ODataPathIntent {
  if (invocation?.wasInvocation && base.topLevelOperationInvocation)
    return {
      ...base, kind: 'operation_invocation',
      reason: 'non_get_balanced_top_level_operation_invocation',
    };
  if (base.hasMediaOrPropertySuffix)
    return {
      ...base, kind: 'entity_media',
      reason: 'non_get_entity_media_stream_path',
    };
  if (base.hasNavigationSuffix || structure.firstParenthesisOpen !== undefined)
    return mutationEntityIntent(base, method,
      structure.firstParenthesisOpen !== undefined
        ? 'non_get_entity_key_or_navigation_path_shape'
        : 'non_get_entity_navigation_path_shape');
  if (isUpperEntity(base.entitySegment))
    return mutationEntityIntent(base, method, 'non_get_entity_path_shape');
  return {
    ...base, kind: 'operation_invocation',
    reason: 'non_get_lowercase_path_may_be_operation',
  };
}

function mutationEntityIntent(
  base: Omit<ODataPathIntent, 'kind' | 'reason'>,
  method: string,
  reason: string,
): ODataPathIntent {
  return {
    ...base,
    kind: method === 'DELETE' ? 'entity_delete' : 'entity_mutation',
    reason,
  };
}

function simpleName(path: string): string {
  const value = path.replace(/^\//, '');
  return value.split('.').at(-1) ?? value;
}

function isUpperEntity(value: string | undefined): boolean {
  return Boolean(value && /^[A-Z][A-Za-z0-9_]*$/.test(value));
}

function looksLikeLowerCamelHead(value: string | undefined): boolean {
  if (!value) return false;
  const name = value.split('.').at(-1) ?? value;
  return /^[a-z][A-Za-z0-9_]*$/.test(name);
}

function isMediaOrPropertySuffix(segment: string): boolean {
  return ['file', 'content', '$value', 'metadata', 'items']
    .includes(segment.toLowerCase());
}
