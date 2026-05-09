import type { ParsedLogRow } from "@saptools/cf-logs";

import type { TailLogRow } from "./types.js";

export function tagRowsWithApp(
  appName: string,
  rows: readonly ParsedLogRow[],
): readonly TailLogRow[] {
  return rows.map((row) => ({ ...row, appName }));
}

export function mergeAppRows(
  rowsByApp: ReadonlyMap<string, readonly ParsedLogRow[]>,
): readonly TailLogRow[] {
  const tagged: TailLogRow[] = [];
  for (const [appName, rows] of rowsByApp) {
    for (const row of rows) {
      tagged.push({ ...row, appName });
    }
  }
  tagged.sort(compareTailRows);
  return tagged;
}

export function mergeTailRowChunks(
  chunks: readonly (readonly TailLogRow[])[],
): readonly TailLogRow[] {
  const merged: TailLogRow[] = [];
  for (const chunk of chunks) {
    for (const row of chunk) {
      merged.push(row);
    }
  }
  merged.sort(compareTailRows);
  return merged;
}

export function compareTailRows(left: TailLogRow, right: TailLogRow): number {
  const leftEpoch = parseTimestampEpoch(left.timestampRaw);
  const rightEpoch = parseTimestampEpoch(right.timestampRaw);
  if (leftEpoch !== undefined && rightEpoch !== undefined && leftEpoch !== rightEpoch) {
    return leftEpoch - rightEpoch;
  }
  if (leftEpoch !== undefined && rightEpoch === undefined) {
    return -1;
  }
  if (leftEpoch === undefined && rightEpoch !== undefined) {
    return 1;
  }
  const rawCompare = left.timestampRaw.localeCompare(right.timestampRaw);
  if (rawCompare !== 0) {
    return rawCompare;
  }
  const appCompare = left.appName.localeCompare(right.appName);
  return appCompare === 0 ? left.id - right.id : appCompare;
}

export function parseTimestampEpoch(value: string): number | undefined {
  const normalized = normalizeTimestamp(value);
  if (normalized === undefined) {
    return undefined;
  }
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeTimestamp(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "N/A") {
    return undefined;
  }
  return trimmed.replace(/(?<sign>[+-])(?<hh>\d{2})(?<mm>\d{2})$/, "$<sign>$<hh>:$<mm>");
}
