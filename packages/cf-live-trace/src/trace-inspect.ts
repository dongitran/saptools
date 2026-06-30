import type { StoredTraceEvent } from "./trace-store.js";

export type TraceBodySide = "request" | "response";
export type TraceSearchBodySide = TraceBodySide | "both";

export interface TraceBodyInspectionOptions {
  readonly body: TraceBodySide;
  readonly path?: string;
  readonly limit?: number;
  readonly maxRows?: number;
}

export interface TraceBodyInspectionRow {
  readonly path: string;
  readonly type: string;
  readonly value: string;
}

export interface TraceBodyInspectionResult {
  readonly rows: readonly TraceBodyInspectionRow[];
  readonly totalRows: number;
  readonly rowsTruncated: boolean;
}

export interface TraceSearchOptions {
  readonly body: TraceSearchBodySide;
  readonly limit: number;
  readonly previewLength?: number;
}

export interface TraceSearchMatch {
  readonly sessionId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly method: string;
  readonly normalizedUrl: string;
  readonly status: number | null;
  readonly body: TraceBodySide;
  readonly path: string;
  readonly offset?: number;
  readonly preview: string;
}

const DEFAULT_BODY_LIMIT = 4000;

interface ParsedJson {
  readonly value: unknown;
}

export function inspectTraceBody(
  record: StoredTraceEvent,
  options: TraceBodyInspectionOptions,
): readonly TraceBodyInspectionRow[] {
  return inspectTraceBodyResult(record, options).rows;
}

export function inspectTraceBodyResult(
  record: StoredTraceEvent,
  options: TraceBodyInspectionOptions,
): TraceBodyInspectionResult {
  const limit = positive("limit", options.limit ?? DEFAULT_BODY_LIMIT);
  const maxRows = positive("max rows", options.maxRows ?? Number.MAX_SAFE_INTEGER);
  const pointer = options.path ?? "";
  const parsed = parseJsonBody(bodyText(record, options.body));
  const selected = resolvePointer(parsed, pointer);
  const rows = inspectionRows(selected, pointer, limit, maxRows);
  return {
    rows: rows.values,
    totalRows: rows.total,
    rowsTruncated: rows.total > rows.values.length,
  };
}

function inspectionRows(
  selected: unknown,
  pointer: string,
  valueLimit: number,
  maxRows: number,
): { readonly values: readonly TraceBodyInspectionRow[]; readonly total: number } {
  if (Array.isArray(selected)) {
    const values = selected.slice(0, maxRows).map(
      (item, index) => inspectionRow(`${pointer}/${String(index)}`, item, valueLimit),
    );
    return { values, total: selected.length };
  }
  if (!isRecord(selected)) {
    return { values: [inspectionRow(pointer, selected, valueLimit)], total: 1 };
  }
  return objectInspectionRows(selected, pointer, valueLimit, maxRows);
}

function objectInspectionRows(
  selected: Record<string, unknown>,
  pointer: string,
  valueLimit: number,
  maxRows: number,
): { readonly values: readonly TraceBodyInspectionRow[]; readonly total: number } {
  const values: TraceBodyInspectionRow[] = [];
  let total = 0;
  for (const key in selected) {
    if (!Object.hasOwn(selected, key)) {
      continue;
    }
    if (values.length < maxRows) {
      values.push(inspectionRow(`${pointer}/${escapePointerToken(key)}`, selected[key], valueLimit));
    }
    total += 1;
  }
  return { values, total };
}

export function searchTraceRecords(
  records: readonly StoredTraceEvent[],
  searchTerm: string,
  options: TraceSearchOptions,
): readonly TraceSearchMatch[] {
  const term = searchTerm.trim().toLowerCase();
  if (term.length === 0) {
    throw new Error("search text must not be empty");
  }
  const limit = positive("limit", options.limit);
  const previewLength = positive("preview length", options.previewLength ?? 128);
  const matches: TraceSearchMatch[] = [];
  for (const record of records) {
    for (const side of selectedSides(options.body)) {
      const remaining = limit - matches.length;
      matches.push(...searchBody(record, side, term, remaining, previewLength));
      if (matches.length >= limit) {
        return matches;
      }
    }
  }
  return matches;
}

function searchBody(
  record: StoredTraceEvent,
  side: TraceBodySide,
  term: string,
  limit: number,
  previewLength: number,
): readonly TraceSearchMatch[] {
  if (limit <= 0) {
    return [];
  }
  const body = bodyText(record, side);
  const parsed = tryParseJson(body);
  return parsed === undefined
    ? plainTextMatches(record, side, body, term, limit, previewLength)
    : jsonSearchMatches(record, side, parsed.value, term, limit, previewLength);
}

function plainTextMatches(
  record: StoredTraceEvent,
  side: TraceBodySide,
  text: string,
  term: string,
  limit: number,
  previewLength: number,
): readonly TraceSearchMatch[] {
  const matches: TraceSearchMatch[] = [];
  const lowerText = text.toLowerCase();
  let offset = lowerText.indexOf(term);
  while (offset >= 0 && matches.length < limit) {
    const start = Math.max(0, offset - 32);
    matches.push(toSearchMatch(record, side, "", text.slice(start, start + previewLength).replaceAll(/[\r\n\t]/g, " "), offset));
    offset = lowerText.indexOf(term, offset + Math.max(1, term.length));
  }
  return matches;
}

function jsonSearchMatches(
  record: StoredTraceEvent,
  side: TraceBodySide,
  root: unknown,
  term: string,
  limit: number,
  previewLength: number,
): readonly TraceSearchMatch[] {
  const matches: TraceSearchMatch[] = [];
  const stack: { readonly path: string; readonly value: unknown }[] = [{ path: "", value: root }];
  while (stack.length > 0 && matches.length < limit) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    inspectJsonSearchEntry(record, side, entry, term, limit, previewLength, matches, stack);
  }
  return matches.slice(0, limit);
}

function inspectJsonSearchEntry(
  record: StoredTraceEvent,
  side: TraceBodySide,
  entry: { readonly path: string; readonly value: unknown },
  term: string,
  limit: number,
  previewLength: number,
  matches: TraceSearchMatch[],
  stack: { readonly path: string; readonly value: unknown }[],
): void {
  if (typeof entry.value === "object" && entry.value !== null) {
    pushJsonChildren(record, side, entry, term, limit, previewLength, matches, stack);
    return;
  }
  const text = jsonScalarSearchText(entry.value);
  if (text.toLowerCase().includes(term)) {
    matches.push(toSearchMatch(record, side, entry.path, text.slice(0, previewLength)));
  }
}

function pushJsonChildren(
  record: StoredTraceEvent,
  side: TraceBodySide,
  entry: { readonly path: string; readonly value: unknown },
  term: string,
  limit: number,
  previewLength: number,
  matches: TraceSearchMatch[],
  stack: { readonly path: string; readonly value: unknown }[],
): void {
  if (!Array.isArray(entry.value) && !isRecord(entry.value)) {
    return;
  }
  const entries = Array.isArray(entry.value)
    ? entry.value.map((item, index) => [String(index), item] as const)
    : Object.entries(entry.value);
  for (const [key, value] of entries.reverse()) {
    if (matches.length >= limit) {
      return;
    }
    const path = `${entry.path}/${escapePointerToken(key)}`;
    if (key.toLowerCase().includes(term)) {
      matches.push(toSearchMatch(record, side, path, jsonValueText(value, previewLength)));
    }
    stack.push({ path, value });
  }
}

function toSearchMatch(
  record: StoredTraceEvent,
  side: TraceBodySide,
  path: string,
  preview: string,
  offset?: number,
): TraceSearchMatch {
  return {
    sessionId: record.sessionId,
    requestId: record.requestId,
    timestamp: record.event.timestamp,
    method: record.event.method,
    normalizedUrl: record.event.normalizedUrl,
    status: record.event.status,
    body: side,
    path,
    ...(offset === undefined ? {} : { offset }),
    preview,
  };
}

function selectedSides(body: TraceSearchBodySide): readonly TraceBodySide[] {
  return body === "both" ? ["request", "response"] : [body];
}

function bodyText(record: StoredTraceEvent, body: TraceBodySide): string {
  return body === "request" ? record.event.requestBodyPreview : record.event.responseBodyPreview;
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("Saved trace body does not contain valid JSON", { cause: error });
  }
}

function tryParseJson(body: string): ParsedJson | undefined {
  try {
    return { value: JSON.parse(body) as unknown };
  } catch {
    return undefined;
  }
}

function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error("Invalid JSON Pointer escape");
  }
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerTokens(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error("JSON Pointer must be empty or start with /");
  }
  return pointer.slice(1).split("/").map(decodePointerToken);
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const token of pointerTokens(pointer)) {
    current = resolvePointerToken(current, token, pointer);
  }
  return current;
}

function resolvePointerToken(current: unknown, token: string, pointer: string): unknown {
  if (Array.isArray(current)) {
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
      throw new Error(`JSON Pointer path "${pointer}" not found`);
    }
    return current[index];
  }
  if (isRecord(current) && Object.hasOwn(current, token)) {
    return current[token];
  }
  throw new Error(`JSON Pointer path "${pointer}" not found`);
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function inspectionRow(path: string, value: unknown, limit: number): TraceBodyInspectionRow {
  return { path, type: jsonType(value), value: jsonValueText(value, limit) };
}

function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function jsonValueText(value: unknown, limit: number): string {
  if (Array.isArray(value)) {
    return `items=${String(value.length)}`;
  }
  if (typeof value === "object" && value !== null) {
    return `keys=${String(Object.keys(value).length)}`;
  }
  if (typeof value === "string") {
    return value.slice(0, limit);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function jsonScalarSearchText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
