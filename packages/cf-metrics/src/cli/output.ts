import { CLI_NAME, MAX_RESULT_WINDOW } from "../config.js";
import { CfMetricsError, errorMessage } from "../errors.js";
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
/**
 * Wording for a `terms` cap that dropped buckets. Shared so `names` and
 * `snapshot` cannot drift apart, and phrased around *what was lost*: because
 * neither aggregation sets an explicit `order`, OpenSearch keeps the
 * highest-`doc_count` buckets, so the ones missing are the sparsest — usually
 * the rarely-written custom metric the reader came looking for.
 */
export function truncationNotice(noun: string, limit: number): string {
  return (
    `showing ${String(limit)} of more ${noun} — the rest were dropped, sparsest first. ` +
    `Re-run with a larger --limit, or --limit 0 to see all ${noun}.`
  );
}

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

/**
 * Save the rows, or explain why not and let the caller print them instead.
 *
 * A store that cannot be written — a read-only or full home directory, a
 * permissions change — used to throw straight out of `emitRows`, which meant
 * the rows were never printed either: the ~30s credential round trip and the
 * query were both thrown away over a caching problem. The exit code carries
 * the failure so `ref=$(cf-metrics … --save)` cannot silently bind a table
 * row, while the data itself still reaches the user.
 */
async function saveRowsOrWarn(opts: EmitRowsOptions): Promise<string | undefined> {
  try {
    const session = await createResultSession({ command: opts.command, rows: opts.rows }, resultStoreOptionsFromEnv());
    return session.ref;
  } catch (error) {
    printNotice(`--save failed (${errorMessage(error)}); printing the result instead`);
    // Set the exit code rather than rethrowing: the top-level handler in
    // `cli.ts` would print and exit without ever reaching the rows below.
    process.exitCode = 1;
    return undefined;
  }
}

/** Either print rows in the requested format, or save them and print a `ref=...` line. */
export async function emitRows(opts: EmitRowsOptions): Promise<void> {
  if (opts.save) {
    const ref = await saveRowsOrWarn(opts);
    if (ref !== undefined) {
      print(`ref=${ref}`);
      return;
    }
  }
  print(formatResult(opts.rows, opts.format, opts.compactColumn));
}
