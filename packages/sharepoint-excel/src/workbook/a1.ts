export interface A1CellRef {
  readonly row: number;
  readonly column: number;
}

export interface A1RangeRef {
  readonly start: A1CellRef;
  readonly end: A1CellRef;
}

const CELL_REF_PATTERN = /^([A-Za-z]+)([1-9]\d*)$/;

export function columnNameToNumber(columnName: string): number {
  const normalized = columnName.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`Invalid column name "${columnName}"`);
  }
  let total = 0;
  for (const char of normalized) {
    total = total * 26 + char.charCodeAt(0) - 64;
  }
  return total;
}

export function parseA1Cell(input: string): A1CellRef {
  const trimmed = input.trim();
  const match = CELL_REF_PATTERN.exec(trimmed);
  if (match === null) {
    throw new Error(`Invalid A1 cell reference "${input}"`);
  }
  const columnName = match[1];
  const rowValue = match[2];
  if (columnName === undefined || rowValue === undefined) {
    throw new Error(`Invalid A1 cell reference "${input}"`);
  }
  return {
    row: Number.parseInt(rowValue, 10),
    column: columnNameToNumber(columnName),
  };
}

function orderRange(start: A1CellRef, end: A1CellRef): A1RangeRef {
  return {
    start: {
      row: Math.min(start.row, end.row),
      column: Math.min(start.column, end.column),
    },
    end: {
      row: Math.max(start.row, end.row),
      column: Math.max(start.column, end.column),
    },
  };
}

export function parseA1Range(input: string): A1RangeRef {
  const parts = input.split(":").map((part) => part.trim());
  if (parts.length === 1) {
    const cell = parseA1Cell(parts[0] ?? "");
    return { start: cell, end: cell };
  }
  if (parts.length !== 2) {
    throw new Error(`Invalid A1 range "${input}"`);
  }
  return orderRange(parseA1Cell(parts[0] ?? ""), parseA1Cell(parts[1] ?? ""));
}
