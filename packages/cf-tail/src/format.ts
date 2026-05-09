import type { LogLevel } from "@saptools/cf-logs";

import type { FormatRowOptions, TailLogRow } from "./types.js";

const ESC = String.fromCharCode(27);

const PALETTE: readonly string[] = [
  `${ESC}[36m`, // cyan
  `${ESC}[33m`, // yellow
  `${ESC}[35m`, // magenta
  `${ESC}[32m`, // green
  `${ESC}[34m`, // blue
  `${ESC}[91m`, // bright red
  `${ESC}[96m`, // bright cyan
  `${ESC}[93m`, // bright yellow
  `${ESC}[95m`, // bright magenta
  `${ESC}[94m`, // bright blue
];

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: `${ESC}[90m`,
  debug: `${ESC}[37m`,
  info: `${ESC}[32m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
  fatal: `${ESC}[1;31m`,
};

const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[90m`;

export function pickAppColor(appName: string): string {
  let hash = 0;
  for (let index = 0; index < appName.length; index += 1) {
    hash = (hash * 31 + appName.charCodeAt(index)) | 0;
  }
  const palettePosition = Math.abs(hash) % PALETTE.length;
  return PALETTE[palettePosition] ?? PALETTE[0] ?? "";
}

export function formatRowText(row: TailLogRow, options: FormatRowOptions = {}): string {
  const useColor = options.color ?? false;
  const padding = Math.max(options.appNamePadding ?? row.appName.length, row.appName.length);
  const appLabel = `[${row.appName.padEnd(padding)}]`;
  const levelLabel = row.level.toUpperCase().padEnd(5);
  const time = row.timestamp || row.timestampRaw || "--:--:--";
  const message = renderMessage(row.message, options.truncateMessage);
  const segments: string[] = [time, appLabel, levelLabel];
  if (options.showSource === true && row.source.length > 0) {
    segments.push(row.source);
  }
  const meta = options.showRequestMeta === true ? buildRequestMetaSegment(row) : "";
  if (meta.length > 0) {
    segments.push(meta);
  }
  segments.push(message);
  const plainLine = segments.join(" ");
  if (!useColor) {
    return plainLine;
  }
  const appColor = pickAppColor(row.appName);
  const levelColor = LEVEL_COLORS[row.level];
  const colorParts: string[] = [
    time,
    `${appColor}${appLabel}${RESET}`,
    `${levelColor}${BOLD}${levelLabel}${RESET}`,
  ];
  if (options.showSource === true && row.source.length > 0) {
    colorParts.push(`${DIM}${row.source}${RESET}`);
  }
  if (meta.length > 0) {
    colorParts.push(`${DIM}${meta}${RESET}`);
  }
  colorParts.push(`${levelColor}${message}${RESET}`);
  return colorParts.join(" ");
}

export function formatRowsText(
  rows: readonly TailLogRow[],
  options: FormatRowOptions = {},
): string {
  const padding = computeAppNamePadding(rows);
  return rows
    .map((row) => formatRowText(row, { ...options, appNamePadding: padding }))
    .join("\n");
}

export function formatGroupedByApp(
  rows: readonly TailLogRow[],
  options: FormatRowOptions = {},
): string {
  const groups = new Map<string, TailLogRow[]>();
  for (const row of rows) {
    const list = groups.get(row.appName) ?? [];
    list.push(row);
    groups.set(row.appName, list);
  }
  const sortedKeys = [...groups.keys()].sort((left, right) => left.localeCompare(right));
  const sections: string[] = [];
  for (const appName of sortedKeys) {
    const groupRows = groups.get(appName) ?? [];
    sections.push(buildGroupSection(appName, groupRows, options));
  }
  return sections.join("\n\n");
}

function buildGroupSection(
  appName: string,
  rows: readonly TailLogRow[],
  options: FormatRowOptions,
): string {
  const useColor = options.color ?? false;
  const header = useColor
    ? `${pickAppColor(appName)}${BOLD}=== ${appName} (${rows.length.toString()} rows) ===${RESET}`
    : `=== ${appName} (${rows.length.toString()} rows) ===`;
  const body = formatRowsText(rows, options);
  return `${header}\n${body}`;
}

function buildRequestMetaSegment(row: TailLogRow): string {
  const parts: string[] = [];
  if (row.status.length > 0) {
    parts.push(`status=${row.status}`);
  }
  if (row.latency.length > 0) {
    parts.push(`latency=${row.latency}`);
  }
  if (row.tenant.length > 0) {
    parts.push(`tenant=${row.tenant}`);
  }
  return parts.join(" ");
}

function renderMessage(message: string, truncateAt: number | undefined): string {
  const collapsed = message.replace(/\r?\n/g, "↵ ");
  if (truncateAt === undefined || truncateAt <= 0 || collapsed.length <= truncateAt) {
    return collapsed;
  }
  return `${collapsed.slice(0, truncateAt - 1)}…`;
}

function computeAppNamePadding(rows: readonly TailLogRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.appName.length > max) {
      max = row.appName.length;
    }
  }
  return max;
}
