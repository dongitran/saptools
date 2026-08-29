import type { OutputFormat } from "./types.js";

export type OutputRow = Readonly<Record<string, unknown>>;

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return JSON.stringify(value);
}

function csvEscape(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function collectColumns(rows: readonly OutputRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

/** Render rows as an aligned ASCII table. */
export function formatTable(rows: readonly OutputRow[]): string {
  if (rows.length === 0) {
    return "(no rows)";
  }
  const columns = collectColumns(rows);
  const cellRows = rows.map((row) => columns.map((column) => cellText(row[column])));
  const widths = columns.map((column, index) =>
    cellRows.reduce((max, cells) => Math.max(max, (cells[index] ?? "").length), column.length),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  return [renderRow(columns), separator, ...cellRows.map(renderRow)].join("\n");
}

/** Render rows as pretty-printed, lossless JSON. */
export function formatJson(rows: readonly OutputRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/** Render a single column's values as a bare JSON array; falls back to {@link formatJson} otherwise. */
export function formatJsonCompact(rows: readonly OutputRow[], preferredColumn?: string): string {
  const columns = collectColumns(rows);
  const columnName = preferredColumn ?? (columns.length === 1 ? columns[0] : undefined);
  if (columnName === undefined) {
    return formatJson(rows);
  }
  return JSON.stringify(
    rows.map((row) => row[columnName] ?? null),
    null,
    2,
  );
}

/** Render rows as RFC 4180 CSV. */
export function formatCsv(rows: readonly OutputRow[]): string {
  const columns = collectColumns(rows);
  const lines = [columns.map((column) => csvEscape(column)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(cellText(row[column]))).join(","));
  }
  return lines.join("\r\n");
}

/** Render rows in the requested output format. */
export function formatResult(rows: readonly OutputRow[], format: OutputFormat, compactColumn?: string): string {
  switch (format) {
    case "table":
      return formatTable(rows);
    case "json":
      return formatJson(rows);
    case "json-compact":
      return formatJsonCompact(rows, compactColumn);
    case "csv":
      return formatCsv(rows);
  }
}
