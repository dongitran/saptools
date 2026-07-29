import { CfDebuggerError } from "./types.js";

export function readRequiredOption(
  value: string | undefined,
  flag: string,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", `Missing required option ${flag}.`);
  }
  return value;
}

export function parseOptionalInteger(
  raw: string | undefined,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      `${label} must be from ${minimum.toString()} to ${maximum.toString()}.`,
    );
  }
  return value;
}

export function parseSeconds(
  raw: string | undefined,
  label: string,
): number | undefined {
  const seconds = parseOptionalInteger(raw, label, 1);
  return seconds === undefined ? undefined : seconds * 1000;
}
