const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

export interface ParsedTimestamp {
  readonly epochMillis: number;
  /** Nanoseconds within the millisecond named by `epochMillis` (0-999999). */
  readonly nanosWithinMilli: number;
}

/**
 * Parse an OTel ISO-8601 timestamp that may carry more than millisecond
 * precision (e.g. `2026-08-28T03:05:46.542228853Z`, 9 fractional digits).
 * The fractional part is padded/truncated to a fixed 9-digit (nanosecond)
 * width instead of handed to `Date.parse`/`new Date()`, which silently
 * mis-parse or truncate beyond millisecond precision.
 */
export function parseNanoTimestamp(value: string): ParsedTimestamp {
  const match = TIMESTAMP_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid OTel timestamp "${value}"`);
  }
  const base = match[1];
  if (base === undefined) {
    throw new Error(`Invalid OTel timestamp "${value}"`);
  }
  const fraction = match[2] ?? "";
  const nanoDigits = fraction.padEnd(9, "0").slice(0, 9);
  const millisDigits = nanoDigits.slice(0, 3);
  const nanosWithinMilli = Number(nanoDigits.slice(3));
  const epochMillis = Date.parse(`${base}.${millisDigits}Z`);
  if (Number.isNaN(epochMillis)) {
    throw new Error(`Invalid OTel timestamp "${value}"`);
  }
  return { epochMillis, nanosWithinMilli };
}

/** Total nanoseconds since the Unix epoch, as a `bigint` to avoid float precision loss. */
export function toEpochNanos(value: string): bigint {
  const { epochMillis, nanosWithinMilli } = parseNanoTimestamp(value);
  return BigInt(epochMillis) * 1_000_000n + BigInt(nanosWithinMilli);
}
