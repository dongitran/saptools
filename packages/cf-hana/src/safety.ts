import { classifyStatement, firstKeyword } from "./statements.js";
import type { StatementKind } from "./types.js";

const DESTRUCTIVE_DDL_KEYWORDS = new Set(["DROP", "TRUNCATE", "ALTER"]);
const UNSCOPED_WRITE_KEYWORDS = new Set(["UPDATE", "DELETE"]);

export type GuardViolation = "read-only" | "destructive";

export interface GuardConfig {
  readonly readOnly: boolean;
  readonly allowDestructive: boolean;
}

export interface GuardDecision {
  readonly allowed: boolean;
  readonly destructive: boolean;
  readonly violation: GuardViolation | undefined;
  readonly reason: string | undefined;
}

export interface StatementInspection {
  readonly kind: StatementKind;
  readonly destructive: boolean;
}

export interface AutoLimitResult {
  readonly sql: string;
  readonly applied: boolean;
  readonly requestedLimit?: number;
}

function skipQuotedText(sql: string, start: number): number {
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

function skipBlockComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
    index += 1;
  }
  return Math.min(index + 2, sql.length);
}

function maskIgnoredSqlText(sql: string): string {
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

function hasTopLevelKeyword(sql: string, keyword: string): boolean {
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
      return true;
    }
  }
  return false;
}

function isUnconditionalMergeDelete(sql: string): boolean {
  return /\bWHEN\s+MATCHED\s+THEN\s+DELETE\b/i.test(maskIgnoredSqlText(sql));
}

function isMalformedReplace(sql: string): boolean {
  return (
    !hasTopLevelKeyword(sql, "VALUES") &&
    !hasTopLevelKeyword(sql, "SELECT") &&
    !hasTopLevelKeyword(sql, "WITH")
  );
}

function trailingLineCommentIndex(sql: string): number | undefined {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      index = skipQuotedText(sql, index);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const lineEnd = sql.indexOf("\n", index + 2);
      if (lineEnd === -1 || sql.slice(lineEnd + 1).trim().length === 0) {
        return index;
      }
      index = lineEnd + 1;
      continue;
    }
    index += 1;
  }
  return undefined;
}

function appendLimit(sql: string, limit: number): string {
  const trimmed = sql.replace(/(?<![\s;])[\s;]+$/, "");
  const commentIndex = trailingLineCommentIndex(trimmed);
  if (commentIndex === undefined) {
    return `${trimmed} LIMIT ${String(limit)}`;
  }
  const beforeComment = trimmed.slice(0, commentIndex).replace(/(?<![\s;])[\s;]+$/, "");
  const comment = trimmed.slice(commentIndex);
  return `${beforeComment} LIMIT ${String(limit)} ${comment}`;
}

/** Inspect a statement's kind and whether it is destructive. */
export function inspectStatement(sql: string): StatementInspection {
  const kind = classifyStatement(sql);
  const keyword = firstKeyword(sql);
  if (kind === "ddl") {
    return { kind, destructive: DESTRUCTIVE_DDL_KEYWORDS.has(keyword) };
  }
  if (kind === "dml") {
    const destructive =
      (UNSCOPED_WRITE_KEYWORDS.has(keyword) && !hasTopLevelKeyword(sql, "WHERE")) ||
      (keyword === "MERGE" && isUnconditionalMergeDelete(sql)) ||
      (keyword === "REPLACE" && isMalformedReplace(sql));
    return {
      kind,
      destructive,
    };
  }
  return { kind, destructive: false };
}

/** Decide whether a statement may run under the given safety configuration. */
export function evaluateGuard(sql: string, config: GuardConfig): GuardDecision {
  const inspection = inspectStatement(sql);

  if (config.readOnly && inspection.kind !== "select") {
    return {
      allowed: false,
      destructive: inspection.destructive,
      violation: "read-only",
      reason:
        inspection.kind === "unknown"
          ? "read-only mode only permits SELECT/WITH statements"
          : `read-only mode blocks ${inspection.kind.toUpperCase()} statements`,
    };
  }

  if (inspection.destructive && !config.allowDestructive) {
    return {
      allowed: false,
      destructive: true,
      violation: "destructive",
      reason:
        "destructive statement blocked (DROP/TRUNCATE/ALTER, unscoped UPDATE/DELETE, " +
        "or unconditional matched MERGE DELETE); " +
        "allow it explicitly to proceed",
    };
  }

  return {
    allowed: true,
    destructive: inspection.destructive,
    violation: undefined,
    reason: undefined,
  };
}

/** Append a `LIMIT` clause to a bare SELECT that has no row cap of its own. */
export function applyAutoLimit(sql: string, limit: number | false): AutoLimitResult {
  if (limit === false || classifyStatement(sql) !== "select") {
    return { sql, applied: false };
  }

  const stripped = maskIgnoredSqlText(sql);
  if (/\blimit\b/i.test(stripped) || /\btop\s+\d/i.test(stripped)) {
    return { sql, applied: false };
  }

  return {
    sql: appendLimit(sql, limit + 1),
    applied: true,
    requestedLimit: limit,
  };
}
