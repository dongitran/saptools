import { CfInspectorError } from "../types.js";
import type { VariableSnapshot } from "../types.js";

export const DEFAULT_MAX_VALUE_LENGTH = 4096;

export function isPrimitive(value: unknown): value is string | number | boolean | bigint | symbol {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "symbol";
}

export function formatPrimitive(value: string | number | boolean | bigint | symbol): string {
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  return String(value);
}

export function resolveMaxValueLength(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_VALUE_LENGTH;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new CfInspectorError(
      "INVALID_ARGUMENT",
      `Invalid maxValueLength: ${value.toString()} — expected a positive integer`,
    );
  }
  return value;
}

export function limitValueLength(raw: string, maxValueLength = DEFAULT_MAX_VALUE_LENGTH): string {
  if (raw.length <= maxValueLength) {
    return raw;
  }
  return `${raw.slice(0, maxValueLength)}...`;
}

function parseQuotedString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function parseNumericIndex(name: string): number | undefined {
  const parsed = Number.parseInt(name, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed.toString() !== name) {
    return undefined;
  }
  return parsed;
}

function scalarFromVariable(variable: VariableSnapshot): unknown {
  const value = variable.value;
  if (variable.type === "string") {
    return parseQuotedString(value);
  }
  if (variable.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (variable.type === "boolean") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  if (variable.type === "undefined") {
    return "[undefined]";
  }
  if (variable.type === "bigint") {
    return value;
  }
  return value === "null" ? null : value;
}

function isArrayLikeChildren(children: readonly VariableSnapshot[]): boolean {
  let hasNumeric = false;
  for (const child of children) {
    // V8 includes `length` as an own property on arrays; ignore it when
    // deciding whether the children look array-shaped.
    if (child.name === "length") {
      continue;
    }
    if (parseNumericIndex(child.name) === undefined) {
      return false;
    }
    hasNumeric = true;
  }
  return hasNumeric;
}

export function toStructuredValue(variable: VariableSnapshot): unknown {
  const children = variable.children;
  if (children === undefined || children.length === 0) {
    return scalarFromVariable(variable);
  }
  if (isArrayLikeChildren(children)) {
    const indexed = children.flatMap((child): readonly [number, unknown][] => {
      const index = parseNumericIndex(child.name);
      if (index === undefined) {
        // length entry; not part of the array body
        return [];
      }
      return [[index, toStructuredValue(child)]];
    });
    const maxIndex = Math.max(...indexed.map(([index]) => index));
    const out = Array.from({ length: maxIndex + 1 }, () => null as unknown);
    for (const [index, entry] of indexed) {
      out[index] = entry;
    }
    return out;
  }
  // Mixed numeric + string keys, or pure string keys: keep all children as
  // an object so non-indexed properties are not silently dropped.
  const out: Record<string, unknown> = {};
  for (const child of children) {
    out[child.name] = toStructuredValue(child);
  }
  return out;
}
