import { Command } from "commander";

import { connect } from "./api.js";
import { formatCurrentCfAppSelector, readCurrentCfTarget } from "./cf.js";
import { registerResultCommands } from "./cli-results.js";
import {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_AUTO_LIMIT,
  DEFAULT_CELL_LIMIT,
  MAX_CELL_LIMIT,
} from "./config.js";
import { CfHanaError, errorMessage } from "./errors.js";
import { formatCompactCsv, formatResult, formatTable } from "./format.js";
import { createResultSession } from "./result-store.js";
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
}

interface FormattedCliOptions extends ConnectionCliOptions {
  readonly format: string;
}

interface QueryCliOptions extends ConnectionCliOptions {
  readonly param?: readonly string[];
  readonly save: boolean;
  readonly cellLimit?: number;
  readonly resultTtlMinutes?: number;
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
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
  if (format === "table" || format === "json" || format === "csv") {
    return format;
  }
  throw new CfHanaError("CONFIG", `Invalid --format "${format}" (expected table, json, or csv)`);
}

function parseQualifiedName(value: string): { readonly schema: string; readonly table: string } {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot >= value.length - 1) {
    throw new CfHanaError("CONFIG", `Expected schema.table but received "${value}"`);
  }
  return { schema: value.slice(0, dot), table: value.slice(dot + 1) };
}

async function resolveSelectorArgument(selector: string): Promise<string> {
  if (selector.includes("/")) {
    return selector;
  }
  const current = await readCurrentCfTarget().catch((error: unknown) => {
    throw new CfHanaError(
      "CONFIG",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
      { cause: error },
    );
  });
  if (current === undefined) {
    throw new CfHanaError(
      "CONFIG",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
    );
  }
  return formatCurrentCfAppSelector(current, selector);
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
  if (opts.save && classifyStatement(sql) !== "select") {
    throw new CfHanaError("CONFIG", "--save is only available for SELECT/WITH statements");
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
    .option("--refresh", "bypass cached credentials and fetch them live", false)
    .option("--role <role>", "HANA user role: runtime or hdi", "runtime")
    .option("--binding <name>", "select a HANA binding by service name")
    .option("--binding-index <n>", "select a HANA binding by index", parseIntOption)
    .option("--read-only", "block every DML and DDL statement", false)
    .option("--allow-destructive", "permit destructive statements", false)
    .option("--timeout <ms>", "connection and query timeout in milliseconds", parseIntOption)
    .option("--limit <n>", "row cap auto-applied to bare SELECT statements", parseIntOption)
    .option("--no-auto-limit", "disable the automatic SELECT row cap");
}

function withFormattedConnectionOptions(command: Command): Command {
  return withConnectionOptions(command).option(
    "--format <format>",
    "output format: table, json, or csv",
    "table",
  );
}

async function runQuery(selector: string, sql: string, command: Command): Promise<void> {
  const opts = command.opts<QueryCliOptions>();
  assertQueryOptions(sql, opts);
  const cellLimit = resolveCellLimit(opts.cellLimit);
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    const params = opts.param ?? [];
    const backup = await client.backupWriteStatement(sql, params);
    if (backup !== undefined) {
      process.stderr.write(`${CLI_NAME}: backup saved to ${backup.directory}\n`);
    }
    const result = await client.query(sql, params);
    if (result.statement === "select") {
      const compact = formatCompactCsv(result, cellLimit);
      if (opts.save) {
        const session = await createResultSession({
          result,
          info: client.info,
          ...(opts.resultTtlMinutes === undefined ? {} : { ttlMinutes: opts.resultTtlMinutes }),
        });
        print(`ref=${session.ref}`);
        process.stderr.write(`${CLI_NAME}: saved result expires at ${session.expiresAt}\n`);
      }
      print(compact.text);
      if (result.truncated) {
        process.stderr.write(`${CLI_NAME}: row limit reached; rerun with --limit for more rows\n`);
      }
      if (compact.truncatedCells > 0) {
        process.stderr.write(
          `${CLI_NAME}: compacted ${String(compact.truncatedCells)} cell(s); ` +
            "use --save to inspect exact values by ref\n",
        );
      }
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
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    const tables = await client.listTables(schema ?? client.info.schema);
    const rows: readonly QueryRow[] = tables.map((table) => ({
      SCHEMA: table.schema,
      TABLE: table.name,
      TYPE: table.type,
    }));
    print(formatResult(rowsToResult(rows), parseFormat(opts.format)));
  } finally {
    await client.close();
  }
}

async function runColumns(selector: string, target: string, command: Command): Promise<void> {
  const opts = command.opts<FormattedCliOptions>();
  const { schema, table } = parseQualifiedName(target);
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    const columns = await client.listColumns(schema, table);
    const rows: readonly QueryRow[] = columns.map((column) => ({
      COLUMN: column.name,
      TYPE: column.dataType,
      LENGTH: column.length ?? null,
      NULLABLE: column.nullable,
      POSITION: column.position,
    }));
    print(formatResult(rowsToResult(rows), parseFormat(opts.format)));
  } finally {
    await client.close();
  }
}

async function runCount(selector: string, target: string, command: Command): Promise<void> {
  const opts = command.opts<ConnectionCliOptions>();
  const { schema, table } = parseQualifiedName(target);
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    const total = await client.count({ schema, table });
    print(String(total));
  } finally {
    await client.close();
  }
}

async function runPing(selector: string, command: Command): Promise<void> {
  const opts = command.opts<ConnectionCliOptions>();
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    const started = Date.now();
    await client.query("SELECT 1 FROM DUMMY");
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
  const client = await connect(await resolveSelectorArgument(selector), toConnectOptions(opts));
  try {
    print(formatInfo(client.info));
  } finally {
    await client.close();
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description("Run SQL against SAP HANA Cloud databases bound to a Cloud Foundry app")
    .version(CLI_VERSION);

  withConnectionOptions(
    program
      .command("query <selector> <sql>")
      .description("run a single SQL statement")
      .option("--param <value>", "bind a SQL parameter (repeatable)", collectParam, [])
      .option("--save", "save exact returned rows for follow-up inspection", false)
      .option("--cell-limit <n>", "maximum visible characters per data cell", parseIntOption)
      .option(
        "--result-ttl-minutes <n>",
        "minutes before a saved result expires",
        parseIntOption,
      ),
  ).action(async (selector: string, sql: string, _options: unknown, command: Command) => {
    await runQuery(selector, sql, command);
  });

  withFormattedConnectionOptions(
    program.command("tables <selector> [schema]").description("list tables in a schema"),
  ).action(
    async (selector: string, schema: string | undefined, _options: unknown, command: Command) => {
      await runTables(selector, schema, command);
    },
  );

  withFormattedConnectionOptions(
    program
      .command("columns <selector> <schema.table>")
      .description("list the columns of a table"),
  ).action(async (selector: string, target: string, _options: unknown, command: Command) => {
    await runColumns(selector, target, command);
  });

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

  registerResultCommands(program);

  return program;
}

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  fail(errorMessage(error));
}
