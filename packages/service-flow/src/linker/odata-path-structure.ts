import {
  scanPlaceholderStructure,
  type PlaceholderSpan,
} from '../utils/placeholders.js';

export type ODataPathStructureReason =
  | 'path_parenthesis_is_unbalanced'
  | 'path_parenthesis_suffix_is_invalid'
  | 'path_placeholder_is_malformed'
  | 'path_quote_is_unbalanced';

export interface ODataPathSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ODataPathStructure {
  readonly status: 'valid' | 'malformed';
  readonly reason?: ODataPathStructureReason;
  readonly rawPath: string;
  readonly pathWithoutQuery: string;
  readonly queryString?: string;
  readonly queryIndex?: number;
  readonly placeholderSpans: readonly PlaceholderSpan[];
  readonly placeholderKeys: string[];
  readonly segments: readonly ODataPathSegment[];
  readonly firstSegment?: ODataPathSegment;
  readonly firstSegmentHead?: string;
  readonly firstSegmentHeadRuntimeDependent: boolean;
  readonly firstParenthesisOpen?: number;
  readonly firstParenthesisClose?: number;
  readonly firstParenthesisArguments?: string;
  readonly firstParenthesisPlaceholderKeys: string[];
}

interface SyntaxScan {
  readonly queryIndex?: number;
  readonly separators: number[];
  readonly firstOpen?: number;
  readonly firstClose?: number;
  readonly reason?: ODataPathStructureReason;
}

interface ParenthesisState {
  readonly stack: number[];
  firstOpen?: number;
  firstClose?: number;
  segmentIndex: number;
}

interface SyntaxCursor {
  index: number;
  spanIndex: number;
}

interface HeadEvidence {
  readonly firstSegment?: ODataPathSegment;
  readonly firstSegmentHead?: string;
  readonly firstSegmentHeadRuntimeDependent: boolean;
}

interface ArgumentEvidence {
  readonly firstParenthesisArguments?: string;
  readonly firstParenthesisPlaceholderKeys: string[];
}

export function analyzeODataPathStructure(
  path: string | undefined,
): ODataPathStructure {
  const rawPath = (path ?? '').trim();
  const placeholders = scanPlaceholderStructure(rawPath);
  if (placeholders.status === 'malformed')
    return malformedStructure(rawPath, 'path_placeholder_is_malformed');
  const syntax = scanSyntax(rawPath, placeholders.spans);
  if (syntax.reason)
    return malformedStructure(rawPath, syntax.reason, placeholders.spans);
  return validStructure(rawPath, placeholders.spans, syntax);
}

function scanSyntax(
  raw: string,
  placeholders: readonly PlaceholderSpan[],
): SyntaxScan {
  const state: ParenthesisState = { stack: [], segmentIndex: 0 };
  const cursor: SyntaxCursor = { index: 0, spanIndex: 0 };
  const separators: number[] = [];
  while (cursor.index < raw.length) {
    const step = scanSyntaxStep(raw, placeholders, cursor, state, separators);
    if (step.reason) return { separators, reason: step.reason };
    if (step.query) {
      const queryReason = validateQuerySyntax(
        raw, cursor.index + 1, placeholders, cursor.spanIndex,
      );
      if (queryReason) return { separators, reason: queryReason };
      return finalizedSyntax(raw, separators, state, cursor.index);
    }
  }
  if (state.stack.length > 0)
    return { separators, reason: 'path_parenthesis_is_unbalanced' };
  return finalizedSyntax(raw, separators, state);
}

function validateQuerySyntax(
  raw: string,
  start: number,
  placeholders: readonly PlaceholderSpan[],
  initialSpanIndex: number,
): ODataPathStructureReason | undefined {
  const cursor: SyntaxCursor = { index: start, spanIndex: initialSpanIndex };
  let parenthesisDepth = 0;
  while (cursor.index < raw.length) {
    if (skipPlaceholder(placeholders, cursor)) continue;
    const char = raw[cursor.index];
    if (["'", '"'].includes(char)) {
      const end = quotedEnd(
        raw, cursor.index, char, placeholders, cursor.spanIndex,
      );
      if (end === undefined) return 'path_quote_is_unbalanced';
      cursor.index = end;
      continue;
    }
    if (char === '(') parenthesisDepth += 1;
    if (char === ')' && parenthesisDepth === 0)
      return 'path_parenthesis_is_unbalanced';
    if (char === ')') parenthesisDepth -= 1;
    cursor.index += 1;
  }
  return parenthesisDepth === 0
    ? undefined : 'path_parenthesis_is_unbalanced';
}

function scanSyntaxStep(
  raw: string,
  placeholders: readonly PlaceholderSpan[],
  cursor: SyntaxCursor,
  state: ParenthesisState,
  separators: number[],
): { query?: boolean; reason?: ODataPathStructureReason } {
  if (skipPlaceholder(placeholders, cursor)) return {};
  const char = raw[cursor.index];
  if (char === "'" || char === '"') {
    const end = quotedEnd(raw, cursor.index, char, placeholders, cursor.spanIndex);
    if (end === undefined) return { reason: 'path_quote_is_unbalanced' };
    cursor.index = end;
    return {};
  }
  const result = consumePathDelimiter(raw, cursor.index, state, separators);
  if (!result.query && !result.reason) cursor.index += 1;
  return result;
}

function skipPlaceholder(
  placeholders: readonly PlaceholderSpan[],
  cursor: SyntaxCursor,
): boolean {
  while (placeholders[cursor.spanIndex]?.end
    && (placeholders[cursor.spanIndex]?.end ?? 0) <= cursor.index)
    cursor.spanIndex += 1;
  const span = placeholders[cursor.spanIndex];
  if (span?.start !== cursor.index) return false;
  cursor.index = span.end;
  cursor.spanIndex += 1;
  return true;
}

function consumePathDelimiter(
  raw: string,
  index: number,
  state: ParenthesisState,
  separators: number[],
): { query?: boolean; reason?: ODataPathStructureReason } {
  const char = raw[index];
  if (char === '(') return openParenthesis(state, index);
  if (char === ')') return closeParenthesis(state, index);
  if (char === '?') return state.stack.length === 0 ? { query: true } : {};
  if (char === '/') addSeparator(state, separators, index);
  return {};
}

function openParenthesis(
  state: ParenthesisState,
  index: number,
): { reason?: ODataPathStructureReason } {
  if (state.stack.length === 0 && state.segmentIndex === 0) {
    if (state.firstOpen !== undefined)
      return { reason: 'path_parenthesis_suffix_is_invalid' };
    state.firstOpen = index;
  }
  state.stack.push(index);
  return {};
}

function closeParenthesis(
  state: ParenthesisState,
  index: number,
): { reason?: ODataPathStructureReason } {
  if (state.stack.length === 0)
    return { reason: 'path_parenthesis_is_unbalanced' };
  state.stack.pop();
  if (state.stack.length === 0 && state.segmentIndex === 0)
    state.firstClose = index;
  return {};
}

function addSeparator(
  state: ParenthesisState,
  separators: number[],
  index: number,
): void {
  if (index === 0 || state.stack.length > 0) return;
  separators.push(index);
  state.segmentIndex += 1;
}

function finalizedSyntax(
  raw: string,
  separators: number[],
  state: ParenthesisState,
  queryIndex?: number,
): SyntaxScan {
  if (state.stack.length > 0)
    return { separators, reason: 'path_parenthesis_is_unbalanced' };
  const firstEnd = separators[0] ?? queryIndex ?? raw.length;
  if (state.firstClose !== undefined
    && raw.slice(state.firstClose + 1, firstEnd).trim())
    return { separators, reason: 'path_parenthesis_suffix_is_invalid' };
  return {
    queryIndex, separators,
    firstOpen: state.firstOpen, firstClose: state.firstClose,
  };
}

function quotedEnd(
  raw: string,
  start: number,
  quote: string,
  placeholders: readonly PlaceholderSpan[],
  initialSpanIndex: number,
): number | undefined {
  let spanIndex = initialSpanIndex;
  let index = start + 1;
  while (index < raw.length) {
    const span = placeholders[spanIndex];
    if (span?.start === index) {
      index = span.end;
      spanIndex += 1;
      continue;
    }
    if (raw[index] === '\\') {
      index += 2;
      continue;
    }
    if (raw[index] !== quote) {
      index += 1;
      continue;
    }
    if (raw[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return undefined;
}

function validStructure(
  rawPath: string,
  spans: readonly PlaceholderSpan[],
  syntax: SyntaxScan,
): ODataPathStructure {
  const pathEnd = syntax.queryIndex ?? rawPath.length;
  const pathWithoutQuery = rawPath.slice(0, pathEnd);
  const segments = pathSegments(rawPath, pathEnd, syntax.separators);
  const head = headEvidence(rawPath, segments, spans, syntax.firstOpen);
  const argumentsResult = argumentEvidence(rawPath, spans, syntax);
  return {
    status: 'valid', rawPath, pathWithoutQuery,
    queryString: queryString(rawPath, syntax.queryIndex),
    queryIndex: syntax.queryIndex,
    placeholderSpans: spans,
    placeholderKeys: uniqueKeys(spans),
    segments,
    ...head,
    firstParenthesisOpen: syntax.firstOpen,
    firstParenthesisClose: syntax.firstClose,
    ...argumentsResult,
  };
}

function headEvidence(
  raw: string,
  segments: readonly ODataPathSegment[],
  spans: readonly PlaceholderSpan[],
  firstOpen: number | undefined,
): HeadEvidence {
  const firstSegment = segments[0];
  if (!firstSegment)
    return { firstSegmentHeadRuntimeDependent: false };
  const end = firstOpen ?? firstSegment.end;
  const value = raw.slice(firstSegment.start, end).trim();
  return {
    firstSegment,
    firstSegmentHead: value || undefined,
    firstSegmentHeadRuntimeDependent: spans.some((span) =>
      overlaps(span, firstSegment.start, end)),
  };
}

function argumentEvidence(
  raw: string,
  spans: readonly PlaceholderSpan[],
  syntax: SyntaxScan,
): ArgumentEvidence {
  if (syntax.firstOpen === undefined || syntax.firstClose === undefined)
    return { firstParenthesisPlaceholderKeys: [] };
  const start = syntax.firstOpen + 1;
  const end = syntax.firstClose;
  return {
    firstParenthesisArguments: raw.slice(start, end),
    firstParenthesisPlaceholderKeys: uniqueKeys(spans.filter((span) =>
      span.start >= start && span.end <= end)),
  };
}

function queryString(raw: string, queryIndex: number | undefined): string | undefined {
  return queryIndex === undefined ? undefined : raw.slice(queryIndex + 1);
}

function pathSegments(
  raw: string,
  pathEnd: number,
  separators: number[],
): ODataPathSegment[] {
  const start = raw.startsWith('/') ? 1 : 0;
  const boundaries = separators.filter((value) => value >= start && value < pathEnd);
  const ends = [...boundaries, pathEnd];
  let current = start;
  const segments: ODataPathSegment[] = [];
  for (const end of ends) {
    const text = raw.slice(current, end);
    if (text) segments.push({ text, start: current, end });
    current = end + 1;
  }
  return segments;
}

function malformedStructure(
  rawPath: string,
  reason: ODataPathStructureReason,
  spans: readonly PlaceholderSpan[] = [],
): ODataPathStructure {
  return {
    status: 'malformed', reason, rawPath, pathWithoutQuery: rawPath,
    placeholderSpans: spans, placeholderKeys: [],
    segments: [], firstSegmentHeadRuntimeDependent: false,
    firstParenthesisPlaceholderKeys: [],
  };
}

function overlaps(
  span: PlaceholderSpan,
  start: number,
  end: number,
): boolean {
  return span.start < end && span.end > start;
}

function uniqueKeys(spans: readonly PlaceholderSpan[]): string[] {
  return [...new Set(spans.map((span) => span.key.trim()).filter(Boolean))];
}
