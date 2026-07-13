import { Command } from "commander";

import {
  enrichAndRethrowQueryError,
  rethrowWithPrivilegeHint,
} from "./002-cli-query-hints.js";
import { connect } from "./api.js";
import { registerResultCommands } from "./cli-results.js";
import type { HanaClient } from "./client.js";
import {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_AUTO_LIMIT,
  DEFAULT_CELL_LIMIT,
  MAX_CELL_LIMIT,
} from "./config.js";
import { CfHanaError, errorMessage } from "./errors.js";
import { formatCompactCsv, formatResult, formatTable } from "./format.js";
import { createResultSession, tryCreateResultSession } from "./result-store.js";
import type { ResultSession } from "./result-store.js";
import { classifyStatement } from "./statements.js";
import type {
  ConnectOptions,
  DbUserRole,
  HanaClientInfo,
  OutputFormat,
  QueryResult,
  QueryRow,
} from "./types.js";

interface ConnectionCliOptions {
  readonly refresh: boolean;
  readonly role: string;
  readonly binding?: string;
  readonly bindingIndex?: number;
  readonly readOnly: boolean;
  readonly allowDestructive: boolean;
  readonly timeout?: number;
  readonly limit?: number;
  readonly autoLimit: boolean;
  readonly refreshMetadata: boolean;
}

interface FormattedCliOptions extends ConnectionCliOptions {
  readonly format: string;
}

interface QueryCliOptions extends ConnectionCliOptions {
  readonly param?: readonly string[];
  readonly save: boolean;
  readonly autoSave: boolean;
  readonly format?: string;
  readonly cellLimit?: number;
  readonly resultTtlMinutes?: number;
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printResolvedTarget(info: HanaClientInfo): void {
  if (info.selectorSource !== "ambient") {
    process.stderr.write(`${CLI_NAME}: target ${info.selector} (explicit selector)\n`);
    return;
  }
  if (info.regionConfirmed === false) {
    process.stderr.write(
      `${CLI_NAME}: target ${info.selector} (resolved from ambient 'cf target'; ` +
        "region could not be mapped, so pin with a known region/org/space/app selector)\n",
    );
    return;
  }
  const pinHint = info.selectorCanBePinned === false
    ? "the resolved region is not accepted as an explicit selector"
    : `pass ${info.selector} to pin`;
  process.stderr.write(
    `${CLI_NAME}: target ${info.selector} (resolved from ambient 'cf target'; ${pinHint})\n`,
  );
}

async function connectForCli(selector: string, options: ConnectOptions): Promise<HanaClient> {
  const client = await connect(selector, options);
  printResolvedTarget(client.info);
  return client;
}

function fail(message: string): never {
  process.stderr.write(`${CLI_NAME}: ${message}\n`);
  process.exit(1);
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

function assertPositiveOption(name: string, value: number | undefined): void {
  if (value !== undefined && value <= 0) {
    throw new CfHanaError("CONFIG", `${name} must be a positive integer`);
  }
}

function assertNonNegativeOption(name: string, value: number | undefined): void {
  if (value !== undefined && value < 0) {
    throw new CfHanaError("CONFIG", `${name} must be a non-negative integer`);
  }
}

function collectParam(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function parseRole(role: string): DbUserRole {
  if (role === "runtime" || role === "hdi") {
    return role;
  }
  throw new CfHanaError("CONFIG", `Invalid --role "${role}" (expected runtime or hdi)`);
}

function parseFormat(format: string): OutputFormat {
  if (
    format === "table" ||
    format === "json" ||
    format === "json-compact" ||
    format === "csv"
  ) {
    return format;
  }
  throw new CfHanaError(
    "CONFIG",
    `Invalid --format "${format}" (expected table, json, json-compact, or csv)`,
  );
}

function parseQualifiedName(value: string): { readonly schema: string; readonly table: string } {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot >= value.length - 1) {
    throw new CfHanaError("CONFIG", `Expected schema.table but received "${value}"`);
  }
  return { schema: value.slice(0, dot), table: value.slice(dot + 1) };
}

function toConnectOptions(opts: ConnectionCliOptions): ConnectOptions {
  assertPositiveOption("--limit", opts.limit);
  assertPositiveOption("--timeout", opts.timeout);
  assertNonNegativeOption("--binding-index", opts.bindingIndex);

  return {
    refresh: opts.refresh,
    role: parseRole(opts.role),
    readOnly: opts.readOnly,
    allowDestructive: opts.allowDestructive,
    autoLimit: opts.autoLimit ? (opts.limit ?? DEFAULT_AUTO_LIMIT) : false,
    ...(opts.binding === undefined ? {} : { bindingName: opts.binding }),
    ...(opts.bindingIndex === undefined ? {} : { bindingIndex: opts.bindingIndex }),
    ...(opts.timeout === undefined
      ? {}
      : { queryTimeoutMs: opts.timeout, connectTimeoutMs: opts.timeout }),
  };
}

function resolveCellLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_CELL_LIMIT;
  assertPositiveOption("--cell-limit", limit);
  if (limit > MAX_CELL_LIMIT) {
    throw new CfHanaError("CONFIG", `--cell-limit must be at most ${String(MAX_CELL_LIMIT)}`);
  }
  return limit;
}

function assertQueryOptions(sql: string, opts: QueryCliOptions): void {
  resolveCellLimit(opts.cellLimit);
  assertPositiveOption("--result-ttl-minutes", opts.resultTtlMinutes);
  const isSelect = classifyStatement(sql) === "select";
  if (opts.save && !isSelect) {
    throw new CfHanaError("CONFIG", "--save is only available for SELECT/WITH statements");
  }
  if (opts.format !== undefined && !isSelect) {
    throw new CfHanaError("CONFIG", "--format is only available for SELECT/WITH statements");
  }
  if (opts.save && opts.format !== undefined) {
    throw new CfHanaError("CONFIG", "--save cannot be combined with --format");
  }
}

async function persistCompactResult(
  result: QueryResult,
  info: HanaClientInfo,
  opts: QueryCliOptions,
  truncatedCells: number,
): Promise<ResultSession | undefined> {
  const input = {
    result,
    info,
    ...(opts.resultTtlMinutes === undefined ? {} : { ttlMinutes: opts.resultTtlMinutes }),
  };
  if (opts.save) {
    const session = await createResultSession(input);
    print(`ref=${session.ref}`);
    return session;
  }
  if (!opts.autoSave || truncatedCells === 0) {
    return void 0;
  }
  return await tryCreateResultSession(input);
}

function printCompactionHint(
  truncatedCells: number,
  session: ResultSession | undefined,
  explicitlySaved: boolean,
): void {
  const prefix = `${CLI_NAME}: compacted ${String(truncatedCells)} cell(s);`;
  if (session === undefined) {
    process.stderr.write(`${prefix} rerun with --save or increase --cell-limit\n`);
    return;
  }
  const saved = explicitlySaved ? "" : ` exact values auto-saved as ${session.ref};`;
  process.stderr.write(
    `${prefix}${saved} inspect exact values with ` +
      `'${CLI_NAME} result show ${session.ref} --row <r> --column <c>' ` +
      "or increase --cell-limit\n",
  );
}

async function printSelectResult(
  result: QueryResult,
  info: HanaClientInfo,
  opts: QueryCliOptions,
  cellLimit: number,
  format: OutputFormat | undefined,
): Promise<void> {
  if (format === undefined) {
    const compact = formatCompactCsv(result, cellLimit);
    const session = await persistCompactResult(result, info, opts, compact.truncatedCells);
    print(compact.text);
    if (compact.truncatedCells > 0) {
      printCompactionHint(compact.truncatedCells, session, opts.save);
    }
  } else {
    print(formatResult(result, format));
  }
  if (result.truncated) {
    process.stderr.write(`${CLI_NAME}: row limit reached; rerun with --limit for more rows\n`);
  }
}

function rowsToResult(rows: readonly QueryRow[]): QueryResult {
  const first = rows[0];
  const columns =
    first === undefined
      ? []
      : Object.keys(first).map((name) => ({ name, typeName: "" }));
  return {
    rows,
    columns,
    rowCount: rows.length,
    statement: "select",
    truncated: false,
    elapsedMs: 0,
  };
}

function formatInfo(info: HanaClientInfo): string {
  return [
    `selector           ${info.selector}`,
    `app                ${info.appName}`,
    `host               ${info.host}`,
    `schema             ${info.schema}`,
    `role               ${info.role}`,
    `driver             ${info.driver}`,
    `credential source  ${info.credentialSource}`,
  ].join("\n");
}

function withConnectionOptions(command: Command): Command {
  return command
    .option("--refresh", "deprecated compatibility flag; binding discovery is already live", false)
    .option("--role <role>", "HANA user role: runtime or hdi", "runtime")
    .option("--binding <name>", "select a HANA binding by service name")
    .option("--binding-index <n>", "select a HANA binding by index", parseIntOption)
    .option("--read-only", "block every DML and DDL statement", false)
    .option("--allow-destructive", "permit destructive statements", false)
    .option("--timeout <ms>", "connection and query timeout in milliseconds", parseIntOption)
    .option("--limit <n>", "row cap auto-applied to bare SELECT statements", parseIntOption)
    .option("--no-auto-limit", "disable the automatic SELECT row cap")
    .option("--refresh-metadata", "bypass the 30-minute table/view metadata suggestion cache", false);
}

function withFormattedConnectionOptions(command: Command): Command {
  return withConnectionOptions(command).option(
    "--format <format>",
    "output format: table, json, json-compact, or csv",
    "table",
  );
}

async function runQuery(selector: string, sql: string, command: Command): Promise<void> {
  const opts = command.opts<QueryCliOptions>();
  assertQueryOptions(sql, opts);
  const cellLimit = resolveCellLimit(opts.cellLimit);
  const format = opts.format === undefined ? void 0 : parseFormat(opts.format);
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    const params = opts.param ?? [];
    let backup: Awaited<ReturnType<HanaClient["backupWriteStatement"]>>;
    try {
      backup = await client.backupWriteStatement(sql, params);
    } catch (error) {
      await enrichAndRethrowQueryError(error, client, sql, opts.refreshMetadata);
    }
    if (backup !== undefined) {
      process.stderr.write(`${CLI_NAME}: backup saved to ${backup.directory}\n`);
    }
    const result = await client.query(sql, params).catch(
      async (error: unknown): Promise<QueryResult> =>
        await enrichAndRethrowQueryError(error, client, sql, opts.refreshMetadata),
    );
    if (result.statement === "select") {
      await printSelectResult(result, client.info, opts, cellLimit, format);
      return;
    }
    print(formatTable(result));
  } finally {
    await client.close();
  }
}

async function runTables(
  selector: string,
  schema: string | undefined,
  command: Command,
): Promise<void> {
  const opts = command.opts<FormattedCliOptions>();
  const format = parseFormat(opts.format);
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    const resolvedSchema = schema ?? client.info.schema;
    const tables = await client.listTables(resolvedSchema).catch((error: unknown): never =>
      rethrowWithPrivilegeHint(error, client, resolvedSchema),
    );
    const rows: readonly QueryRow[] = tables.map((table) => ({
      SCHEMA: table.schema,
      TABLE: table.name,
      TYPE: table.type,
    }));
    print(formatResult(rowsToResult(rows), format, "TABLE"));
  } finally {
    await client.close();
  }
}

async function runColumns(selector: string, target: string, command: Command): Promise<void> {
  const opts = command.opts<FormattedCliOptions>();
  const { schema, table } = parseQualifiedName(target);
  const format = parseFormat(opts.format);
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    const columns = await client.listColumns(schema, table).catch((error: unknown): never =>
      rethrowWithPrivilegeHint(error, client, schema),
    );
    const rows: readonly QueryRow[] = columns.map((column) => ({
      COLUMN: column.name,
      TYPE: column.dataType,
      LENGTH: column.length ?? null,
      NULLABLE: column.nullable,
      POSITION: column.position,
    }));
    print(formatResult(rowsToResult(rows), format, "COLUMN"));
  } finally {
    await client.close();
  }
}

async function runCount(selector: string, target: string, command: Command): Promise<void> {
  const opts = command.opts<ConnectionCliOptions>();
  const { schema, table } = parseQualifiedName(target);
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    const total = await client.count({ schema, table }).catch((error: unknown): never =>
      rethrowWithPrivilegeHint(error, client, schema),
    );
    print(String(total));
  } finally {
    await client.close();
  }
}

async function runPing(selector: string, command: Command): Promise<void> {
  const opts = command.opts<ConnectionCliOptions>();
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    const started = Date.now();
    await client.query("SELECT 1 FROM DUMMY").catch((error: unknown): never =>
      rethrowWithPrivilegeHint(error, client, client.info.schema),
    );
    print(
      `OK  ${client.info.host}  schema=${client.info.schema}  ` +
        `${String(Date.now() - started)}ms`,
    );
  } finally {
    await client.close();
  }
}

async function runInfo(selector: string, command: Command): Promise<void> {
  const opts = command.opts<ConnectionCliOptions>();
  const client = await connectForCli(selector, toConnectOptions(opts));
  try {
    print(formatInfo(client.info));
  } finally {
    await client.close();
  }
}

const QUERY_OUTPUT_HELP = `
Output shapes:
  default SELECT: compact CSV (cells may be shortened to --cell-limit)
  --format json: [{COLUMN: value, ...}] (lossless)
  --format json-compact: [value, ...] for one column; multiple columns use objects
  --format csv: lossless RFC 4180 CSV
  --format table: lossless aligned table
`;
const TABLES_OUTPUT_HELP = `
JSON shapes:
  json: [{SCHEMA,TABLE,TYPE}]
  json-compact: [TABLE, ...]
`;
const COLUMNS_OUTPUT_HELP = `
JSON shapes:
  json: [{COLUMN,TYPE,LENGTH,NULLABLE,POSITION}]
  json-compact: [COLUMN, ...]
`;

function registerQueryCommand(program: Command): void {
  const command = program
    .command("query <selector> <sql>")
    .description("run a single SQL statement")
    .option("--param <value>", "bind a SQL parameter (repeatable)", collectParam, [])
    .option("--save", "save exact returned rows for follow-up inspection", false)
    .option("--no-auto-save", "do not auto-save exact rows when compact output truncates cells")
    .option("--format <format>", "lossless format: table, json, json-compact, or csv")
    .option("--cell-limit <n>", "maximum visible characters per data cell", parseIntOption)
    .option("--result-ttl-minutes <n>", "minutes before a saved result expires", parseIntOption)
    .addHelpText("after", QUERY_OUTPUT_HELP);
  withConnectionOptions(command).action(
    async (selector: string, sql: string, _options: unknown, action: Command) => {
      await runQuery(selector, sql, action);
    },
  );
}

function registerCatalogCommands(program: Command): void {
  const tables = program
    .command("tables <selector> [schema]")
    .description("list tables in a schema")
    .addHelpText("after", TABLES_OUTPUT_HELP);
  withFormattedConnectionOptions(tables).action(
    async (selector: string, schema: string | undefined, _options: unknown, action: Command) => {
      await runTables(selector, schema, action);
    },
  );
  const columns = program
    .command("columns <selector> <schema.table>")
    .description("list the columns of a table")
    .addHelpText("after", COLUMNS_OUTPUT_HELP);
  withFormattedConnectionOptions(columns).action(
    async (selector: string, target: string, _options: unknown, action: Command) => {
      await runColumns(selector, target, action);
    },
  );
}

function registerConnectionCommands(program: Command): void {
  withConnectionOptions(
    program.command("count <selector> <schema.table>").description("count rows in a table"),
  ).action(async (selector: string, target: string, _options: unknown, command: Command) => {
    await runCount(selector, target, command);
  });
  withConnectionOptions(
    program.command("ping <selector>").description("connect and measure round-trip latency"),
  ).action(async (selector: string, _options: unknown, command: Command) => {
    await runPing(selector, command);
  });
  withConnectionOptions(
    program.command("info <selector>").description("print the resolved connection metadata"),
  ).action(async (selector: string, _options: unknown, command: Command) => {
    await runInfo(selector, command);
  });
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description("Run SQL against SAP HANA Cloud databases bound to a Cloud Foundry app")
    .version(CLI_VERSION);
  registerQueryCommand(program);
  registerCatalogCommands(program);
  registerConnectionCommands(program);
  registerResultCommands(program);
  return program;
}

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  fail(errorMessage(error));
}
