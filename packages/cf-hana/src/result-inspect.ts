import { CfHanaError } from "./errors.js";
import { isTextLobType } from "./lob.js";
import { previewCell } from "./result-preview.js";
import type { ResultSession } from "./result-store.js";
import type { QueryRow, SqlParam } from "./types.js";

export interface SelectedResultCell {
  readonly row: number;
  readonly column: string;
  readonly typeName: string;
  readonly value: SqlParam;
}

export interface CellWindow {
  readonly type: "text" | "binary" | "scalar";
  readonly originalLength: number;
  readonly offset: number;
  readonly value: string;
}

export interface JsonInspectionRow {
  readonly path: string;
  readonly type: string;
  readonly value: string;
}

export interface ResultSearchOptions {
  readonly row?: number;
  readonly column?: string;
  readonly limit: number;
  readonly previewLength?: number;
}

export interface ResultSearchMatch {
  readonly row: number;
  readonly column: string;
  readonly offset?: number;
  readonly path: string;
  readonly preview: string;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CfHanaError(
      "CONFIG",
      `${name} ${String(value)} must be a positive safe integer`,
    );
  }
}

/** Select one saved result row using one-based numbering. */
export function selectResultRow(session: ResultSession, rowNumber: number): QueryRow {
  assertPositiveInteger("row", rowNumber);
  const row = session.result.rows[rowNumber - 1];
  if (row === undefined) {
    throw new CfHanaError("QUERY", `Saved result row ${String(rowNumber)} not found`);
  }
  return row;
}

/** Select one exact saved cell by its case-sensitive SQL display name. */
export function selectResultCell(
  session: ResultSession,
  rowNumber: number,
  columnName: string,
): SelectedResultCell {
  const row = selectResultRow(session, rowNumber);
  const column = session.result.columns.find((item) => item.name === columnName);
  if (column === undefined) {
    throw new CfHanaError("QUERY", `Saved result column "${columnName}" not found`);
  }
  return {
    row: rowNumber,
    column: column.name,
    typeName: column.typeName,
    value: row[column.name] ?? null,
  };
}

function textRange(value: string, offset: number, length: number): CellWindow {
  let index = 0;
  let selected = "";
  for (const char of value) {
    if (index >= offset && index < offset + length) {
      selected += char;
    }
    index += 1;
  }
  return { type: "text", originalLength: index, offset, value: selected };
}

/** Read a bounded range from an exact saved cell. */
export function readCellWindow(
  value: SqlParam,
  offset: number,
  length: number,
  typeName?: string,
): CellWindow {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CfHanaError("CONFIG", "offset must be a non-negative safe integer");
  }
  assertPositiveInteger("length", length);
  if (Buffer.isBuffer(value)) {
    if (isTextLobType(typeName)) {
      return textRange(value.toString("utf8"), offset, length);
    }
    return {
      type: "binary",
      originalLength: value.length,
      offset,
      value: `0x${value.subarray(offset, offset + length).toString("hex")}`,
    };
  }
  if (typeof value === "string") {
    return textRange(value, offset, length);
  }
  const text = previewCell(value, Number.MAX_SAFE_INTEGER).text;
  const window = textRange(text, offset, length);
  return { ...window, type: "scalar" };
}

function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new CfHanaError("CONFIG", "Invalid JSON Pointer escape");
  }
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerTokens(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new CfHanaError("CONFIG", "JSON Pointer must be empty or start with /");
  }
  return pointer.slice(1).split("/").map(decodePointerToken);
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        throw new CfHanaError("QUERY", `JSON Pointer path "${pointer}" not found`);
      }
      current = current[index];
      continue;
    }
    if (typeof current === "object" && current !== null && token in current) {
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    throw new CfHanaError("QUERY", `JSON Pointer path "${pointer}" not found`);
  }
  return current;
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function jsonValueText(value: unknown, limit: number): string {
  if (Array.isArray(value)) {
    return `items=${String(value.length)}`;
  }
  if (typeof value === "object" && value !== null) {
    return `keys=${String(Object.keys(value).length)}`;
  }
  if (typeof value === "string") {
    return previewCell(value, limit).text;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function jsonSearchText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function inspectionRow(path: string, value: unknown, limit: number): JsonInspectionRow {
  return { path, type: jsonType(value), value: jsonValueText(value, limit) };
}

/** Resolve a JSON Pointer and describe the selected value or its immediate children. */
export function inspectJsonCell(
  value: SqlParam,
  pointer: string,
  limit: number,
): readonly JsonInspectionRow[] {
  if (typeof value !== "string") {
    throw new CfHanaError("QUERY", "JSON Pointer requires a text cell");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CfHanaError("QUERY", "Saved result cell does not contain valid JSON", {
      cause: error,
    });
  }
  const selected = resolvePointer(parsed, pointer);
  if (Array.isArray(selected)) {
    return selected.map((item, index) =>
      inspectionRow(`${pointer}/${String(index)}`, item, limit),
    );
  }
  if (typeof selected === "object" && selected !== null) {
    return Object.entries(selected).map(([key, item]) =>
      inspectionRow(`${pointer}/${escapePointerToken(key)}`, item, limit),
    );
  }
  return [inspectionRow(pointer, selected, limit)];
}

function plainTextMatches(
  text: string,
  term: string,
  row: number,
  column: string,
  limit: number,
  previewLength: number,
): readonly ResultSearchMatch[] {
  const matches: ResultSearchMatch[] = [];
  const lowerText = text.toLowerCase();
  let offset = lowerText.indexOf(term);
  while (offset >= 0 && matches.length < limit) {
    const start = Math.max(0, offset - 32);
    matches.push({
      row,
      column,
      offset,
      path: "",
      preview: textRange(text, start, previewLength).value.replaceAll(/[\r\n\t]/g, " "),
    });
    offset = lowerText.indexOf(term, offset + Math.max(1, term.length));
  }
  return matches;
}

function jsonSearchMatches(
  root: unknown,
  term: string,
  row: number,
  column: string,
  limit: number,
  previewLength: number,
): readonly ResultSearchMatch[] {
  const matches: ResultSearchMatch[] = [];
  const stack: { readonly path: string; readonly value: unknown }[] = [
    { path: "", value: root },
  ];
  while (stack.length > 0 && matches.length < limit) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (typeof entry.value === "object" && entry.value !== null) {
      const entries = Array.isArray(entry.value)
        ? entry.value.map((item, index) => [String(index), item] as const)
        : Object.entries(entry.value);
      for (const [key, value] of entries.reverse()) {
        const path = `${entry.path}/${escapePointerToken(key)}`;
        if (key.toLowerCase().includes(term)) {
          matches.push({ row, column, path, preview: jsonValueText(value, previewLength) });
          if (matches.length >= limit) {
            break;
          }
        }
        stack.push({ path, value });
      }
      continue;
    }
    const text = jsonSearchText(entry.value);
    if (text.toLowerCase().includes(term)) {
      matches.push({
        row,
        column,
        path: entry.path,
        preview: previewCell(text, previewLength).text,
      });
    }
  }
  return matches;
}

function searchCell(
  value: SqlParam,
  term: string,
  row: number,
  column: string,
  typeName: string | undefined,
  limit: number,
  previewLength: number,
): readonly ResultSearchMatch[] {
  const text = Buffer.isBuffer(value) && isTextLobType(typeName)
    ? value.toString("utf8")
    : value;
  if (typeof text !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return jsonSearchMatches(parsed, term, row, column, limit, previewLength);
    }
  } catch {
    // Non-JSON text is searched literally below.
  }
  return plainTextMatches(text, term, row, column, limit, previewLength);
}

/** Search exact saved text and JSON values without loading binary cells into output. */
export function searchResultSession(
  session: ResultSession,
  searchTerm: string,
  options: ResultSearchOptions,
): readonly ResultSearchMatch[] {
  assertPositiveInteger("limit", options.limit);
  const term = searchTerm.trim().toLowerCase();
  if (term.length === 0) {
    throw new CfHanaError("CONFIG", "search text must not be empty");
  }
  const previewLength = options.previewLength ?? 128;
  assertPositiveInteger("preview length", previewLength);
  const rows = options.row === undefined
    ? session.result.rows.map((row, index) => ({ row, rowNumber: index + 1 }))
    : [{ row: selectResultRow(session, options.row), rowNumber: options.row }];
  const columns = options.column === undefined
    ? session.result.columns
    : [selectResultCell(session, rows[0]?.rowNumber ?? 1, options.column)]
        .map((item) => ({ name: item.column, typeName: item.typeName }));
  const matches: ResultSearchMatch[] = [];
  for (const item of rows) {
    for (const column of columns) {
      const remaining = options.limit - matches.length;
      matches.push(
        ...searchCell(
          item.row[column.name] ?? null,
          term,
          item.rowNumber,
          column.name,
          column.typeName,
          remaining,
          previewLength,
        ),
      );
      if (matches.length >= options.limit) {
        return matches;
      }
    }
  }
  return matches;
}
