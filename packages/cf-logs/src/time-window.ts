import type { ParsedLogRow } from "./types.js";

const DURATION_UNITS_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
} as const;

const DURATION_PATTERN = /^(?<amount>[1-9]\d*)(?<unit>s|m|h|d)$/i;
const OFFSET_WITHOUT_COLON_PATTERN = /([+-]\d{2})(\d{2})$/;

export function parseSinceDurationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (match?.groups === undefined) {
    throw new Error("--since must be a positive duration like 15m, 45m, 1h, or 1d.");
  }
  const amount = Number.parseInt(match.groups["amount"] ?? "", 10);
  const unit = match.groups["unit"]?.toLowerCase();
  const unitMs = readDurationUnitMs(unit);
  const durationMs = amount * unitMs;
  if (!Number.isSafeInteger(durationMs)) {
    throw new Error("--since duration is too large.");
  }
  return durationMs;
}

export function filterRowsSince(
  rows: readonly ParsedLogRow[],
  sinceMs: number,
  now: Date,
): readonly ParsedLogRow[] {
  const cutoffMs = now.getTime() - sinceMs;
  return rows
    .filter((row) => {
      const timestampMs = parseLogTimestampMs(row.timestampRaw);
      return timestampMs !== undefined && timestampMs >= cutoffMs;
    })
    .map((row, index) => ({ ...row, id: index + 1 }));
}

export function formatRowsAsRawText(rows: readonly ParsedLogRow[]): string {
  return rows.map(formatRowAsRawText).join("\n");
}

function readDurationUnitMs(unit: string | undefined): number {
  if (unit === "s" || unit === "m" || unit === "h" || unit === "d") {
    return DURATION_UNITS_MS[unit];
  }
  throw new Error("--since must be a positive duration like 15m, 45m, 1h, or 1d.");
}

function parseLogTimestampMs(timestamp: string): number | undefined {
  const normalized = timestamp.trim().replace(OFFSET_WITHOUT_COLON_PATTERN, "$1:$2");
  const timestampMs = Date.parse(normalized);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function formatRowAsRawText(row: ParsedLogRow): string {
  return `${row.timestampRaw} [${row.source}] ${row.stream} ${row.rawBody}`;
}
