import { createResultSession } from "@saptools/core";

import { CLI_NAME, MAX_RESULT_WINDOW, saptoolsRootFromEnv } from "../config.js";
import { CfLogSearchError, errorMessage } from "../errors.js";
import type { OutputRow } from "../format.js";
import { formatResult } from "../format.js";
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
  throw new CfLogSearchError("CONFIG", `Invalid --format "${value}" (expected table, json, json-compact, or csv)`);
}

function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CfLogSearchError("CONFIG", `Expected an integer but received "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new CfLogSearchError("CONFIG", `Expected a safe integer but received "${value}"`);
  }
  return parsed;
}

export function parseNonNegativeIntOption(value: string): number {
  const parsed = parseIntOption(value);
  if (parsed < 0) {
    throw new CfLogSearchError("CONFIG", `Expected a non-negative integer but received "${value}"`);
  }
  return parsed;
}

export function parsePositiveIntOption(value: string): number {
  const parsed = parseIntOption(value);
  if (parsed <= 0) {
    throw new CfLogSearchError("CONFIG", `Expected a positive integer but received "${value}"`);
  }
  return parsed;
}

export function collectRepeatable(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function checkUpperLimit(limit: number, flagName = "--limit"): void {
  if (limit > MAX_RESULT_WINDOW) {
    throw new CfLogSearchError(
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

async function saveRowsOrWarn(opts: EmitRowsOptions): Promise<string | undefined> {
  try {
    const root = saptoolsRootFromEnv();
    const session = await createResultSession(
      { cliName: CLI_NAME, command: opts.command, rows: opts.rows },
      root === undefined ? {} : { saptoolsRoot: root },
    );
    return session.ref;
  } catch (error) {
    printNotice(`--save failed (${errorMessage(error)}); printing the result instead`);
    process.exitCode = 1;
    return undefined;
  }
}

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
