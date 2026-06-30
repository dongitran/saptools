import { isTextLobType } from "./lob.js";
import type { SqlParam } from "./types.js";

export type PreviewUnit = "chars" | "bytes";

export interface CellPreview {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly unit: PreviewUnit;
}

function normalizePreviewChar(value: string): string {
  return value === "\r" || value === "\n" || value === "\t" ? " " : value;
}

function previewText(value: string, limit: number): CellPreview {
  let originalLength = 0;
  let text = "";
  for (const char of value) {
    if (originalLength < limit) {
      text += normalizePreviewChar(char);
    }
    originalLength += 1;
  }
  return {
    text,
    truncated: originalLength > limit,
    originalLength,
    unit: "chars",
  };
}

function previewBuffer(value: Buffer, limit: number): CellPreview {
  const fullLength = 2 + value.length * 2;
  const visibleBytes = Math.max(0, Math.floor((limit - 2) / 2));
  const hex = value.subarray(0, visibleBytes).toString("hex");
  return {
    text: `0x${hex}`.slice(0, limit),
    truncated: fullLength > limit,
    originalLength: value.length,
    unit: "bytes",
  };
}

function scalarText(value: Exclude<SqlParam, string | Buffer | null>): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return value.toString();
}

/** Produce a bounded, single-line representation of one result cell. */
export function previewCell(value: SqlParam, limit: number, typeName?: string): CellPreview {
  if (value === null) {
    return { text: "", truncated: false, originalLength: 0, unit: "chars" };
  }
  if (Buffer.isBuffer(value)) {
    return isTextLobType(typeName)
      ? previewText(value.toString("utf8"), limit)
      : previewBuffer(value, limit);
  }
  if (typeof value === "string") {
    return previewText(value, limit);
  }
  return previewText(scalarText(value), limit);
}
