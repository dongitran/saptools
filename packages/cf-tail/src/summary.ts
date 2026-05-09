import type { LogLevel } from "@saptools/cf-logs";

import { compareTailRows } from "./merge.js";
import type {
  TailAppSummary,
  TailLevelSummary,
  TailLogRow,
  TailSummary,
} from "./types.js";

const LEVEL_KEYS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

export function summarizeRows(rows: readonly TailLogRow[]): TailSummary {
  const totalLevels = emptyLevelSummary();
  const perApp = new Map<string, AppSummaryAccumulator>();

  for (const row of rows) {
    addLevel(totalLevels, row.level);
    const accumulator = readOrCreate(perApp, row.appName);
    accumulator.total += 1;
    addLevel(accumulator.levels, row.level);
    incrementMap(accumulator.sources, row.source);
    if (row.tenant.length > 0) {
      incrementMap(accumulator.tenants, row.tenant);
    }
    if (/^\d{3}$/.test(row.status)) {
      incrementMap(accumulator.statusBuckets, statusBucketKey(row.status));
    }
    accumulator.firstAt = pickFirst(accumulator.firstAt, row);
    accumulator.lastAt = pickLast(accumulator.lastAt, row);
  }

  const apps = [...perApp.values()]
    .map((entry) => finalizeAppSummary(entry))
    .sort((left, right) => left.appName.localeCompare(right.appName));

  return {
    total: rows.length,
    levels: totalLevels,
    apps,
  };
}

interface AppSummaryAccumulator {
  readonly appName: string;
  total: number;
  readonly levels: TailLevelSummary;
  readonly sources: Map<string, number>;
  readonly statusBuckets: Map<string, number>;
  readonly tenants: Map<string, number>;
  firstAt: TailLogRow | undefined;
  lastAt: TailLogRow | undefined;
}

function emptyLevelSummary(): TailLevelSummary {
  return { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
}

function addLevel(levels: TailLevelSummary, level: LogLevel): void {
  if (LEVEL_KEYS.includes(level)) {
    Object.assign(levels, { [level]: levels[level] + 1 });
  }
}

function readOrCreate(
  map: Map<string, AppSummaryAccumulator>,
  appName: string,
): AppSummaryAccumulator {
  const existing = map.get(appName);
  if (existing !== undefined) {
    return existing;
  }
  const accumulator: AppSummaryAccumulator = {
    appName,
    total: 0,
    levels: emptyLevelSummary(),
    sources: new Map<string, number>(),
    statusBuckets: new Map<string, number>(),
    tenants: new Map<string, number>(),
    firstAt: undefined,
    lastAt: undefined,
  };
  map.set(appName, accumulator);
  return accumulator;
}

function incrementMap(map: Map<string, number>, key: string): void {
  const value = map.get(key) ?? 0;
  map.set(key, value + 1);
}

function statusBucketKey(status: string): string {
  return `${status[0] ?? "?"}xx`;
}

function pickFirst(
  current: TailLogRow | undefined,
  candidate: TailLogRow,
): TailLogRow {
  if (current === undefined) {
    return candidate;
  }
  return compareTailRows(candidate, current) < 0 ? candidate : current;
}

function pickLast(
  current: TailLogRow | undefined,
  candidate: TailLogRow,
): TailLogRow {
  if (current === undefined) {
    return candidate;
  }
  return compareTailRows(candidate, current) > 0 ? candidate : current;
}

function finalizeAppSummary(entry: AppSummaryAccumulator): TailAppSummary {
  return {
    appName: entry.appName,
    total: entry.total,
    levels: entry.levels,
    sources: entry.sources,
    statusBuckets: entry.statusBuckets,
    tenants: entry.tenants,
    firstAt: entry.firstAt?.timestampRaw,
    lastAt: entry.lastAt?.timestampRaw,
  };
}
