import {
  classifyStatement,
  firstKeyword,
  hasMultipleStatements,
  hasTopLevelKeyword,
  maskIgnoredSqlText,
  MULTI_STATEMENT_MESSAGE,
  resolveWithStatement,
  skipBlockComment,
  skipQuotedText,
} from "./statements.js";
import type { StatementKind } from "./types.js";

const DESTRUCTIVE_DDL_KEYWORDS = new Set(["DROP", "TRUNCATE", "ALTER"]);
const UNSCOPED_WRITE_KEYWORDS = new Set(["UPDATE", "DELETE"]);

export type GuardViolation = "read-only" | "destructive" | "multi-statement";

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
  /** True when `sql` contains more than one genuine top-level statement. */
  readonly multiStatement: boolean;
}

export interface AutoLimitResult {
  readonly sql: string;
  readonly applied: boolean;
  readonly requestedLimit?: number;
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
  // Checked before classifyStatement is even consulted: a genuine second
  // top-level statement after a ';' means the real shape of "everything
  // past the first statement" cannot be vouched for at all, regardless of
  // what the first statement looks like on its own. See evaluateGuard,
  // which treats this as unconditional - not overridable by
  // --allow-destructive, unlike an ordinary destructive classification.
  if (hasMultipleStatements(sql)) {
    return { kind: "unknown", destructive: true, multiStatement: true };
  }

  const kind = classifyStatement(sql);
  const leading = firstKeyword(sql);
  // For a WITH-led statement, every destructive check below must reason
  // about the real DML verb after the CTE definitions, not "WITH" itself -
  // both for which keyword to check, and (via `tail`) so a check like
  // isMalformedReplace's own `hasTopLevelKeyword(sql, "WITH")` cannot be
  // trivially (and wrongly) satisfied by the statement's own leading WITH.
  const withResolved = leading === "WITH" ? resolveWithStatement(sql) : undefined;
  const keyword = withResolved?.keyword ?? leading;
  const tail = withResolved === undefined ? sql : sql.slice(withResolved.index);

  if (kind === "ddl") {
    return { kind, destructive: DESTRUCTIVE_DDL_KEYWORDS.has(keyword), multiStatement: false };
  }
  if (kind === "dml") {
    const destructive =
      (UNSCOPED_WRITE_KEYWORDS.has(keyword) && !hasTopLevelKeyword(tail, "WHERE")) ||
      (keyword === "MERGE" && isUnconditionalMergeDelete(tail)) ||
      (keyword === "REPLACE" && isMalformedReplace(tail));
    return {
      kind,
      destructive,
      multiStatement: false,
    };
  }
  if (kind === "unknown") {
    // Only an *unresolved* WITH-led statement (its CTE-list failed to parse
    // at all - see resolveWithStatement) falls back to destructive here; a
    // WITH-led statement that resolves fine but whose real trailing keyword
    // is simply an unrecognized, non-CALL kind (e.g. EXPLAIN) must match its
    // bare equivalent, not be swept into this fallback just because the
    // statement happens to start with WITH. Fail closed and require explicit
    // authorization only when the shape genuinely could not be determined:
    // this is a safety net independent of the parser's own correctness, not
    // a substitute for fixing a specific parsing gap when one is found.
    const unresolvedWith = leading === "WITH" && withResolved === undefined;
    return { kind, destructive: keyword === "CALL" || unresolvedWith, multiStatement: false };
  }
  return { kind, destructive: false, multiStatement: false };
}

/** Decide whether a statement may run under the given safety configuration. */
export function evaluateGuard(sql: string, config: GuardConfig): GuardDecision {
  const inspection = inspectStatement(sql);

  // Unconditional: unlike an ordinary destructive classification, this is
  // never overridable by --allow-destructive (nor is it read-only-specific),
  // since the real shape of the smuggled content is simply unknown.
  if (inspection.multiStatement) {
    return {
      allowed: false,
      destructive: true,
      violation: "multi-statement",
      reason: MULTI_STATEMENT_MESSAGE,
    };
  }

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
