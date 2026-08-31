import { CLI_NAME, MAX_RESULT_WINDOW } from "../config.js";
import { CfMetricsError } from "../errors.js";
import type { OutputRow } from "../format.js";
import { formatResult } from "../format.js";
import { createResultSession, resultStoreOptionsFromEnv } from "../result-store.js";
import type { OutputFormat } from "../types.js";

export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function printNotice(text: string): void {
  process.stderr.write(`${CLI_NAME}: ${text}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`${CLI_NAME}: ${message}\n`);
  process.exit(1);
}

export function parseFormat(value: string | undefined, fallback: OutputFormat = "table"): OutputFormat {
  if (value === undefined) {
    return fallback;
  }
  if (value === "table" || value === "json" || value === "json-compact" || value === "csv") {
    return value;
  }
  throw new CfMetricsError("CONFIG", `Invalid --format "${value}" (expected table, json, json-compact, or csv)`);
}

function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CfMetricsError("CONFIG", `Expected an integer but received "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new CfMetricsError("CONFIG", `Expected a safe integer but received "${value}"`);
  }
  return parsed;
}

/** For row-count-style options (--limit): 0 means "no limit" (handled by each command), a negative count has no sensible meaning. */
export function parseNonNegativeIntOption(value: string): number {
  const parsed = parseIntOption(value);
  if (parsed < 0) {
    throw new CfMetricsError("CONFIG", `Expected a non-negative integer but received "${value}"`);
  }
  return parsed;
}

/** For duration-style options (--interval): 0 or negative has no sensible meaning. */
export function parsePositiveIntOption(value: string): number {
  const parsed = parseIntOption(value);
  if (parsed <= 0) {
    throw new CfMetricsError("CONFIG", `Expected a positive integer but received "${value}"`);
  }
  return parsed;
}

export function collectRepeatable(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

/**
 * Fail fast when a `--limit` value would ask OpenSearch's `terms`
 * aggregation (or a raw `_search` page) for more than a single page can
 * return, before any network call. Shared by every command with an
 * upper-bounded `--limit` (`sample`, `names`, `top`) so an oversized value
 * fails fast with a clear message instead of an expensive round trip that
 * risks OpenSearch's own bucket-count circuit breaker. Callers that also
 * treat `0` as "no limit" (`names`/`top`) check that separately — this only
 * enforces the ceiling.
 */
export function checkUpperLimit(limit: number, flagName = "--limit"): void {
  if (limit > MAX_RESULT_WINDOW) {
    throw new CfMetricsError(
      "CONFIG",
      `${flagName} ${String(limit)} exceeds OpenSearch's single-page result-window ceiling of ${String(MAX_RESULT_WINDOW)}; pass a smaller ${flagName}`,
    );
  }
}

export interface EmitRowsOptions {
  readonly command: string;
  readonly rows: readonly OutputRow[];
  readonly format: OutputFormat;
  readonly save: boolean;
  readonly compactColumn?: string;
}

/** Either print rows in the requested format, or save them and print a `ref=...` line. */
export async function emitRows(opts: EmitRowsOptions): Promise<void> {
  if (opts.save) {
    const session = await createResultSession({ command: opts.command, rows: opts.rows }, resultStoreOptionsFromEnv());
    print(`ref=${session.ref}`);
    return;
  }
  print(formatResult(opts.rows, opts.format, opts.compactColumn));
}
