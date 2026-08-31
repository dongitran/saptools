import { CfMetricsError } from "./errors.js";

const RELATIVE_DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_MILLIS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
// Anchored to ISO-8601's date/date-time shape — the format --since/--until's absolute-timestamp
// path documents, and the only shape OpenSearch's `strict_date_optional_time` mapping accepts.
// Deliberately narrower than JS's `Date.parse`, which leniently accepts non-ISO formats (e.g.
// "8/31/2026", or "yesterday" on some engines) under implementation-defined, often-local-timezone
// semantics that would silently query the wrong window instead of failing loudly.
const ABSOLUTE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Resolve `--since`/`--until` as either a relative duration ("24h") or an absolute ISO-8601 timestamp. */
export function resolveTimeBound(value: string, now: Date = new Date()): string {
  const match = RELATIVE_DURATION_PATTERN.exec(value.trim());
  if (match === null) {
    return value.trim();
  }
  const amount = Number(match[1]);
  const unitMillis = UNIT_MILLIS[match[2] ?? ""] ?? 0;
  return new Date(now.getTime() - amount * unitMillis).toISOString();
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
    return;
  }
  if (!ABSOLUTE_ISO_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new CfMetricsError(
      "CONFIG",
      `Invalid ${flagName} value "${value}" (expected a relative duration like "24h"/"30m"/"2d", or an absolute ISO-8601 timestamp like "2026-08-30T03:00:00Z")`,
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
