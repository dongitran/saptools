import type { AppCatalogEntry, ParsedLogRow } from "@saptools/cf-logs";

import type {
  AppFilter,
  AppFilterInput,
  TailFilterOptions,
  TailLogRow,
} from "./types.js";

export function buildAppFilter(input: AppFilterInput): AppFilter {
  return {
    include: new Set(normalizeNameList(input.include)),
    exclude: new Set(normalizeNameList(input.exclude)),
    includeRegex: compileRegexList(input.includeRegex ?? []),
    excludeRegex: compileRegexList(input.excludeRegex ?? []),
  };
}

export function applyAppFilter(
  apps: readonly AppCatalogEntry[],
  filter: AppFilter,
): readonly AppCatalogEntry[] {
  return apps.filter((app) => matchesAppFilter(app.name, filter));
}

export function matchesAppFilter(appName: string, filter: AppFilter): boolean {
  if (filter.exclude.has(appName)) {
    return false;
  }
  for (const pattern of filter.excludeRegex) {
    if (pattern.test(appName)) {
      return false;
    }
  }
  const hasInclude = filter.include.size > 0 || filter.includeRegex.length > 0;
  if (!hasInclude) {
    return true;
  }
  if (filter.include.has(appName)) {
    return true;
  }
  return filter.includeRegex.some((pattern) => pattern.test(appName));
}

export function filterTailRows(
  rows: readonly TailLogRow[],
  options: TailFilterOptions = {},
): readonly TailLogRow[] {
  const matched = rows.filter((row) => matchesTailRow(row, options));
  const ordered = options.newestFirst === true ? [...matched].reverse() : matched;
  if (options.maxRows === undefined || ordered.length <= options.maxRows) {
    return ordered;
  }
  return options.newestFirst === true
    ? ordered.slice(0, options.maxRows)
    : ordered.slice(ordered.length - options.maxRows);
}

export function parseDurationMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^(?<n>\d+(?:\.\d+)?)\s*(?<u>ms|s|m|h|d)?$/i.exec(trimmed);
  if (match?.groups === undefined) {
    return undefined;
  }
  const amount = Number.parseFloat(match.groups["n"] ?? "");
  if (!Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  const unit = (match.groups["u"] ?? "s").toLowerCase();
  const factor = DURATION_FACTORS[unit];
  return factor === undefined ? undefined : Math.round(amount * factor);
}

export function parseStatusRange(value: string): {
  readonly min: number;
  readonly max: number;
} | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const exact = /^(?<n>\d{3})$/.exec(trimmed);
  if (exact?.groups !== undefined) {
    const code = Number.parseInt(exact.groups["n"] ?? "", 10);
    return { min: code, max: code };
  }
  const bucket = /^(?<n>[1-5])xx$/i.exec(trimmed);
  if (bucket?.groups !== undefined) {
    const base = Number.parseInt(bucket.groups["n"] ?? "", 10) * 100;
    return { min: base, max: base + 99 };
  }
  const range = /^(?<min>\d{3})-(?<max>\d{3})$/.exec(trimmed);
  if (range?.groups !== undefined) {
    const min = Number.parseInt(range.groups["min"] ?? "", 10);
    const max = Number.parseInt(range.groups["max"] ?? "", 10);
    return min <= max ? { min, max } : { min: max, max: min };
  }
  return undefined;
}

const DURATION_FACTORS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function normalizeNameList(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) {
    return [];
  }
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function compileRegexList(values: readonly string[]): readonly RegExp[] {
  const result: RegExp[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    result.push(new RegExp(trimmed));
  }
  return result;
}

function matchesTailRow(row: TailLogRow, options: TailFilterOptions): boolean {
  if (
    options.apps !== undefined &&
    options.apps.length > 0 &&
    !options.apps.includes(row.appName)
  ) {
    return false;
  }
  if (!matchesLevel(row, options.level)) {
    return false;
  }
  if (!matchesSearch(row, options.searchTerm)) {
    return false;
  }
  if (!matchesSource(row, options.source)) {
    return false;
  }
  if (!matchesTenant(row, options.tenant)) {
    return false;
  }
  if (!matchesStream(row, options.stream)) {
    return false;
  }
  if (!matchesStatusRange(row, options.statusMin, options.statusMax)) {
    return false;
  }
  return matchesTimeRange(row, options.sinceMs, options.untilMs);
}

function matchesLevel(row: ParsedLogRow, level: TailFilterOptions["level"]): boolean {
  return level === undefined || level === "all" || row.level === level;
}

function matchesSearch(row: ParsedLogRow, searchTerm: string | undefined): boolean {
  const term = searchTerm?.trim().toLowerCase() ?? "";
  return term.length === 0 || row.searchableText.includes(term);
}

function matchesSource(row: ParsedLogRow, source: string | undefined): boolean {
  const value = source?.trim().toLowerCase() ?? "";
  if (value.length === 0) {
    return true;
  }
  return row.source.toLowerCase().includes(value);
}

function matchesTenant(row: ParsedLogRow, tenant: string | undefined): boolean {
  const value = tenant?.trim() ?? "";
  return value.length === 0 || row.tenant === value;
}

function matchesStream(
  row: ParsedLogRow,
  stream: TailFilterOptions["stream"],
): boolean {
  if (stream === undefined || stream === "all") {
    return true;
  }
  return stream === "err" ? row.stream === "ERR" : row.stream === "OUT";
}

function matchesStatusRange(
  row: ParsedLogRow,
  min: number | undefined,
  max: number | undefined,
): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }
  if (!/^\d{3}$/.test(row.status)) {
    return false;
  }
  const status = Number.parseInt(row.status, 10);
  if (min !== undefined && status < min) {
    return false;
  }
  return max === undefined || status <= max;
}

function matchesTimeRange(
  row: ParsedLogRow,
  sinceMs: number | undefined,
  untilMs: number | undefined,
): boolean {
  if (sinceMs === undefined && untilMs === undefined) {
    return true;
  }
  const epoch = parseRowTimestamp(row.timestampRaw);
  if (epoch === undefined) {
    return false;
  }
  const now = Date.now();
  if (sinceMs !== undefined && epoch < now - sinceMs) {
    return false;
  }
  return untilMs === undefined || epoch >= now - untilMs;
}

function parseRowTimestamp(value: string): number | undefined {
  const normalized = value.replace(
    /(?<sign>[+-])(?<hh>\d{2})(?<mm>\d{2})$/,
    "$<sign>$<hh>:$<mm>",
  );
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}
