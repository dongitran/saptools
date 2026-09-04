import type {
  CompactLogDocument,
  CompactLogDocumentInput,
  CompactLogOptions,
  CompactLogRow,
  CompactLogRowRef,
  CompactLogSummary,
  ParsedLogRow,
} from "./types.js";

export const DEFAULT_COMPACT_MESSAGE_LIMIT = 500;

export function compactLogRows(
  rows: readonly ParsedLogRow[],
  options: CompactLogOptions = {},
): readonly CompactLogRow[] {
  const messageLimit = resolveMessageLimit(options.messageLimit);
  const refs = buildRefMap(options.refs);
  return rows.map((row) => compactLogRow(row, messageLimit, refs.get(row.id)));
}

export function buildCompactLogDocument(
  input: CompactLogDocumentInput,
  options: CompactLogOptions = {},
): CompactLogDocument {
  const refs = input.refs ?? options.refs;
  return {
    ...(input.appName === undefined ? {} : { appName: input.appName }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    truncated: input.truncated ?? false,
    rowCount: input.rows.length,
    summary: buildCompactSummary(input.rows),
    rows: compactLogRows(input.rows, {
      ...(options.messageLimit === undefined ? {} : { messageLimit: options.messageLimit }),
      ...(refs === undefined ? {} : { refs }),
    }),
  };
}

export function formatCompactLogDocument(document: CompactLogDocument): string {
  const header = [
    `summary rows=${document.rowCount.toString()}`,
    `truncated=${String(document.truncated)}`,
    `levels=${formatCounts(document.summary.levels)}`,
    `sources=${formatCounts(document.summary.sources)}`,
  ];
  if (document.summary.firstTimestamp.length > 0) {
    header.push(`from=${document.summary.firstTimestamp}`);
  }
  if (document.summary.lastTimestamp.length > 0) {
    header.push(`to=${document.summary.lastTimestamp}`);
  }
  const rows = formatCompactRows(document.rows);
  return rows.length === 0 ? header.join(" ") : `${header.join(" ")}\n${rows}`;
}

export function formatCompactRows(rows: readonly CompactLogRow[]): string {
  return rows.map(formatCompactRow).join("\n");
}

function compactLogRow(row: ParsedLogRow, messageLimit: number, ref?: string): CompactLogRow {
  const source = sourceFamily(row.source);
  // Unchanged from 0.7.0, deliberately. Routing this through the new typed
  // fields looked tidier but changed the slot's meaning twice over: it let
  // `x_vcap_request_id` — a key the old chain never consulted — outrank
  // `request_id` and `reqID`, and it made the projection depend on the parser
  // having filled those fields, so a row rehydrated from a stored session (or
  // built by any other caller) silently lost an id that is still sitting in
  // its own `jsonPayload`. Reading the payload here keeps `compactLogRows`
  // self-sufficient for any row shape. The hop id gets its own key below
  // rather than competing for this one.
  const requestId = row.requestId || readJsonRequestId(row);
  const vcapRequestId = readVcapRequestId(row);
  return {
    id: row.id,
    time: row.timestamp,
    level: row.level,
    source,
    ...(row.stream === "ERR" ? { stream: row.stream } : {}),
    ...(row.logger.length === 0 ? {} : { logger: row.logger }),
    ...compactBodyFields(row, messageLimit),
    ...(row.status.length === 0 ? {} : { status: row.status }),
    ...(row.latency.length === 0 ? {} : { latency: row.latency }),
    ...(row.tenant.length === 0 ? {} : { tenant: row.tenant }),
    ...(row.clientIp.length === 0 ? {} : { clientIp: row.clientIp }),
    ...(requestId.length === 0 ? {} : { requestId }),
    // Always emitted when present, even when it duplicates `requestId`.
    // Suppressing the duplicate saved ~40 characters but made two different
    // rows print identically: `requestId=<x>` alone means a correlation id on
    // one row and a hop id on the next, with nothing to tell them apart. Since
    // this is the documented key to join a log row to a trace, a reader has to
    // be able to find it without inferring which identifier landed in the
    // shared slot.
    ...(vcapRequestId.length === 0 ? {} : { vcapRequestId }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function compactBodyFields(
  row: ParsedLogRow,
  messageLimit: number,
): Pick<CompactLogRow, "message" | "request"> {
  if (row.method.length > 0 && row.request.length > 0) {
    return { request: trimText(row.request, messageLimit) };
  }
  if (row.message.length === 0) {
    return {};
  }
  return { message: trimText(row.message, messageLimit) };
}

function buildCompactSummary(rows: readonly ParsedLogRow[]): CompactLogSummary {
  return {
    firstTimestamp: rows[0]?.timestampRaw ?? "",
    lastTimestamp: rows.at(-1)?.timestampRaw ?? "",
    levels: countBy(rows, (row) => row.level),
    sources: countBy(rows, (row) => sourceFamily(row.source)),
    formats: countBy(rows, (row) => row.format),
  };
}

function formatCompactRow(row: CompactLogRow): string {
  const tokens = [`#${row.id.toString()}`, row.time, row.level, row.source];
  appendToken(tokens, "ref", row.ref);
  appendToken(tokens, "stream", row.stream);
  appendToken(tokens, "logger", row.logger);
  appendToken(tokens, "request", row.request);
  appendToken(tokens, "status", row.status);
  appendToken(tokens, "latency", row.latency);
  appendToken(tokens, "tenant", row.tenant);
  appendToken(tokens, "clientIp", row.clientIp);
  appendToken(tokens, "requestId", row.requestId);
  appendToken(tokens, "vcapRequestId", row.vcapRequestId);
  appendToken(tokens, "message", row.message);
  return tokens.join(" ");
}

function appendToken(tokens: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    return;
  }
  tokens.push(`${key}=${escapeInline(value)}`);
}

/** The 0.7.0 key chain, preserved verbatim so this slot's value can never shift. */
function readJsonRequestId(row: ParsedLogRow): string {
  const payload = row.jsonPayload;
  if (payload === null) {
    return "";
  }
  return (
    readString(payload["correlation_id"]) ||
    readString(payload["x_correlation_id"]) ||
    readString(payload["x_correlationid"]) ||
    readString(payload["request_id"]) ||
    readString(payload["reqID"])
  );
}

/**
 * Prefer the typed field, then fall back to the payload, for the same reason
 * {@link readJsonRequestId} reads the payload at all: a row that reached here
 * without going through the current parser — rehydrated from a stored session,
 * or constructed by a caller — still carries the id in `jsonPayload`.
 *
 * The field is read through a `Partial` view because such a row genuinely may
 * not have it, whatever the declared type says.
 */
function readVcapRequestId(row: ParsedLogRow): string {
  const stored: Partial<ParsedLogRow> = row;
  if (typeof stored.vcapRequestId === "string" && stored.vcapRequestId.length > 0) {
    return stored.vcapRequestId;
  }
  const payload = row.jsonPayload;
  if (payload === null) {
    return "";
  }
  return readString(payload["x_vcap_request_id"]) || readString(payload["request_id"]);
}

function countBy(
  rows: readonly ParsedLogRow[],
  readKey: (row: ParsedLogRow) => string,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = readKey(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildRefMap(refs: readonly CompactLogRowRef[] | undefined): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const item of refs ?? []) {
    map.set(item.rowId, item.ref);
  }
  return map;
}

function sourceFamily(source: string): string {
  const family = source.split("/")[0]?.trim() ?? "";
  return family.length === 0 ? "source" : family;
}

function trimText(value: string, limit: number): string {
  const normalized = escapeInline(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function escapeInline(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.toString()}`)
    .join(",");
}

function resolveMessageLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_COMPACT_MESSAGE_LIMIT;
}

function readString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}
