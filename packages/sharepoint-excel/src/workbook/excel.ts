import ExcelJS from "exceljs";
import type { CellValue, Worksheet } from "exceljs";

import type {
  JsonCellValue,
  JsonRecord,
  JsonRow,
  WorkbookCreateInput,
  WorkbookInputRow,
  WorkbookMutationResult,
  WorkbookReadOptions,
  WorkbookReadResult,
  WorkbookSheetReadResult,
} from "../types.js";

import { parseA1Cell, parseA1Range } from "./a1.js";

const INVALID_SHEET_CHARS = /[\][:*?/\\]/;

function validateSheetName(sheetName: string): string {
  const trimmed = sheetName.trim();
  if (trimmed.length === 0 || trimmed.length > 31 || INVALID_SHEET_CHARS.test(trimmed)) {
    throw new Error(`Invalid Excel sheet name "${sheetName}"`);
  }
  return trimmed;
}

function isRecord(row: WorkbookInputRow): row is JsonRecord {
  return !Array.isArray(row);
}

function deriveHeaders(headers: readonly string[], rows: readonly WorkbookInputRow[]): readonly string[] {
  if (headers.length > 0) {
    return headers;
  }
  const firstRecord = rows.find(isRecord);
  return firstRecord === undefined ? [] : Object.keys(firstRecord);
}

function rowToValues(row: WorkbookInputRow, headers: readonly string[]): JsonRow {
  if (!isRecord(row)) {
    return [...row];
  }
  const record = row;
  if (headers.length === 0) {
    return Object.keys(record).map((key) => record[key] ?? null);
  }
  return headers.map((header) => record[header] ?? null);
}

function addRows(sheet: Worksheet, headers: readonly string[], rows: readonly WorkbookInputRow[]): void {
  if (headers.length > 0) {
    sheet.addRow([...headers]);
  }
  for (const row of rows) {
    sheet.addRow([...rowToValues(row, headers)]);
  }
}

function addTable(sheet: Worksheet, tableName: string, headers: readonly string[], rows: readonly WorkbookInputRow[]): void {
  sheet.addTable({
    name: tableName,
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headers.map((name) => ({ name })),
    rows: rows.map((row) => [...rowToValues(row, headers)]),
  });
}

async function workbookToBytes(workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(uint8ArrayToArrayBuffer(bytes));
  return workbook;
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function getWorksheet(workbook: ExcelJS.Workbook, sheetName: string): Worksheet {
  const sheet = workbook.getWorksheet(sheetName);
  if (sheet === undefined) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }
  return sheet;
}

function serializeCellValue(value: unknown): JsonCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && "result" in value) {
    return serializeCellValue((value as { readonly result?: unknown }).result);
  }
  return JSON.stringify(value);
}

function readRow(sheet: Worksheet, rowNumber: number, startColumn: number, endColumn: number): JsonRow {
  const row = sheet.getRow(rowNumber);
  const columnCount = endColumn - startColumn + 1;
  return Array.from({ length: columnCount }, (_value, index) =>
    serializeCellValue(row.getCell(startColumn + index).value),
  );
}

function readHeaderRow(sheet: Worksheet): readonly string[] {
  if (sheet.actualRowCount === 0) {
    return [];
  }
  return readRow(sheet, 1, 1, Math.max(1, sheet.actualColumnCount)).map((value) => String(value ?? ""));
}

function readSheet(sheet: Worksheet, options: WorkbookReadOptions): WorkbookSheetReadResult {
  const range = options.range === undefined ? undefined : parseA1Range(options.range);
  const startRow = range?.start.row ?? 1;
  const endRow = range?.end.row ?? Math.max(1, sheet.actualRowCount);
  const startColumn = range?.start.column ?? 1;
  const endColumn = range?.end.column ?? Math.max(1, sheet.actualColumnCount);
  const rows: JsonRow[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    rows.push(readRow(sheet, row, startColumn, endColumn));
  }
  return { name: sheet.name, rowCount: rows.length, columnCount: endColumn - startColumn + 1, rows };
}

export async function createWorkbookBytes(input: WorkbookCreateInput): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(validateSheetName(input.sheetName));
  const headers = deriveHeaders(input.headers, input.rows);
  if (input.tableName !== undefined && input.tableName.length > 0 && headers.length > 0) {
    addTable(sheet, input.tableName, headers, input.rows);
  } else {
    addRows(sheet, headers, input.rows);
  }
  return await workbookToBytes(workbook);
}

export async function readWorkbookBytes(
  bytes: Uint8Array,
  options: WorkbookReadOptions = {},
): Promise<WorkbookReadResult> {
  const workbook = await loadWorkbook(bytes);
  const sheets =
    options.sheetName === undefined
      ? workbook.worksheets
      : [getWorksheet(workbook, validateSheetName(options.sheetName))];
  return { sheets: sheets.map((sheet) => readSheet(sheet, options)) };
}

export async function appendWorkbookRows(
  bytes: Uint8Array,
  sheetName: string,
  rows: readonly WorkbookInputRow[],
  matchHeader: boolean,
): Promise<WorkbookMutationResult> {
  const workbook = await loadWorkbook(bytes);
  const sheet = getWorksheet(workbook, validateSheetName(sheetName));
  const headers = matchHeader ? readHeaderRow(sheet) : deriveHeaders([], rows);
  for (const row of rows) {
    sheet.addRow([...rowToValues(row, headers)]);
  }
  return {
    bytes: await workbookToBytes(workbook),
    sheetName: sheet.name,
    rowCount: sheet.actualRowCount,
    columnCount: sheet.actualColumnCount,
  };
}

export async function updateWorkbookCell(
  bytes: Uint8Array,
  sheetName: string,
  cellRef: string,
  value: CellValue,
): Promise<WorkbookMutationResult> {
  const workbook = await loadWorkbook(bytes);
  const sheet = getWorksheet(workbook, validateSheetName(sheetName));
  const cell = parseA1Cell(cellRef);
  sheet.getCell(cell.row, cell.column).value = value;
  return {
    bytes: await workbookToBytes(workbook),
    sheetName: sheet.name,
    rowCount: sheet.actualRowCount,
    columnCount: sheet.actualColumnCount,
  };
}

export async function addWorkbookSheet(
  bytes: Uint8Array,
  sheetName: string,
  headers: readonly string[],
): Promise<WorkbookMutationResult> {
  const workbook = await loadWorkbook(bytes);
  const normalized = validateSheetName(sheetName);
  if (workbook.getWorksheet(normalized) !== undefined) {
    throw new Error(`Sheet "${normalized}" already exists`);
  }
  const sheet = workbook.addWorksheet(normalized);
  if (headers.length > 0) {
    sheet.addRow([...headers]);
  }
  return {
    bytes: await workbookToBytes(workbook),
    sheetName: sheet.name,
    rowCount: sheet.actualRowCount,
    columnCount: sheet.actualColumnCount,
  };
}
