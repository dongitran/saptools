import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { MAX_RESULT_STORE_BYTES } from "./config.js";
import { BackupRequiredError, QueryError } from "./errors.js";
import { formatCsv } from "./format.js";
import { assertParamArity, countPlaceholders, firstKeyword } from "./statements.js";
import type { QueryResult, SqlParam } from "./types.js";

const SAPTOOLS_DIR_NAME = ".saptools";
const CF_HANA_DIR_NAME = "cf-hana";
const BACKUPS_DIR_NAME = "backups";

export type WriteBackupOperation = "update" | "upsert" | "replace" | "merge" | "delete";

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
  readonly selector?: string;
}

export interface SqlBackupWriteOptions {
  readonly now?: Date;
  readonly saptoolsRoot?: string;
  readonly maxBytes?: number;
}

export interface SqlBackupRecord {
  readonly directory: string;
  readonly statementPath: string;
  readonly backupPath: string;
  readonly metadataPath: string;
  readonly rowCount: number;
}

interface TopLevelToken {
  readonly keyword: string;
  readonly start: number;
  readonly end: number;
}

interface ParsedTarget {
  readonly sql: string;
  readonly reference: string;
  readonly end: number;
}

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

function skipTrivia(sql: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    if (/\s/.test(sql.charAt(index))) {
      index += 1;
      continue;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    break;
  }
  return index;
}

function readIdentifierPart(
  sql: string,
  start: number,
  end: number,
): { readonly sql: string; readonly end: number } | undefined {
  const index = skipTrivia(sql, start, end);
  if (sql[index] === '"') {
    const next = skipQuotedText(sql, index);
    return next <= end && sql[next - 1] === '"'
      ? { sql: sql.slice(index, next), end: next }
      : undefined;
  }
  if (!/[A-Za-z_#$]/.test(sql.charAt(index))) {
    return undefined;
  }
  let next = index + 1;
  while (next < end && /[A-Za-z0-9_#$]/.test(sql.charAt(next))) {
    next += 1;
  }
  return { sql: sql.slice(index, next), end: next };
}

function readQualifiedTarget(sql: string, start: number, end: number): ParsedTarget | undefined {
  const first = readIdentifierPart(sql, start, end);
  if (first === undefined) {
    return undefined;
  }
  const parts = [first.sql];
  let cursor = first.end;
  while (parts.length < 3) {
    const dot = skipTrivia(sql, cursor, end);
    if (sql[dot] !== ".") {
      break;
    }
    const part = readIdentifierPart(sql, dot + 1, end);
    if (part === undefined) {
      return undefined;
    }
    parts.push(part.sql);
    cursor = part.end;
  }
  return { sql: parts.join("."), reference: parts.at(-1) ?? first.sql, end: cursor };
}

function topLevelTokens(sql: string): readonly TopLevelToken[] {
  const tokens: TopLevelToken[] = [];
  let index = 0;
  let depth = 0;
  while (index < sql.length) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const char = sql.charAt(index);
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (!/[A-Za-z_#$]/.test(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_#$]/.test(sql.charAt(end))) {
      end += 1;
    }
    if (depth === 0) {
      tokens.push({ keyword: sql.slice(index, end).toUpperCase(), start: index, end });
    }
    index = end;
  }
  return tokens;
}

function findToken(
  tokens: readonly TopLevelToken[],
  keyword: string,
  start = 0,
): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.keyword === keyword) {
      return index;
    }
  }
  return undefined;
}

function isMergeClauseStart(tokens: readonly TopLevelToken[], index: number): boolean {
  if (tokens[index]?.keyword !== "WHEN") {
    return false;
  }
  return (
    tokens[index + 1]?.keyword === "MATCHED" ||
    (tokens[index + 1]?.keyword === "NOT" && tokens[index + 2]?.keyword === "MATCHED")
  );
}

function mergeClauseIndexes(
  tokens: readonly TopLevelToken[],
  start: number,
): readonly number[] {
  const indexes: number[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    if (isMergeClauseStart(tokens, index)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function keywordMatches(sql: string, index: number, keyword: string): boolean {
  const end = index + keyword.length;
  return (
    sql.slice(index, end).toUpperCase() === keyword &&
    !isIdentifierChar(sql[index - 1]) &&
    !isIdentifierChar(sql[end])
  );
}

function findTopLevelKeyword(
  sql: string,
  keyword: string,
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

function findTopLevelChar(
  sql: string,
  target: string,
  startIndex: number,
  endIndex: number,
): number | undefined {
  let index = startIndex;
  let depth = 0;
  while (index < endIndex) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === target && depth === 0) {
      return index;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
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

function buildUpsertBackupPlan(
  statementSql: string,
  params: readonly SqlParam[],
  keyword: "UPSERT" | "REPLACE",
): WriteBackupPlan {
  const operation = keyword === "UPSERT" ? "upsert" : "replace";
  const keywordIndex = findTopLevelKeyword(statementSql, keyword);
  const target =
    keywordIndex === undefined
      ? undefined
      : readQualifiedTarget(statementSql, keywordIndex + keyword.length, statementSql.length);
  if (keywordIndex === undefined || target === undefined) {
    throw new BackupRequiredError(
      `${keyword} write refused: cannot derive a trustworthy backup target`,
    );
  }
  const valuesIndex =
    findTopLevelKeyword(statementSql, "VALUES", target.end);
  if (valuesIndex === undefined) {
    const selectIndex = findTopLevelKeyword(statementSql, "SELECT", target.end);
    const withIndex = findTopLevelKeyword(statementSql, "WITH", target.end);
    if (selectIndex === undefined && withIndex === undefined) {
      throw new BackupRequiredError(
        `${keyword} write refused: expected VALUES, WITH PRIMARY KEY, or a subquery`,
      );
    }
    return buildSelectPlan(operation, statementSql, target.sql, undefined, params);
  }

  const whereIndex = findTopLevelKeyword(statementSql, "WHERE", valuesIndex + "VALUES".length);
  return buildSelectPlan(
    operation,
    statementSql,
    target.sql,
    whereIndex,
    params,
  );
}

function mergeTargetReference(
  statementSql: string,
  target: ParsedTarget,
  usingStart: number,
): string | undefined {
  let suffix = statementSql.slice(target.end, usingStart).trim();
  if (suffix.length === 0) {
    return target.reference;
  }
  if (/^PARTITION\b/i.test(suffix)) {
    const open = suffix.indexOf("(");
    if (open === -1) {
      return undefined;
    }
    const close = findTopLevelChar(suffix, ")", open + 1, suffix.length);
    if (close === undefined) {
      return undefined;
    }
    suffix = suffix.slice(close + 1).trim();
    if (suffix.length === 0) {
      return target.reference;
    }
  }
  suffix = suffix.replace(/^AS\b/i, "").trim();
  const alias = readIdentifierPart(suffix, 0, suffix.length);
  if (alias === undefined || skipTrivia(suffix, alias.end, suffix.length) !== suffix.length) {
    return undefined;
  }
  return alias.sql;
}

function paramsInRange(
  sql: string,
  params: readonly SqlParam[],
  start: number,
  end: number,
): readonly SqlParam[] {
  const offset = countPlaceholders(sql.slice(0, start));
  const length = countPlaceholders(sql.slice(start, end));
  return params.slice(offset, offset + length);
}

function wholeTargetPlan(
  operation: WriteBackupOperation,
  statementSql: string,
  target: ParsedTarget,
): WriteBackupPlan {
  return buildSelectPlan(operation, statementSql, target.sql, undefined, []);
}

function buildExactMergePlan(
  statementSql: string,
  params: readonly SqlParam[],
  target: ParsedTarget,
  targetClause: string,
  sourceClause: string,
  sourceStart: number,
  targetClauseEnd: number,
  onCondition: string,
  matchedIndex: number,
  tokens: readonly TopLevelToken[],
): WriteBackupPlan | undefined {
  const targetReference = mergeTargetReference(statementSql, target, targetClauseEnd);
  const thenIndex = findToken(tokens, "THEN", matchedIndex + 2);
  if (targetReference === undefined || thenIndex === undefined) {
    return undefined;
  }
  const thenToken = tokens[thenIndex];
  const action = tokens[thenIndex + 1]?.keyword;
  if (thenToken === undefined || (action !== "UPDATE" && action !== "DELETE")) {
    return undefined;
  }
  const matchedToken = tokens[matchedIndex + 1];
  if (matchedToken === undefined) {
    return undefined;
  }
  const conditionToken = tokens[matchedIndex + 2];
  let matchedCondition = "";
  let conditionParams: readonly SqlParam[] = [];
  if (conditionToken?.keyword !== "THEN") {
    if (conditionToken?.keyword !== "AND") {
      return undefined;
    }
    matchedCondition = statementSql.slice(conditionToken.end, thenToken.start).trim();
    conditionParams = paramsInRange(statementSql, params, conditionToken.end, thenToken.start);
  }
  const clauseStart = tokens[matchedIndex]?.start ?? 0;
  const sourceParams = paramsInRange(statementSql, params, sourceStart, clauseStart);
  const conditionSql = matchedCondition.length === 0 ? "" : ` AND (${matchedCondition})`;
  return {
    operation: "merge",
    statementSql,
    selectSql:
      `SELECT ${targetReference}.* FROM ${targetClause} ` +
      `WHERE EXISTS (SELECT 1 FROM ${sourceClause} WHERE (${onCondition})${conditionSql})`,
    selectParams: [...sourceParams, ...conditionParams],
  };
}

function buildMergeBackupPlan(statementSql: string, params: readonly SqlParam[]): WriteBackupPlan | undefined {
  const tokens = topLevelTokens(statementSql);
  const intoIndex = findToken(tokens, "INTO", 1);
  const usingIndex = findToken(tokens, "USING", (intoIndex ?? 0) + 1);
  const onIndex = findToken(tokens, "ON", (usingIndex ?? 0) + 1);
  const into = intoIndex === undefined ? undefined : tokens[intoIndex];
  const using = usingIndex === undefined ? undefined : tokens[usingIndex];
  const on = onIndex === undefined ? undefined : tokens[onIndex];
  const target =
    into === undefined || using === undefined
      ? undefined
      : readQualifiedTarget(statementSql, into.end, using.start);
  if (
    into === undefined ||
    using === undefined ||
    onIndex === undefined ||
    on === undefined ||
    target === undefined
  ) {
    throw new BackupRequiredError(
      "MERGE write refused: cannot derive a trustworthy backup target",
    );
  }
  const clauses = mergeClauseIndexes(tokens, onIndex + 1);
  const matched = clauses.filter((index) => tokens[index + 1]?.keyword === "MATCHED");
  if (clauses.length === 0) {
    throw new BackupRequiredError("MERGE write refused: no supported WHEN clause was found");
  }
  if (matched.length === 0) {
    return undefined;
  }
  if (matched.length > 1) {
    return wholeTargetPlan("merge", statementSql, target);
  }
  const firstClause = tokens[clauses[0] ?? 0];
  const targetClause = statementSql.slice(into.end, using.start).trim();
  const sourceClause = statementSql.slice(using.end, on.start).trim();
  const onCondition = statementSql.slice(on.end, firstClause?.start).trim();
  if (sourceClause.length === 0 || onCondition.length === 0) {
    return wholeTargetPlan("merge", statementSql, target);
  }
  return (
    buildExactMergePlan(
      statementSql, params, target, targetClause, sourceClause,
      using.end, using.start, onCondition, matched[0] ?? 0, tokens,
    ) ?? wholeTargetPlan("merge", statementSql, target)
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

function backupMonth(now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

function sanitizePathPart(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "unknown-target";
}

function backupBaseName(input: SqlBackupWriteInput, now: Date): string {
  return [sanitizePathPart(input.selector), input.operation, backupTimestamp(now)].join("-");
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
  if (
    keyword !== "UPDATE" &&
    keyword !== "UPSERT" &&
    keyword !== "REPLACE" &&
    keyword !== "MERGE" &&
    keyword !== "DELETE"
  ) {
    return undefined;
  }

  assertParamArity(statementSql, params);
  if (keyword === "UPDATE") {
    return buildUpdateBackupPlan(statementSql, params);
  }
  if (keyword === "UPSERT" || keyword === "REPLACE") {
    return buildUpsertBackupPlan(statementSql, params, keyword);
  }
  if (keyword === "MERGE") {
    const tokens = topLevelTokens(statementSql);
    if (tokens[1]?.keyword === "DELTA") {
      return undefined;
    }
    if (tokens[1]?.keyword !== "INTO") {
      throw new BackupRequiredError("MERGE write refused: expected MERGE INTO syntax");
    }
    return buildMergeBackupPlan(statementSql, params);
  }
  return buildDeleteBackupPlan(statementSql, params);
}

export async function writeSqlBackup(
  input: SqlBackupWriteInput,
  options: SqlBackupWriteOptions = {},
): Promise<SqlBackupRecord> {
  const now = options.now ?? new Date();
  const directory = join(cfHanaBackupRoot(options.saptoolsRoot), backupMonth(now));
  const baseName = backupBaseName(input, now);
  const statementPath = join(directory, `${baseName}.statement.sql`);
  const backupPath = join(directory, `${baseName}.sql`);
  const metadataPath = join(directory, `${baseName}.json`);
  const metadata = {
    selector: input.selector ?? null,
    operation: input.operation,
    statementPath,
    backupPath,
    rowCount: input.result.rowCount,
    createdAt: now.toISOString(),
  };
  const csv = formatCsv(input.result);
  if (Buffer.byteLength(csv) > (options.maxBytes ?? MAX_RESULT_STORE_BYTES)) {
    throw new BackupRequiredError(
      "Write backup exceeds the storage limit; the write was refused",
    );
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(statementPath, `${input.statementSql}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(backupPath, csv, { encoding: "utf8", mode: 0o600 }),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);

  return {
    directory,
    statementPath,
    backupPath,
    metadataPath,
    rowCount: input.result.rowCount,
  };
}
