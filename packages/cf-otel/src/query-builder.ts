import { CfOtelError } from "./errors.js";
import type { AttrFilter, SpanFilterOptions } from "./types.js";

const UNIT_MILLIS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type DurationUnit = keyof typeof UNIT_MILLIS;
const DURATION_UNITS = Object.keys(UNIT_MILLIS) as readonly DurationUnit[];

/**
 * The `strict_date_optional_time` shape OpenSearch accepts for `startTime`
 * (mapped as `date_nanos`): a calendar date, optionally followed by a time
 * with optional seconds, fractional seconds of any width, and an optional `Z`
 * or `±HH:MM` offset.
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const TIME_BOUND_GRAMMAR =
  'a relative duration ("24h", "30m", "7d" — units s, m, h, d) or an absolute ' +
  'ISO-8601 timestamp ("2026-08-28T03:00:00Z")';

/** Name the offending flag when the caller knows it, so the message is actionable from the terminal alone. */
function flagLabel(flag: string | undefined): string {
  return flag ?? "time bound";
}

/**
 * The index's `startTime` format is `strict_date_optional_time||epoch_millis`,
 * so a bare number used to reach OpenSearch and work — not as a feature, but
 * because nothing validated the value. It stays rejected: `--since 24` reads
 * just as easily as a `24h` typed without its unit, and as an epoch-millis
 * `gte` it would silently match the entire index instead of the last day.
 * The two readings are decades apart, so the message names both rather than
 * picking one.
 */
function invalidBoundMessage(value: string, flag: string | undefined): string {
  const base = `${flagLabel(flag)} "${value}" is not a valid time bound; expected ${TIME_BOUND_GRAMMAR}`;
  if (!/^\d+$/.test(value)) {
    return base;
  }
  return (
    `${base}. A bare number is ambiguous here: add a unit for a relative duration ` +
    `("${value}h"), or write the instant as ISO-8601 if you meant epoch milliseconds`
  );
}

interface RelativeDuration {
  readonly amount: number;
  readonly unitMillis: number;
}

/**
 * Match `<digits><unit>` by suffix rather than with a capturing regex: reading
 * capture groups back out under `noUncheckedIndexedAccess` forces an
 * `?? fallback` on each one that can never actually be taken, which is both
 * dead code and a permanent hole in branch coverage.
 */
function parseRelativeDuration(text: string): RelativeDuration | undefined {
  for (const unit of DURATION_UNITS) {
    if (!text.endsWith(unit)) {
      continue;
    }
    const digits = text.slice(0, -unit.length);
    if (!/^\d+$/.test(digits)) {
      continue;
    }
    return { amount: Number(digits), unitMillis: UNIT_MILLIS[unit] };
  }
  return undefined;
}

/** Proleptic Gregorian leap year — the calendar both `Date`'s ISO arithmetic and Java's `java.time` (so OpenSearch) use. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days in a 1-based month. The length is probed against a fixed leap year and
 * then corrected for February, rather than passing the caller's year to
 * `Date.UTC`: that function maps a year below 100 into 1900-1999, so year 0
 * (a leap year) would come back with a 28-day February and the real date
 * `0000-02-29` would be rejected as impossible.
 */
function daysInMonth(year: number, month: number): number {
  const probed = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  return month === 2 && !isLeapYear(year) ? 28 : probed;
}

/**
 * `Date.parse` already rejects a month above 12, a day of `00` or above 31, an
 * hour above 24, and a minute or second of 60. What it does *not* reject is an
 * out-of-range day-of-month: it silently rolls `2026-02-30` over to March 2
 * and `2026-04-31` to May 1. OpenSearch's `strict_date_optional_time` rejects
 * all three, so forwarding one would turn a plain typo into an HTTP 400 dump
 * instead of a readable message — hence the explicit days-in-month check.
 */
function assertAbsoluteTimestamp(value: string, flag: string | undefined): void {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CfOtelError("CONFIG", invalidBoundMessage(value, flag));
  }
  // Read the date parts by fixed offset rather than from capture groups: the
  // pattern above has already pinned these positions as digits, so slicing
  // needs no unreachable `?? fallback` to satisfy `noUncheckedIndexedAccess`.
  const yearText = value.slice(0, 4);
  const monthText = value.slice(5, 7);
  const maxDay = daysInMonth(Number(yearText), Number(monthText));
  if (Number(value.slice(8, 10)) > maxDay) {
    // Echo the year and month exactly as typed: formatting them back from
    // numbers would print `0000` as `0`.
    throw new CfOtelError(
      "CONFIG",
      `${flagLabel(flag)} "${value}" is not a real calendar date: month ${monthText} of ${yearText} has ${String(maxDay)} days`,
    );
  }
}

/**
 * Resolve `--since`/`--until` as either a relative duration ("24h") or an
 * absolute ISO-8601 timestamp, rejecting anything else.
 *
 * A valid absolute value is returned **verbatim**, never round-tripped through
 * `Date`: `startTime` is a `date_nanos` field, so normalizing
 * `2026-08-28T03:05:46.542228853Z` would silently truncate it to milliseconds.
 *
 * `flag` is optional so the existing two-argument signature keeps working; pass
 * it to get the flag named in the error message.
 */
export function resolveTimeBound(value: string, now: Date = new Date(), flag?: string): string {
  const trimmed = value.trim();
  const relative = parseRelativeDuration(trimmed);
  if (relative === undefined) {
    assertAbsoluteTimestamp(trimmed, flag);
    return trimmed;
  }
  const resolved = new Date(now.getTime() - relative.amount * relative.unitMillis);
  // Reject on whether the result is a usable date at all, rather than by
  // checking arithmetic bounds: one test covers a huge amount, a product that
  // overflowed to Infinity, and any result outside the ±8.64e15 ms range a
  // Date can hold. Without it, `.toISOString()` throws a bare `RangeError:
  // Invalid time value` that the CLI surfaces with no mention of which flag
  // produced it.
  if (Number.isNaN(resolved.getTime())) {
    throw new CfOtelError(
      "CONFIG",
      `${flagLabel(flag)} "${trimmed}" is too far in the past for a valid date; use a smaller relative duration`,
    );
  }
  return resolved.toISOString();
}

/**
 * A swapped range matches nothing, which on a read-only tool is
 * indistinguishable from "this query genuinely found no spans" — the one
 * outcome worth failing loudly on instead of reporting as an empty result.
 *
 * Compared with `Date.parse` on bounds that are already validated. A bound
 * written without a timezone offset is read as local time here but as UTC by
 * OpenSearch, so this comparison can skew by the machine's offset for that one
 * form; that is accepted, because rejecting offset-less input would also reject
 * the useful date-only form.
 */
function assertOrderedRange(since: string, until: string): void {
  if (Date.parse(since) > Date.parse(until)) {
    throw new CfOtelError(
      "CONFIG",
      `--since resolved to ${since}, which is after --until (${until}); the range would match nothing`,
    );
  }
}

function numericAttrValue(attr: AttrFilter): number {
  const parsed = Number(attr.value);
  if (Number.isNaN(parsed)) {
    throw new CfOtelError(
      "CONFIG",
      `--attr value "${attr.value}" is not numeric, but "${attr.operator}" is a numeric comparison`,
    );
  }
  return parsed;
}

function buildAttrClause(attr: AttrFilter): Record<string, unknown> {
  switch (attr.operator) {
    case ">=":
      return { range: { [attr.key]: { gte: numericAttrValue(attr) } } };
    case "<=":
      return { range: { [attr.key]: { lte: numericAttrValue(attr) } } };
    case ">":
      return { range: { [attr.key]: { gt: numericAttrValue(attr) } } };
    case "<":
      return { range: { [attr.key]: { lt: numericAttrValue(attr) } } };
    case "=":
      return { term: { [attr.key]: attr.value } };
    case "~":
      return { wildcard: { [attr.key]: { value: `*${attr.value}*` } } };
  }
}

function buildStartTimeRange(opts: SpanFilterOptions, now: Date): Record<string, string> {
  const range: Record<string, string> = {};
  const since = opts.since === undefined ? undefined : resolveTimeBound(opts.since, now, "--since");
  const until = opts.until === undefined ? undefined : resolveTimeBound(opts.until, now, "--until");
  if (since !== undefined) {
    range["gte"] = since;
  }
  if (until !== undefined) {
    range["lte"] = until;
  }
  if (since !== undefined && until !== undefined) {
    assertOrderedRange(since, until);
  }
  return range;
}

/**
 * Validate `--since`/`--until` without building a query.
 *
 * Every command assembles its `bool` filter *inside* `withOpenSearchClient`,
 * which means a malformed bound is only noticed after a CF login and full
 * credential discovery have already run — around 20 seconds against a real
 * tenant. Calling this alongside the other argument checks makes a bad bound
 * fail in milliseconds instead of charging that cost first.
 *
 * It runs the real range builder and throws its result away rather than
 * repeating the rules, so the early check can never drift from the one that
 * actually shapes the query.
 */
export function assertTimeBoundsValid(
  opts: Pick<SpanFilterOptions, "since" | "until">,
  now: Date = new Date(),
): void {
  buildStartTimeRange(opts, now);
}

/** Build the shared `bool` filter query every span-filtering command uses. */
export function buildSpanBoolQuery(opts: SpanFilterOptions, now: Date = new Date()): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [];
  if (opts.service !== undefined) {
    filter.push({ term: { serviceName: opts.service } });
  }
  if (opts.namePattern !== undefined) {
    filter.push({ wildcard: { name: { value: opts.namePattern } } });
  }
  if (opts.since !== undefined || opts.until !== undefined) {
    filter.push({ range: { startTime: buildStartTimeRange(opts, now) } });
  }
  if (opts.traceIds !== undefined && opts.traceIds.length > 0) {
    filter.push({ terms: { traceId: opts.traceIds } });
  }
  if (opts.errorsOnly === true) {
    filter.push({ term: { "status.code": 2 } });
  }
  for (const attr of opts.attrs ?? []) {
    filter.push(buildAttrClause(attr));
  }
  return filter.length === 0 ? { match_all: {} } : { bool: { filter } };
}
