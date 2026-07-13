import {
  findToken,
  findTopLevelChar,
  findTopLevelKeyword,
  readIdentifierPart,
  readQualifiedTarget,
  skipTrivia,
  topLevelTokens,
} from "./003-backup-sql-parser.js";
import type { ParsedTarget, TopLevelToken } from "./003-backup-sql-parser.js";
import { BackupRequiredError, QueryError } from "./errors.js";
import { assertParamArity, countPlaceholders, firstKeyword } from "./statements.js";
import type { SqlParam } from "./types.js";

export type WriteBackupOperation = "update" | "upsert" | "replace" | "merge" | "delete";

export interface WriteBackupPlan {
  readonly operation: WriteBackupOperation;
  readonly statementSql: string;
  readonly selectSql: string;
  readonly selectParams: readonly SqlParam[];
}

interface ParsedMerge {
  readonly tokens: readonly TopLevelToken[];
  readonly into: TopLevelToken;
  readonly using: TopLevelToken;
  readonly on: TopLevelToken;
  readonly target: ParsedTarget;
  readonly clauseIndexes: readonly number[];
  readonly matchedIndexes: readonly number[];
  readonly targetClause: string;
  readonly sourceClause: string;
  readonly onCondition: string;
}

interface ParsedMatchedClause {
  readonly clauseStart: number;
  readonly matchedCondition: string;
  readonly conditionParams: readonly SqlParam[];
}

interface MatchedActionTokens {
  readonly thenToken: TopLevelToken;
  readonly conditionToken: TopLevelToken | undefined;
  readonly clauseStart: number;
}

type WriteKeyword = "UPDATE" | "UPSERT" | "REPLACE" | "MERGE" | "DELETE";

const WRITE_KEYWORDS = new Set<string>([
  "UPDATE",
  "UPSERT",
  "REPLACE",
  "MERGE",
  "DELETE",
]);
const MERGE_MODIFY_ACTIONS = new Set<string>(["UPDATE", "DELETE"]);

function trimStatementSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "").trim();
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
  const valuesIndex = findTopLevelKeyword(statementSql, "VALUES", target.end);
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
  return buildSelectPlan(operation, statementSql, target.sql, whereIndex, params);
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

function readRequiredMergeToken(
  tokens: readonly TopLevelToken[],
  keyword: string,
  start: number,
): { readonly index: number; readonly token: TopLevelToken } {
  const index = findToken(tokens, keyword, start);
  const token = index === undefined ? undefined : tokens[index];
  if (index === undefined || token === undefined) {
    throw new BackupRequiredError(
      "MERGE write refused: cannot derive a trustworthy backup target",
    );
  }
  return { index, token };
}

function parseMerge(statementSql: string): ParsedMerge {
  const tokens = topLevelTokens(statementSql);
  const into = readRequiredMergeToken(tokens, "INTO", 1);
  const using = readRequiredMergeToken(tokens, "USING", into.index + 1);
  const on = readRequiredMergeToken(tokens, "ON", using.index + 1);
  const target = readQualifiedTarget(statementSql, into.token.end, using.token.start);
  if (target === undefined) {
    throw new BackupRequiredError(
      "MERGE write refused: cannot derive a trustworthy backup target",
    );
  }
  const clauseIndexes = mergeClauseIndexes(tokens, on.index + 1);
  if (clauseIndexes.length === 0) {
    throw new BackupRequiredError("MERGE write refused: no supported WHEN clause was found");
  }
  const firstClause = tokens[clauseIndexes[0] ?? 0];
  return {
    tokens,
    into: into.token,
    using: using.token,
    on: on.token,
    target,
    clauseIndexes,
    matchedIndexes: clauseIndexes.filter((index) => tokens[index + 1]?.keyword === "MATCHED"),
    targetClause: statementSql.slice(into.token.end, using.token.start).trim(),
    sourceClause: statementSql.slice(using.token.end, on.token.start).trim(),
    onCondition: statementSql.slice(on.token.end, firstClause?.start).trim(),
  };
}

function readMatchedActionTokens(
  tokens: readonly TopLevelToken[],
  matchedIndex: number,
): MatchedActionTokens | undefined {
  const thenIndex = findToken(tokens, "THEN", matchedIndex + 2);
  if (thenIndex === undefined) {
    return undefined;
  }
  const thenToken = tokens[thenIndex];
  const actionToken = tokens[thenIndex + 1];
  const matchedToken = tokens[matchedIndex + 1];
  if (thenToken === undefined || actionToken === undefined || matchedToken === undefined) {
    return undefined;
  }
  if (!MERGE_MODIFY_ACTIONS.has(actionToken.keyword)) {
    return undefined;
  }
  const clauseToken = tokens[matchedIndex];
  return {
    thenToken,
    conditionToken: tokens[matchedIndex + 2],
    clauseStart: clauseToken === undefined ? 0 : clauseToken.start,
  };
}

function parseMatchedClause(
  statementSql: string,
  params: readonly SqlParam[],
  tokens: readonly TopLevelToken[],
  matchedIndex: number,
): ParsedMatchedClause | undefined {
  const action = readMatchedActionTokens(tokens, matchedIndex);
  if (action?.conditionToken === undefined) {
    return undefined;
  }
  if (action.conditionToken.keyword === "THEN") {
    return { clauseStart: action.clauseStart, matchedCondition: "", conditionParams: [] };
  }
  if (action.conditionToken.keyword !== "AND") {
    return undefined;
  }
  return {
    clauseStart: action.clauseStart,
    matchedCondition: statementSql.slice(action.conditionToken.end, action.thenToken.start).trim(),
    conditionParams: paramsInRange(
      statementSql,
      params,
      action.conditionToken.end,
      action.thenToken.start,
    ),
  };
}

function buildExactMergePlan(
  statementSql: string,
  params: readonly SqlParam[],
  merge: ParsedMerge,
  matchedIndex: number,
): WriteBackupPlan | undefined {
  const targetReference = mergeTargetReference(statementSql, merge.target, merge.using.start);
  const matchedClause = parseMatchedClause(statementSql, params, merge.tokens, matchedIndex);
  if (targetReference === undefined || matchedClause === undefined) {
    return undefined;
  }
  const sourceParams = paramsInRange(
    statementSql,
    params,
    merge.using.end,
    matchedClause.clauseStart,
  );
  const conditionSql = matchedClause.matchedCondition.length === 0
    ? ""
    : ` AND (${matchedClause.matchedCondition})`;
  return {
    operation: "merge",
    statementSql,
    selectSql:
      `SELECT ${targetReference}.* FROM ${merge.targetClause} ` +
      `WHERE EXISTS (SELECT 1 FROM ${merge.sourceClause} ` +
      `WHERE (${merge.onCondition})${conditionSql})`,
    selectParams: [...sourceParams, ...matchedClause.conditionParams],
  };
}

function buildMergeBackupPlan(
  statementSql: string,
  params: readonly SqlParam[],
): WriteBackupPlan | undefined {
  const merge = parseMerge(statementSql);
  if (merge.matchedIndexes.length === 0) {
    return undefined;
  }
  if (merge.matchedIndexes.length > 1) {
    return wholeTargetPlan("merge", statementSql, merge.target);
  }
  if (merge.sourceClause.length === 0 || merge.onCondition.length === 0) {
    return wholeTargetPlan("merge", statementSql, merge.target);
  }
  const matchedIndex = merge.matchedIndexes[0] ?? 0;
  return (
    buildExactMergePlan(statementSql, params, merge, matchedIndex) ??
    wholeTargetPlan("merge", statementSql, merge.target)
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

function isWriteKeyword(keyword: string): keyword is WriteKeyword {
  return WRITE_KEYWORDS.has(keyword);
}

function buildMergeWriteBackupPlan(
  statementSql: string,
  params: readonly SqlParam[],
): WriteBackupPlan | undefined {
  const secondKeyword = topLevelTokens(statementSql)[1]?.keyword;
  if (secondKeyword === "DELTA") {
    return undefined;
  }
  if (secondKeyword !== "INTO") {
    throw new BackupRequiredError("MERGE write refused: expected MERGE INTO syntax");
  }
  return buildMergeBackupPlan(statementSql, params);
}

function dispatchWriteBackupPlan(
  keyword: WriteKeyword,
  statementSql: string,
  params: readonly SqlParam[],
): WriteBackupPlan | undefined {
  switch (keyword) {
    case "UPDATE":
      return buildUpdateBackupPlan(statementSql, params);
    case "UPSERT":
    case "REPLACE":
      return buildUpsertBackupPlan(statementSql, params, keyword);
    case "MERGE":
      return buildMergeWriteBackupPlan(statementSql, params);
    case "DELETE":
      return buildDeleteBackupPlan(statementSql, params);
  }
}

export function buildWriteBackupPlan(
  sql: string,
  params: readonly SqlParam[] = [],
): WriteBackupPlan | undefined {
  const statementSql = trimStatementSql(sql);
  const keyword = firstKeyword(statementSql);
  if (!isWriteKeyword(keyword)) {
    return undefined;
  }
  assertParamArity(statementSql, params);
  return dispatchWriteBackupPlan(keyword, statementSql, params);
}
