import { CfOtelError } from "./errors.js";
import type { AttrFilter, SpanFilterOptions } from "./types.js";

const UNIT_MILLIS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type DurationUnit = keyof typeof UNIT_MILLIS;
const DURATION_UNITS = Object.keys(UNIT_MILLIS) as readonly DurationUnit[];

/**
 * The `strict_date_optional_time` shape OpenSearch accepts for `startTime`
 * (mapped as `date_nanos`): a calendar date, optionally followed by a time
 * with optional seconds, up to nine fractional digits, and an optional `Z` or
 * `±HH:MM` offset.
 *
 * Every boundary was measured against the live backend rather than inferred,
 * because a shape accepted here and rejected there costs the caller a full
 * credential-discovery round trip before failing:
 *
 * - **Hour 24** is legal end-of-day in ISO-8601 and `Date.parse` rolls it into
 *   the next day, but `java.time` resolves `HOUR_OF_DAY` strictly 0-23 and
 *   rejects it. `T24:00:00Z` used to be forwarded verbatim.
 * - **A tenth fractional digit** exceeds the nanosecond precision the mapping
 *   keeps; `.1234567890Z` was forwarded and rejected.
 * - **Offsets** are capped at ±18:00, `java.time`'s `ZoneOffset` limit:
 *   `+18:00` is accepted and `+18:01` upward is not. `+00:60` and `+2500` are
 *   refused too, though those never reached the backend — the `Date.parse`
 *   guard already caught them; the bound names the shape instead of blaming
 *   the whole value.
 *
 * `@saptools/cf-metrics` measured and applied the same three bounds; this is
 * the same pattern, so the two packages accept the same set.
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-7]):?[0-5]\d|18:?00))?)?$/;

/** A clock-time bound that names no zone — the shape `Date.parse` reads as local and OpenSearch reads as UTC. */
const ZONELESS_CLOCK_TIME = /T[\d:.]+$/;

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
 * The same instant OpenSearch will see, at the precision `startTime` actually
 * stores.
 *
 * Two corrections over a bare `Date.parse`:
 *
 * - **Zone.** `Date.parse` follows ECMA-262, where a date-time string with no
 *   zone designator is *local*, while `strict_date_optional_time` reads it as
 *   UTC. Comparing raw strings shifted the bounds by the operator's own offset,
 *   so the ordering check failed in both directions — refusing a genuinely
 *   forward window, and passing an inverted one that then returns nothing at
 *   exit 0, which is the outcome the check exists to remove. The skew was
 *   previously documented here as an accepted trade against rejecting the
 *   date-only form; normalizing costs nothing and gives up neither. A date-only
 *   value already parses as UTC and is left alone.
 * - **Precision.** `startTime` is `date_nanos` and `Date.parse` sees only
 *   milliseconds, so `.000000002Z` and `.000000001Z` compared equal and an
 *   inverted nanosecond range slipped through.
 */
function comparableInstant(bound: string): { readonly ms: number; readonly subMillis: number } {
  const ms = Date.parse(ZONELESS_CLOCK_TIME.test(bound) ? `${bound}Z` : bound);
  const fraction = /\.(\d+)/.exec(bound)?.[1] ?? "";
  return { ms, subMillis: Number(fraction.slice(3).padEnd(6, "0")) };
}

/**
 * A swapped range matches nothing, which on a read-only tool is
 * indistinguishable from "this query genuinely found no spans" — the one
 * outcome worth failing loudly on instead of reporting as an empty result.
 */
function assertOrderedRange(since: string, until: string): void {
  const start = comparableInstant(since);
  const end = comparableInstant(until);
  const inverted = start.ms > end.ms || (start.ms === end.ms && start.subMillis > end.subMillis);
  if (inverted) {
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

/**
 * Where the gorouter request id lands on a span. Captured at ingress, so it is
 * only ever present on `SPAN_KIND_SERVER` spans — the same value `@saptools/cf-logs`
 * reports as `ParsedLogRow.vcapRequestId`.
 */
export const VCAP_REQUEST_ID_FIELD = "span.attributes.http@request@header@x-vcap-request-id";

/**
 * An allowlist, not a denylist, and deliberately so. A type listed here parses
 * its terms as plain text, so an extra array-rendered candidate can only ever
 * add matches. Anything else — mapped, unmapped, or a type nobody here thought
 * of — falls back to a single plain `term`, which at worst misses the array
 * encoding. The inverse mistake is not symmetric: `["500"]` at an `integer`
 * field is not a miss, it is a `query_shard_exception` that takes the search
 * down with it.
 *
 * `token_count` is excluded on purpose despite the textual name — it indexes a
 * number.
 */
const TEXTUAL_MAPPING_TYPES: ReadonlySet<string> = new Set([
  "keyword",
  "text",
  "wildcard",
  "constant_keyword",
  "match_only_text",
  "version",
  "search_as_you_type",
  "annotated_text",
]);

/** A hex UUID in the shape Cloud Foundry emits, in either case. */
const HEX_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trim, and lower-case a hex request id.
 *
 * `keyword` matching is exact, and every one of 2,000 hop ids and 500
 * correlation ids sampled from a live index was lower-case dashed hex with no
 * exception — so an id pasted in upper case matched nothing and reported
 * `(no rows)` at exit 0, which is precisely the silent miss this command exists
 * to remove. Only a value that is already hex-shaped is folded: anything else
 * is passed through untouched rather than guessing that some other tenant's
 * identifier is case-insensitive.
 */
function normalizeRequestId(value: string): string {
  const trimmed = value.trim();
  return HEX_REQUEST_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * `=` has to match a value stored in either of two encodings.
 *
 * Confirmed against a real Cloud Logging instance: an OTel attribute whose
 * value is an array reaches the index as the JSON array *rendered to text*, so
 * the keyword token for an HTTP request header is literally
 * `["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]` — brackets and quotes included.
 * The whole `span.attributes.http@request@header@*` family is stored this way —
 * 46 such fields in the mapping, and every one observed carrying a real value
 * except the redacted `authorization`. A plain `term` on the bare value matched
 * none of them: `(no rows)` at exit 0, indistinguishable from "that value never
 * occurred". Over 60 real hop ids the bare term matched 0; both encodings
 * matched all 60, each to exactly one trace.
 *
 * Both encodings are offered rather than one being chosen, because nothing can
 * reliably choose. An array is a property of the document, never of the
 * mapping, and here the stored value is a *string* that merely looks like an
 * array — so `keyword` is all the mapping ever says. Sampling a document would
 * pick one shape at the moment `otel-v1-apm-span-*` can straddle an ingest
 * change across its 14 backing indices, and return a silently partial result.
 *
 * `JSON.stringify` produces the alternative, not string concatenation: the
 * stored form is JSON, so a value containing `"` or `\` must be escaped the
 * same way the ingest pipeline escaped it.
 *
 * A document matches a filter clause at most once, so the disjunction cannot
 * double-count in `count`.
 */
function equalityClause(attr: AttrFilter): Record<string, unknown> {
  if (attr.mappedType === undefined || !TEXTUAL_MAPPING_TYPES.has(attr.mappedType)) {
    return { term: { [attr.key]: attr.value } };
  }
  return { terms: { [attr.key]: [attr.value, JSON.stringify([attr.value])] } };
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
      return equalityClause(attr);
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
  if (opts.vcapRequestId !== undefined) {
    // Routed through `equalityClause` rather than repeating its two-encoding
    // logic: a second copy of the JSON escaping is a copy that can drift, and
    // this field is always one of the array-rendered ones.
    filter.push(
      equalityClause({
        key: VCAP_REQUEST_ID_FIELD,
        operator: "=",
        value: normalizeRequestId(opts.vcapRequestId),
        mappedType: "keyword",
      }),
    );
  }
  if (opts.errorsOnly === true) {
    filter.push({ term: { "status.code": 2 } });
  }
  for (const attr of opts.attrs ?? []) {
    filter.push(buildAttrClause(attr));
  }
  return filter.length === 0 ? { match_all: {} } : { bool: { filter } };
}
