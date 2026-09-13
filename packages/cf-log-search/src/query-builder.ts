import { DEFAULT_SINCE } from "./config.js";

export interface LogSearchFilters {
  readonly app?: string;
  readonly space?: string;
  readonly level?: string;
  readonly sourceType?: string;
  readonly since?: string;
  readonly until?: string;
  readonly query?: string;
  readonly vcapRequestId?: string;
  readonly correlationId?: string;
  readonly status?: number;
}

const DURATION_PATTERN = /^([1-9]\d*)(s|m|h|d)$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const ABSOLUTE_SHAPE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/**
 * `Date.parse` silently rolls an out-of-range day of month forward
 * (`2026-02-30` becomes March 2) while OpenSearch's `strict_date_optional_time`
 * format rejects it outright — verified against this exact index's `@timestamp`
 * mapping. An explicit days-in-month check is required; `Date.parse` alone
 * both over- and under-accepts. The value is returned verbatim (never
 * round-tripped through `new Date(...).toISOString()`), so a caller's
 * higher-precision fractional seconds are preserved exactly as typed.
 */
function resolveAbsoluteInstant(value: string, flagName: string): string {
  const match = ABSOLUTE_SHAPE_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${flagName} "${value}" is not a recognized relative duration (15m, 2h, 1d) or absolute ISO-8601 instant`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new Error(`${flagName} "${value}" has an invalid month`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${flagName} "${value}" has an invalid day for that month`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${flagName} "${value}" could not be parsed as a date`);
  }
  return value;
}

export function resolveTimeBound(value: string | undefined, flagName: string, now: Date): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const durationMatch = DURATION_PATTERN.exec(value.trim());
  if (durationMatch !== null) {
    const amount = Number(durationMatch[1]);
    const unitMs = DURATION_UNIT_MS[durationMatch[2] ?? "m"] ?? 60_000;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  return resolveAbsoluteInstant(value, flagName);
}

export interface TimeRange {
  readonly gte?: string;
  readonly lte?: string;
}

export function resolveTimeRange(sinceRaw: string | undefined, untilRaw: string | undefined, now: () => Date = () => new Date()): TimeRange | undefined {
  const nowValue = now();
  const since = resolveTimeBound(sinceRaw ?? DEFAULT_SINCE, "--since", nowValue);
  const until = resolveTimeBound(untilRaw, "--until", nowValue);
  if (since === undefined && until === undefined) {
    return undefined;
  }
  if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) {
    throw new Error(`--since (${since}) is later than --until (${until})`);
  }
  return { ...(since === undefined ? {} : { gte: since }), ...(until === undefined ? {} : { lte: until }) };
}

/**
 * Structured filters go under `bool.filter` (non-scoring, exact `.keyword`
 * sub-field matches — verified present with an `ignore_above: 256`
 * `.keyword` multi-field on `app_name`/`space_name`/`level`/`source_type`/
 * `correlation_id`/`vcap_request_id`/`msg` across all 52 backing-index
 * generations). Full-text search goes under `bool.must` as an analyzed
 * `match` against `msg` — the one field only APP-log documents carry.
 * `response_status` is a real mapped number on RTR documents, so it is
 * filtered as a numeric `term`, never a string.
 */
export function buildSearchQuery(filters: LogSearchFilters, now: () => Date = () => new Date()): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];
  const filter: Record<string, unknown>[] = [];

  const range = resolveTimeRange(filters.since, filters.until, now);
  if (range !== undefined) {
    filter.push({ range: { "@timestamp": range } });
  }
  if (filters.app !== undefined) {
    filter.push({ term: { "app_name.keyword": filters.app } });
  }
  if (filters.space !== undefined) {
    filter.push({ term: { "space_name.keyword": filters.space } });
  }
  if (filters.level !== undefined) {
    filter.push({ term: { "level.keyword": filters.level } });
  }
  if (filters.sourceType !== undefined) {
    filter.push({ term: { "source_type.keyword": filters.sourceType } });
  }
  if (filters.vcapRequestId !== undefined) {
    filter.push({ term: { "vcap_request_id.keyword": filters.vcapRequestId } });
  }
  if (filters.correlationId !== undefined) {
    filter.push({ term: { "correlation_id.keyword": filters.correlationId } });
  }
  if (filters.status !== undefined) {
    filter.push({ term: { response_status: filters.status } });
  }
  if (filters.query !== undefined && filters.query.trim().length > 0) {
    must.push({ match: { msg: filters.query } });
  }

  if (must.length === 0 && filter.length === 0) {
    return { match_all: {} };
  }
  return { bool: { ...(must.length > 0 ? { must } : {}), ...(filter.length > 0 ? { filter } : {}) } };
}
