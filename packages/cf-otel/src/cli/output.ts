import { CLI_NAME } from "../config.js";
import { CfOtelError, errorMessage } from "../errors.js";
import type { OutputRow } from "../format.js";
import { formatResult } from "../format.js";
import type { ResultSession } from "../result-store.js";
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
  throw new CfOtelError("CONFIG", `Invalid --format "${value}" (expected table, json, json-compact, or csv)`);
}

export function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CfOtelError("CONFIG", `Expected an integer but received "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new CfOtelError("CONFIG", `Expected a safe integer but received "${value}"`);
  }
  return parsed;
}

/** For row-count-style options (--limit/--top): 0 means "no limit" (handled by each command), a negative count has no sensible meaning. */
export function parseNonNegativeIntOption(value: string): number {
  const parsed = parseIntOption(value);
  if (parsed < 0) {
    throw new CfOtelError("CONFIG", `Expected a non-negative integer but received "${value}"`);
  }
  return parsed;
}

export function collectRepeatable(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function parseTraceIds(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  return ids.length === 0 ? undefined : ids;
}

export interface EmitRowsOptions {
  readonly command: string;
  readonly rows: readonly OutputRow[];
  readonly format: OutputFormat;
  readonly save: boolean;
  readonly compactColumn?: string;
}

/**
 * Save rows and print a `ref=...` line, falling back to printing them.
 *
 * The rows are the product of a query that can take tens of seconds against a
 * real tenant, so discarding them because the store cannot be written throws away
 * the expensive half of the work. Failing quietly is not an option either:
 * `ref=` is a machine-readable contract, and in `ref=$(cf-otel find --save)`
 * an exit code of 0 with a table on stdout would bind a table row as if it
 * were a ref. Printing the data and still failing the exit code keeps the
 * result available to a human and the failure visible to a script.
 */
async function saveRowsOrWarn(opts: EmitRowsOptions): Promise<ResultSession | undefined> {
  try {
    return await createResultSession({ command: opts.command, rows: opts.rows }, resultStoreOptionsFromEnv());
  } catch (error) {
    printNotice(`--save failed (${errorMessage(error)}); printing the result instead`);
    // Set the exit code instead of throwing: the top-level handler in cli.ts
    // would print this message and exit without ever reaching the rows below.
    process.exitCode = 1;
    return undefined;
  }
}

/** Either print rows in the requested format, or save them and print a `ref=...` line. */
export async function emitRows(opts: EmitRowsOptions): Promise<void> {
  if (opts.save) {
    const session = await saveRowsOrWarn(opts);
    if (session !== undefined) {
      print(`ref=${session.ref}`);
      return;
    }
  }
  print(formatResult(opts.rows, opts.format, opts.compactColumn));
}

/**
 * Rejected here rather than at the query, because an empty id costs a full CF
 * login and credential discovery — tens of seconds — before returning an empty
 * result that reads exactly like "not found". {@link parseTraceIds} drops an
 * all-empty list for the same reason.
 */
export function assertRequestIdUsable(value: string | undefined): void {
  if (value?.trim().length === 0) {
    throw new CfOtelError(
      "CONFIG",
      "--vcap-request-id was empty; pass the id from a log row's vcapRequestId field.",
    );
  }
}
