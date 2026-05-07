import type { FilterRowsOptions, ParseLogsOptions, ParsedLogRow } from "./types.js";

export const DEFAULT_LOG_LIMIT = 300;
const MAX_PARSED_LOG_ROWS = 5_000;
const MAX_RAW_LOG_TEXT_CHARS = 1_000_000;
const MIN_RAW_LOG_TEXT_CHARS = 120_000;
const RAW_LOG_TEXT_CHARS_PER_LIMIT_ROW = 1_200;
const MAX_REQUEST_SUMMARY_CHARS = 120;
const CF_LINE_PATTERN =
  /^\s*(?<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[(?<source>[^\]]+)]\s+(?<stream>OUT|ERR)\s?(?<body>.*)$/;
const CF_CLI_SYSTEM_MESSAGE_PREFIXES = [
  "Retrieving logs for app",
  "Failed to retrieve logs from Log Cache:",
  "Failed to retrieve recent logs from Log Cache:",
  "Server error, status code:",
];
const RTR_REQUEST_PATTERN =
  /"(?<method>[A-Z]+)\s+(?<target>\S+)\s+HTTP\/[\d.]+"\s+(?<status>\d{3}|-)/;
const RTR_HOST_PATTERN = /^(?<host>[^ ]+)\s+-\s+\[/;
const RTR_RESPONSE_TIME_PATTERN = /\bresponse_time:(?<responseTime>-|\d+(?:\.\d+)?)(?=\s|$|,)/;
const RTR_TENANT_ID_PATTERN = /\btenantid:"(?<tenantId>[^"]*)"/;
const RTR_CORRELATION_ID_PATTERN = /\bx_correlationid:"(?<correlationId>[^"]*)"/;
const RTR_VCAP_REQUEST_ID_PATTERN = /\bvcap_request_id:"(?<vcapRequestId>[^"]*)"/;
const RTR_TRUE_CLIENT_IP_PATTERN = /\bx_cf_true_client_ip:"(?<clientIp>[^"]*)"/;
const RTR_LEGACY_TRUE_CLIENT_IP_PATTERN = /\btrue_client_ip:"(?<clientIp>[^"]*)"/;
const RTR_X_FORWARDED_FOR_PATTERN = /\bx_forwarded_for:"(?<forwardedFor>[^"]*)"/;

export function parseRecentLogs(
  rawText: string,
  options: ParseLogsOptions = {},
): readonly ParsedLogRow[] {
  return appendParsedLines([], rawText.split(/\r?\n/), options);
}

export function appendParsedLines(
  existingRows: readonly ParsedLogRow[],
  lines: readonly string[],
  options: ParseLogsOptions = {},
): readonly ParsedLogRow[] {
  const rows: ParsedLogRow[] = [...existingRows];
  let nextId = resolveNextRowId(rows);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || isCfCliSystemMessage(trimmedLine)) {
      continue;
    }

    const parsedRow = safeParseCfLine(trimmedLine, nextId);
    if (parsedRow !== undefined) {
      rows.push(parsedRow);
      nextId += 1;
      continue;
    }

    const previous = rows[rows.length - 1];
    if (previous === undefined) {
      rows.push(buildTextRow({ id: nextId, timestamp: "N/A", source: "SYSTEM", stream: "OUT", body: trimmedLine }));
      nextId += 1;
    } else {
      rows[rows.length - 1] = appendContinuationLine(previous, trimmedLine);
    }
  }

  return trimRowsForMemory(rows, resolveLogLimit(options));
}

export function appendRawLogText(
  existingText: string,
  appendedText: string,
  options: ParseLogsOptions = {},
): string {
  const merged = existingText.length > 0 ? `${existingText}\n${appendedText}` : appendedText;
  const charCap = resolveRawLogTextCharCap(resolveLogLimit(options));

  return merged.length <= charCap ? merged : merged.slice(merged.length - charCap);
}

export function filterRows(
  rows: readonly ParsedLogRow[],
  options: FilterRowsOptions = {},
): readonly ParsedLogRow[] {
  const level = options.level ?? "all";
  const searchTerm = (options.searchTerm ?? "").trim().toLowerCase();
  const newestFirst = options.newestFirst ?? true;
  const matching = rows.filter((row) => {
    if (level !== "all" && row.level !== level) {
      return false;
    }
    return searchTerm.length === 0 || row.searchableText.includes(searchTerm);
  });

  return newestFirst ? matching.slice().reverse() : matching;
}

function resolveLogLimit(options: ParseLogsOptions): number {
  const candidate = options.logLimit ?? DEFAULT_LOG_LIMIT;
  return Number.isInteger(candidate) && candidate > 0 ? candidate : DEFAULT_LOG_LIMIT;
}

function resolveNextRowId(rows: readonly ParsedLogRow[]): number {
  return (rows.at(-1)?.id ?? 0) + 1;
}

function isCfCliSystemMessage(line: string): boolean {
  return CF_CLI_SYSTEM_MESSAGE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function execPattern(pattern: RegExp, value: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(value);
}

function readNamedGroup(match: RegExpExecArray | null, key: string): string {
  return match?.groups?.[key] ?? "";
}

function safeParseCfLine(line: string, id: number): ParsedLogRow | undefined {
  try {
    return parseCfLine(line, id);
  } catch {
    return undefined;
  }
}

function appendContinuationLine(row: ParsedLogRow, line: string): ParsedLogRow {
  const nextMessage = `${row.message}\n${line}`;
  const nextRawBody = `${row.rawBody}\n${line}`;
  const request = row.request === row.message ? nextMessage : row.request;
  const level = normalizeLevel(resolveCandidateLevel(row), row.stream, nextMessage, row.source, row.status);
  const nextRow = { ...row, message: nextMessage, rawBody: nextRawBody, request, level };
  return { ...nextRow, searchableText: buildSearchableText(nextRow) };
}

function parseCfLine(line: string, id: number): ParsedLogRow | undefined {
  const match = execPattern(CF_LINE_PATTERN, line);
  if (match?.groups === undefined) {
    return undefined;
  }

  const timestamp = readNamedGroup(match, "timestamp");
  const source = readNamedGroup(match, "source");
  const stream = readNamedGroup(match, "stream") === "ERR" ? "ERR" : "OUT";
  const body = readNamedGroup(match, "body").trim();
  const payload = parseJsonBody(body);

  return payload === undefined
    ? buildTextRow({ id, timestamp, source, stream, body })
    : buildJsonRow({ id, timestamp, source, stream, body, payload });
}

function parseJsonBody(body: string): Record<string, unknown> | undefined {
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return undefined;
  }

  const parsed = JSON.parse(body) as unknown;
  return isObjectRecord(parsed) ? parsed : undefined;
}

function buildTextRow(input: {
  readonly id: number;
  readonly timestamp: string;
  readonly source: string;
  readonly stream: "OUT" | "ERR";
  readonly body: string;
}): ParsedLogRow {
  const message = input.body.length > 0 ? input.body : "(empty)";
  const routerInfo = extractRouterAccessInfo(input.source, message);
  const row = {
    id: input.id,
    timestamp: formatTimestampToClock(input.timestamp),
    timestampRaw: input.timestamp,
    source: input.source,
    stream: input.stream,
    format: "text" as const,
    level: normalizeLevel("", input.stream, message, input.source, routerInfo?.statusCode ?? ""),
    logger: deriveLoggerFromSource(input.source),
    component: "",
    org: "",
    space: "",
    host: routerInfo?.host ?? deriveLoggerFromSource(input.source),
    method: routerInfo?.method ?? "",
    request: routerInfo?.request ?? message,
    status: routerInfo?.statusCode ?? "",
    latency: routerInfo?.latency ?? "",
    tenant: routerInfo?.tenantId ?? "",
    clientIp: routerInfo?.clientIp ?? "",
    requestId: routerInfo?.requestId ?? "",
    message,
    rawBody: input.body,
    jsonPayload: null,
    searchableText: "",
  };

  return { ...row, searchableText: buildSearchableText(row) };
}

function buildJsonRow(input: {
  readonly id: number;
  readonly timestamp: string;
  readonly source: string;
  readonly stream: "OUT" | "ERR";
  readonly body: string;
  readonly payload: Record<string, unknown>;
}): ParsedLogRow {
  const message = readString(input.payload["msg"]) || input.body;
  const row = {
    id: input.id,
    timestamp: formatTimestampToClock(input.timestamp),
    timestampRaw: input.timestamp,
    source: input.source,
    stream: input.stream,
    format: "json" as const,
    level: normalizeLevel(readString(input.payload["level"]), input.stream, message, input.source),
    logger: readString(input.payload["logger"]) || deriveLoggerFromSource(input.source),
    component: readString(input.payload["component_name"]),
    org: readString(input.payload["organization_name"]),
    space: readString(input.payload["space_name"]),
    host: deriveLoggerFromSource(input.source),
    method: "",
    request: message,
    status: "",
    latency: "",
    tenant: "",
    clientIp: "",
    requestId: "",
    message,
    rawBody: input.body,
    jsonPayload: input.payload,
    searchableText: "",
  };

  return { ...row, searchableText: buildSearchableText(row) };
}

function resolveCandidateLevel(row: ParsedLogRow): string {
  return isObjectRecord(row.jsonPayload) ? readString(row.jsonPayload["level"]) : "";
}

function deriveLoggerFromSource(source: string): string {
  const first = source.split("/")[0] ?? "";
  return first.length > 0 ? first.toLowerCase() : "source";
}

function normalizeLevel(
  candidateLevel: string,
  stream: "OUT" | "ERR",
  message: string,
  source: string,
  routerStatusCode = "",
): ParsedLogRow["level"] {
  const normalized = candidateLevel.trim().toLowerCase();
  if (normalized === "warning") {
    return "warn";
  }
  if (isKnownLevel(normalized)) {
    return normalized;
  }
  if (/^rtr\b/i.test(source)) {
    return classifyRtrLog(message, routerStatusCode);
  }
  if (/\bfatal\b/i.test(message)) {
    return "fatal";
  }
  if (/\b(?:error|exception|failed)\b/i.test(message)) {
    return "error";
  }
  if (/\bwarn(?:ing)?\b/i.test(message)) {
    return "warn";
  }
  return stream === "ERR" ? "error" : "info";
}

function isKnownLevel(value: string): value is ParsedLogRow["level"] {
  return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error" || value === "fatal";
}

function classifyRtrLog(message: string, statusCodeCandidate = ""): ParsedLogRow["level"] {
  const statusCode = resolveStatusCode(statusCodeCandidate, message);
  if (statusCode === undefined) {
    return "info";
  }
  if (statusCode >= 500) {
    return "error";
  }
  return statusCode >= 400 ? "warn" : "info";
}

function resolveStatusCode(statusCodeCandidate: string, message: string): number | undefined {
  if (/^\d{3}$/.test(statusCodeCandidate)) {
    return Number.parseInt(statusCodeCandidate, 10);
  }
  const status = readNamedGroup(execPattern(RTR_REQUEST_PATTERN, message), "status");
  return /^\d{3}$/.test(status) ? Number.parseInt(status, 10) : undefined;
}

function extractRouterAccessInfo(source: string, message: string): {
  readonly host: string;
  readonly method: string;
  readonly request: string;
  readonly statusCode: string;
  readonly latency: string;
  readonly tenantId: string;
  readonly clientIp: string;
  readonly requestId: string;
} | undefined {
  if (!/^rtr\b/i.test(source)) {
    return undefined;
  }
  const match = execPattern(RTR_REQUEST_PATTERN, message);
  const method = readNamedGroup(match, "method");
  const target = decodeRequestTarget(readNamedGroup(match, "target"));
  const statusMatch = readNamedGroup(match, "status");
  const statusCode = /^\d{3}$/.test(statusMatch) ? statusMatch : "";

  return {
    host: normalizeMetadataValue(readNamedGroup(execPattern(RTR_HOST_PATTERN, message), "host")),
    method,
    request: buildRequestSummary(method, target),
    statusCode,
    latency: formatLatency(readNamedGroup(execPattern(RTR_RESPONSE_TIME_PATTERN, message), "responseTime")),
    tenantId: normalizeMetadataValue(readNamedGroup(execPattern(RTR_TENANT_ID_PATTERN, message), "tenantId")),
    clientIp: resolveClientIp(message),
    requestId: resolveRequestId(message),
  };
}

function buildRequestSummary(method: string, target: string): string {
  if (method.length === 0 || target.length === 0) {
    return "";
  }
  const request = `${method} ${target}`;
  if (request.length <= MAX_REQUEST_SUMMARY_CHARS) {
    return request;
  }
  const budget = Math.max(16, MAX_REQUEST_SUMMARY_CHARS - method.length - 6);
  return `${method} ${target.slice(0, budget)}...`;
}

function decodeRequestTarget(target: string): string {
  if (target.length === 0) {
    return target;
  }
  const questionMark = target.indexOf("?");
  if (questionMark < 0) {
    return decodeUriComponentSafely(target);
  }
  const pathPart = target.slice(0, questionMark);
  const queryPart = target.slice(questionMark + 1);
  return `${decodeUriComponentSafely(pathPart)}?${decodeUriComponentSafely(queryPart)}`;
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveRequestId(message: string): string {
  const correlationId = normalizeMetadataValue(
    readNamedGroup(execPattern(RTR_CORRELATION_ID_PATTERN, message), "correlationId"),
  );
  if (correlationId.length > 0) {
    return correlationId;
  }
  return normalizeMetadataValue(
    readNamedGroup(execPattern(RTR_VCAP_REQUEST_ID_PATTERN, message), "vcapRequestId"),
  );
}

function resolveClientIp(message: string): string {
  const trueClient = normalizeMetadataValue(
    readNamedGroup(execPattern(RTR_TRUE_CLIENT_IP_PATTERN, message), "clientIp"),
  );
  if (trueClient.length > 0) {
    return trueClient;
  }
  const legacy = normalizeMetadataValue(
    readNamedGroup(execPattern(RTR_LEGACY_TRUE_CLIENT_IP_PATTERN, message), "clientIp"),
  );
  if (legacy.length > 0) {
    return legacy;
  }
  const forwarded = normalizeMetadataValue(
    readNamedGroup(execPattern(RTR_X_FORWARDED_FOR_PATTERN, message), "forwardedFor"),
  );
  return normalizeMetadataValue(forwarded.split(",")[0]?.trim() ?? "");
}

function formatLatency(responseTimeRaw: string): string {
  if (responseTimeRaw === "-" || responseTimeRaw.length === 0) {
    return "";
  }
  const seconds = Number.parseFloat(responseTimeRaw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  if (seconds < 1) {
    return `${trimTrailingZeros((seconds * 1000).toFixed(1))} ms`;
  }
  return `${trimTrailingZeros(seconds.toFixed(3))} s`;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function normalizeMetadataValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === "-" ? "" : trimmed;
}

function buildSearchableText(row: Omit<ParsedLogRow, "searchableText">): string {
  return [
    row.timestamp,
    row.timestampRaw,
    row.source,
    row.stream,
    row.format,
    row.level,
    row.logger,
    row.component,
    row.org,
    row.space,
    row.host,
    row.method,
    row.request,
    row.status,
    row.latency,
    row.tenant,
    row.clientIp,
    row.requestId,
    row.message,
  ].join(" ").toLowerCase();
}

function readString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTimestampToClock(timestamp: string): string {
  const trimmed = timestamp.trim();
  const withDate = execPattern(/T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})/, trimmed);
  if (withDate?.groups !== undefined) {
    return [
      readNamedGroup(withDate, "hour"),
      readNamedGroup(withDate, "minute"),
      readNamedGroup(withDate, "second"),
    ].join(":");
  }
  const clockOnly = execPattern(
    /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:[.,]\d+)?$/,
    trimmed,
  );
  return clockOnly?.groups === undefined
    ? trimmed
    : [
        readNamedGroup(clockOnly, "hour"),
        readNamedGroup(clockOnly, "minute"),
        readNamedGroup(clockOnly, "second"),
      ].join(":");
}

function trimRowsForMemory(rows: readonly ParsedLogRow[], logLimit: number): readonly ParsedLogRow[] {
  const maxRows = Math.min(logLimit, MAX_PARSED_LOG_ROWS);
  return rows.length <= maxRows ? rows : rows.slice(rows.length - maxRows);
}

function resolveRawLogTextCharCap(logLimit: number): number {
  const capByLimit = logLimit * RAW_LOG_TEXT_CHARS_PER_LIMIT_ROW;
  return Math.min(MAX_RAW_LOG_TEXT_CHARS, Math.max(MIN_RAW_LOG_TEXT_CHARS, capByLimit));
}
