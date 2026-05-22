import { QueryError } from "./errors.js";
import { qualifiedName, quoteIdentifier } from "./statements.js";
import type { BuiltStatement, SelectSpec, SqlParam } from "./types.js";

interface WhereClause {
  readonly clause: string;
  readonly params: readonly SqlParam[];
}

function buildWhere(where: Readonly<Record<string, SqlParam>> | undefined): WhereClause {
  if (where === undefined) {
    return { clause: "", params: [] };
  }
  const entries = Object.entries(where);
  if (entries.length === 0) {
    return { clause: "", params: [] };
  }
  const conditions = entries.map(([column]) => `${quoteIdentifier(column)} = ?`);
  return {
    clause: ` WHERE ${conditions.join(" AND ")}`,
    params: entries.map(([, value]) => value),
  };
}

/** Build a parameterized `SELECT` statement from a typed spec. */
export function buildSelect(spec: SelectSpec): BuiltStatement {
  const columns =
    spec.columns === undefined || spec.columns.length === 0
      ? "*"
      : spec.columns.map((column) => quoteIdentifier(column)).join(", ");
  const where = buildWhere(spec.where);
  const clauses: string[] = [
    `SELECT ${columns} FROM ${qualifiedName(spec.schema, spec.table)}${where.clause}`,
  ];

  if (spec.orderBy !== undefined && spec.orderBy.length > 0) {
    clauses.push(`ORDER BY ${spec.orderBy.map((column) => quoteIdentifier(column)).join(", ")}`);
  }
  if (spec.limit !== undefined) {
    clauses.push(`LIMIT ${String(spec.limit)}`);
  }
  if (spec.offset !== undefined) {
    clauses.push(`OFFSET ${String(spec.offset)}`);
  }

  return { sql: clauses.join(" "), params: where.params };
}

/** Build a parameterized `SELECT COUNT(*)` statement. */
export function buildCount(
  spec: Pick<SelectSpec, "schema" | "table" | "where">,
): BuiltStatement {
  const where = buildWhere(spec.where);
  return {
    sql: `SELECT COUNT(*) AS "COUNT" FROM ${qualifiedName(spec.schema, spec.table)}${where.clause}`,
    params: where.params,
  };
}

/** Build a parameterized single-row `INSERT` statement. */
export function buildInsert(
  schema: string,
  table: string,
  values: Readonly<Record<string, SqlParam>>,
): BuiltStatement {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new QueryError("INSERT requires at least one column value");
  }
  const columns = entries.map(([column]) => quoteIdentifier(column)).join(", ");
  const placeholders = entries.map(() => "?").join(", ");
  return {
    sql: `INSERT INTO ${qualifiedName(schema, table)} (${columns}) VALUES (${placeholders})`,
    params: entries.map(([, value]) => value),
  };
}

/** Build a parameterized `UPDATE` statement. A non-empty `where` is required. */
export function buildUpdate(
  schema: string,
  table: string,
  values: Readonly<Record<string, SqlParam>>,
  where: Readonly<Record<string, SqlParam>>,
): BuiltStatement {
  const valueEntries = Object.entries(values);
  if (valueEntries.length === 0) {
    throw new QueryError("UPDATE requires at least one column value");
  }
  const whereClause = buildWhere(where);
  if (whereClause.clause === "") {
    throw new QueryError("UPDATE requires a non-empty WHERE filter to avoid a full-table write");
  }
  const assignments = valueEntries
    .map(([column]) => `${quoteIdentifier(column)} = ?`)
    .join(", ");
  return {
    sql: `UPDATE ${qualifiedName(schema, table)} SET ${assignments}${whereClause.clause}`,
    params: [...valueEntries.map(([, value]) => value), ...whereClause.params],
  };
}

/** Build a parameterized `DELETE` statement. A non-empty `where` is required. */
export function buildDelete(
  schema: string,
  table: string,
  where: Readonly<Record<string, SqlParam>>,
): BuiltStatement {
  const whereClause = buildWhere(where);
  if (whereClause.clause === "") {
    throw new QueryError("DELETE requires a non-empty WHERE filter to avoid a full-table delete");
  }
  return {
    sql: `DELETE FROM ${qualifiedName(schema, table)}${whereClause.clause}`,
    params: whereClause.params,
  };
}
