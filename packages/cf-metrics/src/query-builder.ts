import { CfMetricsError } from "./errors.js";

const RELATIVE_DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_MILLIS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/**
 * Anchored to ISO-8601's date/date-time shape — the format --since/--until's absolute-timestamp
 * path documents. Deliberately narrower than JS's `Date.parse`, which leniently accepts non-ISO
 * formats (e.g. "8/31/2026", or "yesterday" on some engines) under implementation-defined,
 * often-local-timezone semantics that would silently query the wrong window instead of failing
 * loudly.
 *
 * Every boundary here was measured against a real Cloud Logging instance's
 * `strict_date_optional_time||epoch_millis` mapping rather than inferred, because both kinds of
 * mistake cost the user something: a shape this accepts but OpenSearch rejects becomes an HTTP 400
 * dump after a full login round trip, and a shape this rejects but OpenSearch accepts is a
 * capability silently taken away. Measured rejected, and therefore rejected here: a space instead
 * of `T`, hour 24 (legal end-of-day in ISO-8601, but `java.time` resolves `HOUR_OF_DAY` strictly
 * 0-23), minute or second 60, and a tenth fractional digit (the mapping caps nanosecond precision
 * at nine). Measured accepted, and allowed here: date-only values, `T03:00` with seconds omitted,
 * one to nine fractional digits, and offsets in `Z`, `+07:00`, `+0700` and `+14:00` forms.
 *
 * Three shapes the backend accepts are still rejected here, deliberately: hour-only (`2026-08-30T03`),
 * the same with a zone, and a comma as the fraction separator. `Date.parse` returns `NaN` for all
 * three, and `assertValidTimeRange` compares bounds through `Date.parse` — so accepting them would
 * not widen what works, it would silently switch off the inverted-window check for whoever used
 * them. A refusal naming the shape beats a check that quietly stops applying.
 */
const ABSOLUTE_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Proleptic Gregorian, the calendar both `Date` and OpenSearch's `java.time` formatter use. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Days in a 1-based month. February is answered from {@link isLeapYear} rather than by probing
 * `Date.UTC` with the caller's own year: `Date.UTC` maps a year below 100 into 1900-1999, which
 * would report 28 days for February of year 0 — a real leap year — and reject a valid date.
 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The instant a relative duration reaches back to, or `undefined` when the value
 * is not a relative duration at all. An out-of-range magnitude yields an
 * *invalid* Date rather than `undefined`: the multiplication itself stays finite
 * (`999999999999d` is ~8.6e19 ms, a perfectly good float), and only `Date`
 * refuses it — so the check has to look at the date, not the arithmetic. Shared
 * so the flag-level check and the resolver agree on what "resolvable" means.
 */
function resolveRelativeInstant(trimmed: string, now: Date): Date | undefined {
  const match = RELATIVE_DURATION_PATTERN.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unitMillis = UNIT_MILLIS[match[2] ?? ""] ?? 0;
  return new Date(now.getTime() - amount * unitMillis);
}

/** The message for a bound that is neither a relative duration nor an ISO-8601 timestamp. */
function invalidBoundMessage(flagName: string, value: string): string {
  const base = `Invalid ${flagName} value "${value}" (expected a relative duration like "24h"/"30m"/"2d", or an absolute ISO-8601 timestamp like "2026-08-30T03:00:00Z")`;
  // A bare number is the one ambiguous case worth naming: the backend would take
  // it as epoch millis (the mapping is `strict_date_optional_time||epoch_millis`,
  // measured), while in a CLI time flag it is far more often a duration that lost
  // its unit. Rejecting it is deliberate — but saying only "expected a duration"
  // leaves someone who really meant epoch millis with no idea why it was refused.
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return base;
  }
  // Which reading to suggest depends on the magnitude. Offering `20260830h` for
  // what is plainly a compact date reads as the tool not understanding the
  // question; eight digits is a date someone forgot to punctuate, two or three
  // is a duration that lost its unit.
  const looksLikeCompactDate = /^\d{8}$/.test(trimmed);
  return looksLikeCompactDate
    ? `${base}. "${trimmed}" looks like a date without its separators: write it as ${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}.`
    : `${base}. A bare number is ambiguous here: write "${trimmed}m"/"${trimmed}h" for a duration, or an ISO-8601 timestamp for an instant.`;
}

/** Resolve `--since`/`--until` as either a relative duration ("24h") or an absolute ISO-8601 timestamp. */
export function resolveTimeBound(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const resolved = resolveRelativeInstant(trimmed, now);
  if (resolved === undefined) {
    return trimmed;
  }
  // Guarded only on the relative branch. The absolute branch also carries
  // `watch`'s polling cursor — a raw document `time` value re-fed on every
  // iteration — so a check there would turn a shape this pattern happens not to
  // cover into a fatal crash of a long-running loop. A cursor is never a
  // relative duration, so this cannot reach one.
  if (Number.isNaN(resolved.getTime())) {
    throw new CfMetricsError(
      "CONFIG",
      `Relative duration "${trimmed}" reaches beyond the range of a real date; use a smaller one.`,
    );
  }
  return resolved.toISOString();
}

/**
 * Validate a `--since`/`--until` CLI flag's *shape* — relative duration or
 * absolute ISO-8601 — without resolving it, so a command can fail fast,
 * before any network call. Confirmed live: a value `resolveTimeBound` cannot
 * parse (e.g. "yesterday") was previously sent straight through to
 * OpenSearch's `range` query, which rejects it with a raw, truncated
 * `parse_exception` dump only after a full ~20s CF-login +
 * credential-discovery round trip.
 *
 * Deliberately kept separate from `resolveTimeBound` rather than added as
 * validation inside it: `resolveTimeBound` also resolves `watch`'s polling
 * cursor, which re-feeds a previously-fetched document's own `time` value
 * back in on every iteration — an already-valid, system-generated value that
 * has no flag name to report and does not need (or want) this check.
 */
export function assertValidTimeBoundShape(flagName: string, value: string): void {
  const trimmed = value.trim();
  if (RELATIVE_DURATION_PATTERN.test(trimmed)) {
    // A duration whose magnitude cannot land on a real date is a shape problem too,
    // and catching it here is what puts the flag name in the message: left to
    // `resolveTimeBound`, it surfaced as a bare "Invalid time value" RangeError
    // naming neither the flag nor the value — and for a command with no `--until`,
    // only after the full login round trip this check exists to precede.
    if (Number.isNaN(resolveRelativeInstant(trimmed, new Date())?.getTime() ?? Number.NaN)) {
      throw new CfMetricsError(
        "CONFIG",
        `Invalid ${flagName} value "${value}" — that duration reaches beyond the range of a real date; use a smaller one.`,
      );
    }
    return;
  }
  if (!ABSOLUTE_ISO_PATTERN.test(trimmed)) {
    throw new CfMetricsError("CONFIG", invalidBoundMessage(flagName, value));
  }
  // The calendar check runs *before* `Date.parse`, not after. `Date.parse`
  // rejects month 13 and day 00 by returning NaN, which would land them in the
  // generic "expected a duration or an ISO timestamp" message — a month typo
  // reported as a shape problem, when the shape is fine and the date is not.
  // It also does not reject a day past its own month's end at all: it rolls
  // "2026-02-30" forward to March 2 and reports success. Forwarding that costs
  // twice over — OpenSearch rejects it outright (measured), and until the query
  // gets there the rolled-forward instant is what `assertValidTimeRange`
  // compares, turning a typo into a confident "--since is later than --until"
  // aimed at the wrong flag.
  assertRealCalendarDate(flagName, value, trimmed);
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new CfMetricsError("CONFIG", invalidBoundMessage(flagName, value));
  }
}

/** Reject a month or day outside the calendar, naming which part is wrong. */
function assertRealCalendarDate(flagName: string, value: string, trimmed: string): void {
  const yearText = trimmed.slice(0, 4);
  const monthText = trimmed.slice(5, 7);
  const dayText = trimmed.slice(8, 10);
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12) {
    throw new CfMetricsError(
      "CONFIG",
      `Invalid ${flagName} value "${value}" — not a real calendar date: there is no month ${monthText}.`,
    );
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new CfMetricsError(
      "CONFIG",
      `Invalid ${flagName} value "${value}" — not a real calendar date: month ${monthText} of ${yearText} has ${String(maxDay)} days.`,
    );
  }
}

/**
 * Validate a command's `--since`/`--until` pair: each one's shape, and then
 * that the window actually runs forwards.
 *
 * An inverted window is not rejected by OpenSearch — `{gte: <later>, lte:
 * <earlier>}` is a legal query that simply matches nothing — so before this
 * check the command exited 0 with an empty table, indistinguishable from "no
 * data in this period".
 *
 * `defaultSince` matters as much as the flags. Commands that default `--since`
 * to a recent window can invert it *without the user writing anything
 * contradictory*: `--until 3h` on its own resolved to `{gte: now-2h, lte:
 * now-3h}` and silently returned nothing. That case gets its own message,
 * because blaming a value the user never typed is not much better than
 * silence. Pass `defaultSince` as `undefined` for commands (like `sample`)
 * that leave the start unbounded.
 */
export function assertValidTimeRange(
  opts: { readonly since?: string | undefined; readonly until?: string | undefined },
  defaultSince?: string,
  now: Date = new Date(),
): void {
  if (opts.since !== undefined) {
    assertValidTimeBoundShape("--since", opts.since);
  }
  if (opts.until !== undefined) {
    assertValidTimeBoundShape("--until", opts.until);
  }

  const effectiveSince = opts.since ?? defaultSince;
  if (effectiveSince === undefined || opts.until === undefined) {
    return;
  }
  const start = Date.parse(resolveTimeBound(effectiveSince, now));
  const end = Date.parse(resolveTimeBound(opts.until, now));
  // Unparseable values already threw above; skipping here keeps this function
  // from inventing a second, less specific error for the same input.
  if (Number.isNaN(start) || Number.isNaN(end) || start <= end) {
    return;
  }
  throw new CfMetricsError(
    "CONFIG",
    opts.since === undefined
      ? `--until "${opts.until}" is older than the default --since ("${effectiveSince}"), so the window would end before it starts and match nothing. ` +
        "Pass --since explicitly with a start older than --until."
      : `--since "${opts.since}" is later than --until "${opts.until}", so the window would end before it starts and match nothing. ` +
        "For a window in the past, --since must be the older of the two.",
  );
}

export interface MetricFilterOptions {
  readonly service?: string;
  readonly names?: readonly string[];
  /**
   * Restrict to one `unit` value. Needed because a metric name is not
   * guaranteed to identify a single series: Cloud Foundry publishes
   * `container.cpu.usage` as two, `unit="1"` (fraction of the app's CPU
   * entitlement) and `unit="cpu"` (fraction of one core), whose values differ
   * by roughly 17x. Aggregating without this filter averages the two into a
   * number with no physical meaning.
   */
  readonly unit?: string;
  readonly since?: string;
  readonly until?: string;
}

/**
 * Build the shared `bool` filter query every metrics command uses.
 *
 * `time` is filtered with a plain `range` clause (no `unmapped_type` — that
 * option is valid on `sort`, but OpenSearch's `range` query rejects it
 * outright with a parsing exception: confirmed live against the real Cloud
 * Logging instance while testing this file. The `sort` clauses elsewhere in
 * this package that carry `unmapped_type: "date"` on `time` are unaffected
 * and kept as a defensive measure for a rotated index that might lack the
 * field; `range` never supported that option in the first place.
 */
export function buildMetricBoolQuery(opts: MetricFilterOptions, now: Date = new Date()): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [];
  if (opts.service !== undefined) {
    filter.push({ term: { "resource.attributes.sap@cf@app_name": opts.service } });
  }
  if (opts.names !== undefined && opts.names.length > 0) {
    filter.push({ terms: { name: opts.names } });
  }
  if (opts.unit !== undefined) {
    filter.push({ term: { unit: opts.unit } });
  }
  if (opts.since !== undefined || opts.until !== undefined) {
    const range: Record<string, unknown> = {};
    if (opts.since !== undefined) {
      range["gte"] = resolveTimeBound(opts.since, now);
    }
    if (opts.until !== undefined) {
      range["lte"] = resolveTimeBound(opts.until, now);
    }
    filter.push({ range: { time: range } });
  }
  return filter.length === 0 ? { match_all: {} } : { bool: { filter } };
}
