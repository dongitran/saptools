import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import {
  DEFAULT_CELL_LIMIT,
  DEFAULT_RESULT_SEARCH_LIMIT,
  MAX_CELL_LIMIT,
} from "./config.js";
import { CfHanaError } from "./errors.js";
import { formatCompactCsv } from "./format.js";
import { isTextLobType } from "./lob.js";
import {
  inspectJsonCell,
  readCellWindow,
  searchResultSession,
  selectResultCell,
  selectResultRow,
} from "./result-inspect.js";
import {
  clearResultSessions,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
} from "./result-store.js";
import type {
  QueryResult,
  QueryResultColumn,
  QueryRow,
  SqlParam,
} from "./types.js";

interface ShowOptions {
  readonly row?: number;
  readonly column?: string;
  readonly offset?: number;
  readonly length?: number;
  readonly path?: string;
}

interface SearchOptions {
  readonly row?: number;
  readonly column?: string;
  readonly limit?: number;
  readonly length?: number;
}

interface ExportOptions {
  readonly row?: number;
  readonly column?: string;
  readonly output?: string;
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CfHanaError("CONFIG", `Expected an integer but received "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new CfHanaError("CONFIG", `Expected a safe integer but received "${value}"`);
  }
  return parsed;
}

function positive(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CfHanaError("CONFIG", `${name} must be a positive safe integer`);
  }
  return resolved;
}

function boundedLength(value: number | undefined): number {
  const resolved = positive("--length", value, DEFAULT_CELL_LIMIT);
  if (resolved > MAX_CELL_LIMIT) {
    throw new CfHanaError("CONFIG", `--length must be at most ${String(MAX_CELL_LIMIT)}`);
  }
  return resolved;
}

function nonNegative(name: string, value: number | undefined): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new CfHanaError("CONFIG", `${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function resultFromRows(
  rows: readonly QueryRow[],
  columns: readonly QueryResultColumn[],
): QueryResult {
  return {
    rows,
    columns,
    rowCount: rows.length,
    statement: "select",
    truncated: false,
    elapsedMs: 0,
  };
}

function csv(rows: readonly QueryRow[], columns: readonly string[], limit: number): string {
  const result = resultFromRows(
    rows,
    columns.map((name) => ({ name, typeName: "" })),
  );
  return formatCompactCsv(result, limit).text;
}

async function runShow(ref: string, options: ShowOptions): Promise<void> {
  const session = await readResultSession(ref);
  const length = boundedLength(options.length);
  if (options.row === undefined) {
    if (
      options.column !== undefined ||
      options.path !== undefined ||
      options.offset !== undefined
    ) {
      throw new CfHanaError("CONFIG", "--column, --path, and --offset require --row");
    }
    print(summaryCsv(session, length));
    return;
  }
  if (options.column === undefined) {
    if (options.path !== undefined || options.offset !== undefined) {
      throw new CfHanaError("CONFIG", "--path and --offset require --column");
    }
    const row = selectResultRow(session, options.row);
    print(formatCompactCsv(resultFromRows([row], session.result.columns), length).text);
    return;
  }
  const selected = selectResultCell(session, options.row, options.column);
  if (options.path !== undefined) {
    const rows = inspectJsonCell(selected.value, options.path, length).map((row) => ({
      PATH: row.path,
      TYPE: row.type,
      VALUE: row.value,
    }));
    print(csv(rows, ["PATH", "TYPE", "VALUE"], length));
    return;
  }
  const window = readCellWindow(
    selected.value,
    nonNegative("--offset", options.offset),
    length,
    selected.typeName,
  );
  print(
    csv(
      [
        {
          ROW: selected.row,
          COLUMN: selected.column,
          TYPE: window.type,
          ORIGINAL_LENGTH: window.originalLength,
          OFFSET: window.offset,
          VALUE: window.value,
        },
      ],
      ["ROW", "COLUMN", "TYPE", "ORIGINAL_LENGTH", "OFFSET", "VALUE"],
      length,
    ),
  );
}

function summaryCsv(session: Awaited<ReturnType<typeof readResultSession>>, length: number): string {
  const compact = formatCompactCsv(session.result, DEFAULT_CELL_LIMIT);
  return csv(
    [
      {
        REF: session.ref,
        ROWS: session.result.rowCount,
        COLUMNS: session.result.columns.length,
        ROW_TRUNCATED: session.result.truncated,
        TRUNCATED_CELLS: compact.truncatedCells,
        EXPIRES_AT: session.expiresAt,
      },
    ],
    ["REF", "ROWS", "COLUMNS", "ROW_TRUNCATED", "TRUNCATED_CELLS", "EXPIRES_AT"],
    length,
  );
}

async function runSearch(ref: string, text: string, options: SearchOptions): Promise<void> {
  const session = await readResultSession(ref);
  const length = boundedLength(options.length);
  const matches = searchResultSession(session, text, {
    limit: positive("--limit", options.limit, DEFAULT_RESULT_SEARCH_LIMIT),
    previewLength: length,
    ...(options.row === undefined ? {} : { row: options.row }),
    ...(options.column === undefined ? {} : { column: options.column }),
  });
  const rows = matches.map((match) => ({
    ROW: match.row,
    COLUMN: match.column,
    OFFSET: match.offset ?? null,
    PATH: match.path,
    PREVIEW: match.preview,
  }));
  print(csv(rows, ["ROW", "COLUMN", "OFFSET", "PATH", "PREVIEW"], length));
}

function cellExportValue(value: SqlParam, typeName?: string): string | Buffer {
  if (Buffer.isBuffer(value)) {
    return isTextLobType(typeName) ? value.toString("utf8") : value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return value.toString();
}

async function runExport(ref: string, options: ExportOptions): Promise<void> {
  if (options.row === undefined || options.column === undefined) {
    throw new CfHanaError("CONFIG", "result export requires --row and --column");
  }
  if (options.output === undefined || options.output.trim().length === 0) {
    throw new CfHanaError("CONFIG", "result export requires --output");
  }
  const session = await readResultSession(ref);
  const selected = selectResultCell(session, options.row, options.column);
  await writeFile(options.output, cellExportValue(selected.value, selected.typeName), {
    mode: 0o600,
  });
  print(`wrote=${options.output}`);
}

async function runList(): Promise<void> {
  const summaries = await listResultSessions();
  const rows = summaries.map((summary) => ({
    REF: summary.ref,
    ROWS: summary.rowCount,
    COLUMNS: summary.columnCount,
    ROW_TRUNCATED: summary.truncated,
    EXPIRES_AT: summary.expiresAt,
  }));
  print(csv(rows, ["REF", "ROWS", "COLUMNS", "ROW_TRUNCATED", "EXPIRES_AT"], DEFAULT_CELL_LIMIT));
}

async function runPrune(): Promise<void> {
  print(`removed=${String(await pruneResultSessions())}`);
}

async function runClear(): Promise<void> {
  print(`removed=${String(await clearResultSessions())}`);
}

export function registerResultCommands(program: Command): void {
  const result = program.command("result").description("inspect saved query refs");
  result
    .command("show <ref>")
    .description("show a saved result, row, cell, or JSON path")
    .option("--row <n>", "one-based result row", parseIntOption)
    .option("--column <name>", "exact column name")
    .option("--offset <n>", "text code-point or binary byte offset", parseIntOption)
    .option("--length <n>", "maximum characters or bytes to print", parseIntOption)
    .option("--path <pointer>", "JSON Pointer inside a saved text cell")
    .action(async (ref: string, _options: unknown, command: Command) => {
      await runShow(ref, command.opts<ShowOptions>());
    });
  result
    .command("search <ref> <text>")
    .description("search saved text and JSON values")
    .option("--row <n>", "one-based result row", parseIntOption)
    .option("--column <name>", "exact column name")
    .option("--limit <n>", "maximum matches to print", parseIntOption)
    .option("--length <n>", "maximum preview characters", parseIntOption)
    .action(async (ref: string, text: string, _options: unknown, command: Command) => {
      await runSearch(ref, text, command.opts<SearchOptions>());
    });
  result
    .command("export <ref>")
    .description("write one exact saved cell to a file")
    .requiredOption("--output <path>", "output file path")
    .option("--row <n>", "one-based result row", parseIntOption)
    .option("--column <name>", "exact column name")
    .action(async (ref: string, _options: unknown, command: Command) => {
      await runExport(ref, command.opts<ExportOptions>());
    });
  result.command("list").description("list active saved refs").action(async () => {
    await runList();
  });
  result.command("prune").description("remove expired saved refs").action(async () => {
    await runPrune();
  });
  result.command("clear").description("remove all saved refs").action(async () => {
    await runClear();
  });
}
