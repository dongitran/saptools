import { isTextLobType } from "./lob.js";
import { previewCell } from "./result-preview.js";
import type { OutputFormat, QueryResult, QueryResultColumn, SqlParam } from "./types.js";

type JsonCell = string | number | boolean | null;

function cellText(value: SqlParam, nullText: string, column?: QueryResultColumn): string {
  if (value === null) {
    return nullText;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return isTextLobType(column?.typeName)
      ? value.toString("utf8")
      : `0x${value.toString("hex")}`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return typeof value === "number" ? value.toString() : value;
}

function serializeCell(value: SqlParam, column?: QueryResultColumn): JsonCell {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return isTextLobType(column?.typeName)
      ? value.toString("utf8")
      : `0x${value.toString("hex")}`;
  }
  return value;
}

function csvEscape(text: string): string {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export interface CompactCsv {
  readonly text: string;
  readonly truncatedCells: number;
}

/** Render a result as an aligned ASCII table. */
export function formatTable(result: QueryResult): string {
  if (result.columns.length === 0) {
    return `(${String(result.rowCount)} row(s) affected)`;
  }

  const headers = result.columns.map((column) => column.name);
  const rows = result.rows.map((row) =>
    result.columns.map((column) => cellText(row[column.name] ?? null, "NULL", column)),
  );
  const widths = headers.map((header, index) => {
    const widest = rows.reduce(
      (max, cells) => Math.max(max, (cells[index] ?? "").length),
      header.length,
    );
    return widest;
  });

  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows.map((cells) => renderRow(cells));

  return [renderRow(headers), separator, ...body].join("\n");
}

/** Render a result's rows as pretty-printed JSON. */
export function formatJson(result: QueryResult): string {
  const rows = result.rows.map((row) => {
    const serialized: Record<string, JsonCell> = {};
    for (const [key, value] of Object.entries(row)) {
      const column = result.columns.find((item) => item.name === key);
      serialized[key] = serializeCell(value, column);
    }
    return serialized;
  });
  return JSON.stringify(rows, null, 2);
}

/** Render a result as RFC 4180 CSV. */
export function formatCsv(result: QueryResult): string {
  const headers = result.columns.map((column) => column.name);
  const lines = [headers.map((header) => csvEscape(header)).join(",")];
  for (const row of result.rows) {
    lines.push(
      result.columns
        .map((column) => csvEscape(cellText(row[column.name] ?? null, "", column)))
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** Render bounded CSV for CLI SELECT output without mutating the source result. */
export function formatCompactCsv(result: QueryResult, cellLimit: number): CompactCsv {
  const headers = result.columns.map((column) => column.name);
  const lines = [headers.map((header) => csvEscape(header)).join(",")];
  let truncatedCells = 0;
  for (const row of result.rows) {
    const cells = result.columns.map((column) => {
      const preview = previewCell(row[column.name] ?? null, cellLimit, column.typeName);
      if (preview.truncated) {
        truncatedCells += 1;
      }
      return csvEscape(preview.text);
    });
    lines.push(cells.join(","));
  }
  return { text: lines.join("\r\n"), truncatedCells };
}

/** Render a query result in the requested output format. */
export function formatResult(result: QueryResult, format: OutputFormat): string {
  switch (format) {
    case "table":
      return formatTable(result);
    case "json":
      return formatJson(result);
    case "csv":
      return formatCsv(result);
  }
}
