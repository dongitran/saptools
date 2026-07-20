import { createHash } from "node:crypto";

import type { CanonicalState, JsonValue } from "./contracts.js";
import { redactValue } from "./redaction.js";
import { defineOwnValue } from "./safe-record.js";

function normalizeNumber(value: number): JsonValue {
  if (Number.isFinite(value)) {
    return Object.is(value, -0) ? { kind: "special-number", value: "-0" } : value;
  }
  return { kind: "special-number", value: String(value) };
}

function normalizeRecord(value: object): JsonValue {
  const output: Record<string, JsonValue> = {};
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [key, child] of entries) {
    defineOwnValue(output, key, normalizeValue(child));
  }
  return output;
}

function normalizeValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return normalizeNumber(value);
  }
  if (typeof value === "undefined") {
    return { kind: "undefined" };
  }
  if (typeof value === "bigint") {
    return { kind: "bigint", value: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === "object") {
    return normalizeRecord(value);
  }
  return { kind: "unavailable", description: typeof value };
}

export function canonicalizeState(value: unknown): CanonicalState {
  const normalized = normalizeValue(redactValue(value));
  const text = JSON.stringify(normalized);
  return {
    value: normalized,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}
