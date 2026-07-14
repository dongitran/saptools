import { QueryError } from "./errors.js";
import type { SqlParam, StatementKind } from "./types.js";

const SELECT_KEYWORDS = new Set(["SELECT", "WITH"]);
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

/** Classify a SQL statement by its leading keyword. */
export function classifyStatement(sql: string): StatementKind {
  const keyword = firstKeyword(sql);
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
