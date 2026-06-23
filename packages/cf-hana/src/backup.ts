import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { QueryError } from "./errors.js";
import { formatCsv } from "./format.js";
import { assertParamArity, countPlaceholders, firstKeyword } from "./statements.js";
import type { QueryResult, SqlParam } from "./types.js";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_HANA_DIR_NAME = "cf-hana";
const BACKUPS_DIR_NAME = "backups";

export type WriteBackupOperation = "update" | "delete";

export interface WriteBackupPlan {
  readonly operation: WriteBackupOperation;
  readonly statementSql: string;
  readonly selectSql: string;
  readonly selectParams: readonly SqlParam[];
}

export interface SqlBackupWriteInput {
  readonly operation: WriteBackupOperation;
  readonly statementSql: string;
  readonly result: QueryResult;
}

export interface SqlBackupWriteOptions {
  readonly now?: Date;
  readonly saptoolsRoot?: string;
}

export interface SqlBackupRecord {
  readonly directory: string;
  readonly statementPath: string;
  readonly backupPath: string;
  readonly rowCount: number;
}

type TopLevelKeyword = "UPDATE" | "DELETE" | "SET" | "FROM" | "WHERE";

function defaultSaptoolsRoot(): string {
  return join(homedir(), SAPTOOLS_DIR_NAME);
}

function trimStatementSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "").trim();
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$#]/.test(char);
}

function skipQuotedText(sql: string, index: number): number {
  const quote = sql[index];
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
}

function skipLineComment(sql: string, index: number): number {
  let cursor = index + 2;
  while (cursor < sql.length && sql[cursor] !== "\n") {
    cursor += 1;
  }
  return cursor;
}

function skipBlockComment(sql: string, index: number): number {
  let cursor = index + 2;
  while (cursor < sql.length && !(sql[cursor] === "*" && sql[cursor + 1] === "/")) {
    cursor += 1;
  }
  return Math.min(cursor + 2, sql.length);
}

function skipNonCode(sql: string, index: number): number | undefined {
  const char = sql[index];
  if (char === "'" || char === '"') {
    return skipQuotedText(sql, index);
  }
  if (char === "-" && sql[index + 1] === "-") {
    return skipLineComment(sql, index);
  }
  if (char === "/" && sql[index + 1] === "*") {
    return skipBlockComment(sql, index);
  }
  return undefined;
}

function keywordMatches(sql: string, index: number, keyword: TopLevelKeyword): boolean {
  const end = index + keyword.length;
  return (
    sql.slice(index, end).toUpperCase() === keyword &&
    !isIdentifierChar(sql[index - 1]) &&
    !isIdentifierChar(sql[end])
  );
}

function findTopLevelKeyword(
  sql: string,
  keyword: TopLevelKeyword,
  startIndex = 0,
): number | undefined {
  let index = startIndex;
  let depth = 0;
  while (index < sql.length) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && keywordMatches(sql, index, keyword)) {
      return index;
    }
    index += 1;
  }
  return undefined;
}

function selectParamsAfterWhere(
  statementSql: string,
  whereIndex: number,
  params: readonly SqlParam[],
): readonly SqlParam[] {
  return params.slice(countPlaceholders(statementSql.slice(0, whereIndex)));
}

function buildSelectPlan(
  operation: WriteBackupOperation,
  statementSql: string,
  targetSql: string,
  whereIndex: number | undefined,
  params: readonly SqlParam[],
): WriteBackupPlan {
  const target = targetSql.trim();
  if (target.length === 0) {
    throw new QueryError(`${operation.toUpperCase()} backup requires a target table`);
  }
  if (whereIndex === undefined) {
    return { operation, statementSql, selectSql: `SELECT * FROM ${target}`, selectParams: [] };
  }

  const whereSql = statementSql.slice(whereIndex + "WHERE".length).trim();
  if (whereSql.length === 0) {
    throw new QueryError(`${operation.toUpperCase()} backup requires a non-empty WHERE clause`);
  }
  return {
    operation,
    statementSql,
    selectSql: `SELECT * FROM ${target} WHERE ${whereSql}`,
    selectParams: selectParamsAfterWhere(statementSql, whereIndex, params),
  };
}

function buildUpdateBackupPlan(
  statementSql: string,
  params: readonly SqlParam[],
): WriteBackupPlan {
  const updateIndex = findTopLevelKeyword(statementSql, "UPDATE");
  const setIndex =
    updateIndex === undefined
      ? undefined
      : findTopLevelKeyword(statementSql, "SET", updateIndex + "UPDATE".length);
  if (updateIndex === undefined || setIndex === undefined) {
    throw new QueryError("UPDATE backup requires UPDATE <target> SET syntax");
  }

  const whereIndex = findTopLevelKeyword(statementSql, "WHERE", setIndex + "SET".length);
  return buildSelectPlan(
    "update",
    statementSql,
    statementSql.slice(updateIndex + "UPDATE".length, setIndex),
    whereIndex,
    params,
  );
}

function buildDeleteBackupPlan(
  statementSql: string,
  params: readonly SqlParam[],
): WriteBackupPlan {
  const deleteIndex = findTopLevelKeyword(statementSql, "DELETE");
  const fromIndex =
    deleteIndex === undefined
      ? undefined
      : findTopLevelKeyword(statementSql, "FROM", deleteIndex + "DELETE".length);
  if (deleteIndex === undefined || fromIndex === undefined) {
    throw new QueryError("DELETE backup requires DELETE FROM <target> syntax");
  }

  const whereIndex = findTopLevelKeyword(statementSql, "WHERE", fromIndex + "FROM".length);
  const targetEnd = whereIndex ?? statementSql.length;
  return buildSelectPlan(
    "delete",
    statementSql,
    statementSql.slice(fromIndex + "FROM".length, targetEnd),
    whereIndex,
    params,
  );
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/:/g, "").replace(".", "");
}

function backupHash(statementSql: string): string {
  return createHash("sha256")
    .update(statementSql)
    .update("\0")
    .update(randomUUID())
    .digest("hex")
    .slice(0, 12);
}

export function cfHanaBackupRoot(saptoolsRoot?: string): string {
  return join(saptoolsRoot ?? defaultSaptoolsRoot(), CF_HANA_DIR_NAME, BACKUPS_DIR_NAME);
}

export function buildWriteBackupPlan(
  sql: string,
  params: readonly SqlParam[] = [],
): WriteBackupPlan | undefined {
  const statementSql = trimStatementSql(sql);
  const keyword = firstKeyword(statementSql);
  if (keyword !== "UPDATE" && keyword !== "DELETE") {
    return undefined;
  }

  assertParamArity(statementSql, params);
  if (keyword === "UPDATE") {
    return buildUpdateBackupPlan(statementSql, params);
  }
  return buildDeleteBackupPlan(statementSql, params);
}

export async function writeSqlBackup(
  input: SqlBackupWriteInput,
  options: SqlBackupWriteOptions = {},
): Promise<SqlBackupRecord> {
  const now = options.now ?? new Date();
  const directory = join(
    cfHanaBackupRoot(options.saptoolsRoot),
    `${backupTimestamp(now)}-${input.operation}-${backupHash(input.statementSql)}`,
  );
  const statementPath = join(directory, "statement.sql");
  const backupPath = join(directory, "backup.csv");

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(statementPath, `${input.statementSql}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(backupPath, formatCsv(input.result), { encoding: "utf8", mode: 0o600 }),
  ]);

  return {
    directory,
    statementPath,
    backupPath,
    rowCount: input.result.rowCount,
  };
}
