import { QueryError } from "./errors.js";
import type { SqlParam, StatementKind } from "./types.js";

const SELECT_KEYWORDS = new Set(["SELECT"]);
const DML_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"]);
const DDL_KEYWORDS = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "COMMENT"]);

/** The leading SQL keyword, upper-cased, skipping comments and whitespace. */
export function firstKeyword(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (char.trim().length === 0) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd === -1) {
        return "";
      }
      index = commentEnd + 2;
      continue;
    }
    break;
  }

  let keywordEnd = index;
  while (keywordEnd < sql.length) {
    const code = sql.charCodeAt(keywordEnd);
    const isUpperCase = code >= 65 && code <= 90;
    const isLowerCase = code >= 97 && code <= 122;
    if (!isUpperCase && !isLowerCase) {
      break;
    }
    keywordEnd += 1;
  }
  return sql.slice(index, keywordEnd).toUpperCase();
}

/** Skip a quoted string/identifier starting at `start`; returns the index just past its closing quote. */
export function skipQuotedText(sql: string, start: number): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    index += 1;
  }
  return index;
}

function skipLineComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && sql[index] !== "\n") {
    index += 1;
  }
  return index;
}

/** Skip a block comment starting at `start`; returns the index just past its closing `star-slash`. */
export function skipBlockComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
    index += 1;
  }
  return Math.min(index + 2, sql.length);
}

/** Replace every quoted string/identifier and comment with spaces, preserving length and positions. */
export function maskIgnoredSqlText(sql: string): string {
  let masked = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const end = skipQuotedText(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = skipLineComment(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = skipBlockComment(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    masked += char ?? "";
    index += 1;
  }
  return masked;
}

function topLevelKeywordIndex(sql: string, keyword: string): number | undefined {
  const masked = maskIgnoredSqlText(sql);
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      masked.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Za-z0-9_$#]/.test(masked.charAt(index - 1)) &&
      !/[A-Za-z0-9_$#]/.test(masked.charAt(index + keyword.length))
    ) {
      return index;
    }
  }
  return undefined;
}

/** Whether `keyword` appears at paren-depth 0, outside string/identifier literals and comments. */
export function hasTopLevelKeyword(sql: string, keyword: string): boolean {
  return topLevelKeywordIndex(sql, keyword) !== undefined;
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$#]/.test(char);
}

function skipWhitespace(masked: string, start: number): number {
  let index = start;
  while (index < masked.length && /\s/.test(masked.charAt(index))) {
    index += 1;
  }
  return index;
}

function matchingCloseParenIndex(masked: string, openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function isAsKeywordAt(masked: string, index: number): boolean {
  return (
    masked.slice(index, index + 2).toUpperCase() === "AS" &&
    !isIdentifierChar(masked.charAt(index - 1)) &&
    !isIdentifierChar(masked.charAt(index + 2))
  );
}

/**
 * The position where a `WITH` statement's real trailing statement begins —
 * just past its comma-separated CTE definitions (each `name [(cols)] AS
 * (body)`) — found by structurally walking that grammar rather than
 * searching for an expected keyword, so it correctly resolves *any*
 * trailing statement type (DML, DDL, `CALL`, or anything else), not just a
 * fixed candidate list. Returns `undefined` only when the CTE-list syntax
 * itself does not parse (malformed input, or an unrecognized variant) —
 * callers must fail closed on that, never default it to "select".
 */
function cteListEndIndex(masked: string, afterWith: number): number | undefined {
  let index = afterWith;
  for (;;) {
    index = skipWhitespace(masked, index);
    while (index < masked.length && isIdentifierChar(masked.charAt(index))) {
      index += 1;
    }
    index = skipWhitespace(masked, index);
    if (masked.charAt(index) === "(") {
      // An optional explicit column list: `cte_name (col1, col2) AS (...)`.
      const columnListEnd = matchingCloseParenIndex(masked, index);
      if (columnListEnd === undefined) {
        return undefined;
      }
      index = skipWhitespace(masked, columnListEnd + 1);
    }
    if (!isAsKeywordAt(masked, index)) {
      return undefined;
    }
    index = skipWhitespace(masked, index + 2);
    if (masked.charAt(index) !== "(") {
      return undefined;
    }
    const closeIndex = matchingCloseParenIndex(masked, index);
    if (closeIndex === undefined) {
      return undefined;
    }
    index = skipWhitespace(masked, closeIndex + 1);
    if (masked.charAt(index) === ",") {
      index += 1;
      continue;
    }
    return index;
  }
}

export interface EffectiveStatement {
  readonly keyword: string;
  readonly index: number;
}

/**
 * Resolves a `WITH`-led statement down to its real trailing statement's
 * leading keyword and start position (an index into the original,
 * unmasked `sql`) — `undefined` only when the CTE-list itself doesn't parse
 * (see `cteListEndIndex`). Quoted identifiers/string literals/comments are
 * masked first, so a CTE literally (quoted-)named e.g. `"DELETE"` can never
 * be mistaken for the real keyword.
 */
export function resolveWithStatement(sql: string): EffectiveStatement | undefined {
  const withIndex = topLevelKeywordIndex(sql, "WITH");
  if (withIndex === undefined) {
    return undefined;
  }
  const masked = maskIgnoredSqlText(sql);
  const trailingIndex = cteListEndIndex(masked, withIndex + "WITH".length);
  if (trailingIndex === undefined) {
    return undefined;
  }
  let keywordEnd = trailingIndex;
  while (keywordEnd < masked.length && isIdentifierChar(masked.charAt(keywordEnd))) {
    keywordEnd += 1;
  }
  return { keyword: masked.slice(trailingIndex, keywordEnd).toUpperCase(), index: trailingIndex };
}

function classifyByKeyword(keyword: string): StatementKind {
  if (SELECT_KEYWORDS.has(keyword)) {
    return "select";
  }
  if (DML_KEYWORDS.has(keyword)) {
    return "dml";
  }
  if (DDL_KEYWORDS.has(keyword)) {
    return "ddl";
  }
  return "unknown";
}

/** Classify a SQL statement by its leading keyword. */
export function classifyStatement(sql: string): StatementKind {
  const keyword = firstKeyword(sql);
  if (keyword === "WITH") {
    const resolved = resolveWithStatement(sql);
    // Fail closed: an unparseable CTE-list is never assumed to be a safe read.
    return resolved === undefined ? "unknown" : classifyByKeyword(resolved.keyword);
  }
  return classifyByKeyword(keyword);
}

/** Quote a SQL identifier (table/column name) for safe interpolation. */
export function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new QueryError("A SQL identifier must not be empty");
  }
  if (identifier.includes("\0")) {
    throw new QueryError("A SQL identifier must not contain a NUL character");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Build a `"schema"."table"` qualified, quoted name. */
export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Count `?` placeholders, skipping string literals, quoted identifiers, and comments. */
export function countPlaceholders(sql: string): number {
  let count = 0;
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];

    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "?") {
      count += 1;
    }
    index += 1;
  }

  return count;
}

/** Throw when the number of `?` placeholders does not match the parameter count. */
export function assertParamArity(sql: string, params: readonly SqlParam[]): void {
  const expected = countPlaceholders(sql);
  if (expected !== params.length) {
    throw new QueryError(
      `SQL expects ${String(expected)} bound parameter(s) ` +
        `but received ${String(params.length)} value(s)`,
    );
  }
}
