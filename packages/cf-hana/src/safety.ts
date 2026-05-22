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
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function hasWhereClause(sql: string): boolean {
  return /\bwhere\b/i.test(stripStringLiterals(sql));
}

/** Inspect a statement's kind and whether it is destructive. */
export function inspectStatement(sql: string): StatementInspection {
  const kind = classifyStatement(sql);
  const keyword = firstKeyword(sql);
  if (kind === "ddl") {
    return { kind, destructive: DESTRUCTIVE_DDL_KEYWORDS.has(keyword) };
  }
  if (kind === "dml") {
    return {
      kind,
      destructive: UNSCOPED_WRITE_KEYWORDS.has(keyword) && !hasWhereClause(sql),
    };
  }
  return { kind, destructive: false };
}

/** Decide whether a statement may run under the given safety configuration. */
export function evaluateGuard(sql: string, config: GuardConfig): GuardDecision {
  const inspection = inspectStatement(sql);

  if (config.readOnly && (inspection.kind === "dml" || inspection.kind === "ddl")) {
    return {
      allowed: false,
      destructive: inspection.destructive,
      violation: "read-only",
      reason: `read-only mode blocks ${inspection.kind.toUpperCase()} statements`,
    };
  }

  if (inspection.destructive && !config.allowDestructive) {
    return {
      allowed: false,
      destructive: true,
      violation: "destructive",
      reason:
        "destructive statement blocked (DROP/TRUNCATE/ALTER or unscoped UPDATE/DELETE); " +
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

  const stripped = stripStringLiterals(sql);
  if (/\blimit\b/i.test(stripped) || /\btop\s+\d/i.test(stripped)) {
    return { sql, applied: false };
  }

  const trimmed = sql.replace(/[\s;]+$/, "");
  return { sql: `${trimmed} LIMIT ${String(limit)}`, applied: true };
}
