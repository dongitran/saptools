import { z } from "zod";

import type { JsonCellValue, WorkbookInputRow } from "../types.js";

const JsonCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonRowSchema = z.array(JsonCellValueSchema);
const JsonRecordSchema = z.record(z.string(), JsonCellValueSchema);

export function parseHeaders(input: string | undefined): readonly string[] {
  if (input === undefined || input.trim().length === 0) {
    return [];
  }
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseJson(input: string, label: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON for ${label}`, { cause: err });
  }
}

export function parseCellValue(input: string): JsonCellValue {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = parseJson(trimmed, "cell value");
  } catch {
    return input;
  }
  const result = JsonCellValueSchema.safeParse(parsed);
  if (!result.success) {
    return input;
  }
  return result.data;
}

export function parseWorkbookRows(input: string | undefined): readonly WorkbookInputRow[] {
  if (input === undefined || input.trim().length === 0) {
    return [];
  }
  const parsed = parseJson(input, "rows");
  const rowResult = JsonRowSchema.safeParse(parsed);
  if (rowResult.success) {
    return [rowResult.data];
  }
  const recordResult = JsonRecordSchema.safeParse(parsed);
  if (recordResult.success) {
    return [recordResult.data];
  }
  if (Array.isArray(parsed)) {
    return parsed.map(parseWorkbookRow);
  }
  throw new Error(`Rows JSON must be an object, row array, or array of rows/objects`);
}

function parseWorkbookRow(value: unknown): WorkbookInputRow {
  const rowResult = JsonRowSchema.safeParse(value);
  if (rowResult.success) {
    return rowResult.data;
  }
  const recordResult = JsonRecordSchema.safeParse(value);
  if (recordResult.success) {
    return recordResult.data;
  }
  throw new Error(`Rows JSON must be an object, row array, or array of rows/objects`);
}
