import { CfOtelError } from "./errors.js";
import type { AttrFilter, SpanFilterOptions } from "./types.js";

const RELATIVE_DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_MILLIS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

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
    const range: Record<string, string> = {};
    if (opts.since !== undefined) {
      range["gte"] = resolveTimeBound(opts.since, now);
    }
    if (opts.until !== undefined) {
      range["lte"] = resolveTimeBound(opts.until, now);
    }
    filter.push({ range: { startTime: range } });
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
