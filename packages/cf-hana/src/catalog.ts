import type { Connection } from "./connection.js";
import type { ColumnInfo, TableInfo } from "./types.js";

interface SchemaRow {
  readonly SCHEMA_NAME: string;
}

interface TableRow {
  readonly SCHEMA_NAME: string;
  readonly TABLE_NAME: string;
  readonly TABLE_TYPE: string;
}

interface ColumnRow {
  readonly COLUMN_NAME: string;
  readonly DATA_TYPE_NAME: string;
  readonly LENGTH: number | null;
  readonly SCALE: number | null;
  readonly IS_NULLABLE: string;
  readonly POSITION: number;
}

export interface TableDescription {
  readonly table: TableInfo | undefined;
  readonly columns: readonly ColumnInfo[];
}

/** List every schema visible to the current user. */
export async function listSchemas(connection: Connection): Promise<readonly string[]> {
  const result = await connection.query<SchemaRow>(
    "SELECT SCHEMA_NAME FROM SYS.SCHEMAS ORDER BY SCHEMA_NAME",
    [],
    { autoLimit: false },
  );
  return result.rows.map((row) => row.SCHEMA_NAME);
}

/** List the tables in a schema. */
export async function listTables(
  connection: Connection,
  schema: string,
): Promise<readonly TableInfo[]> {
  const result = await connection.query<TableRow>(
    "SELECT SCHEMA_NAME, TABLE_NAME, TABLE_TYPE FROM SYS.TABLES " +
      "WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME",
    [schema],
    { autoLimit: false },
  );
  return result.rows.map((row) => ({
    schema: row.SCHEMA_NAME,
    name: row.TABLE_NAME,
    type: row.TABLE_TYPE,
    rowCount: undefined,
  }));
}

/** List the columns of a table, ordered by position. */
export async function listColumns(
  connection: Connection,
  schema: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  const result = await connection.query<ColumnRow>(
    "SELECT COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, POSITION " +
      "FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY POSITION",
    [schema, table],
    { autoLimit: false },
  );
  return result.rows.map((row) => ({
    name: row.COLUMN_NAME,
    dataType: row.DATA_TYPE_NAME,
    length: row.LENGTH ?? undefined,
    scale: row.SCALE ?? undefined,
    nullable: row.IS_NULLABLE === "TRUE",
    position: row.POSITION,
  }));
}

/** Describe a table: its catalog entry plus its columns. */
export async function describeTable(
  connection: Connection,
  schema: string,
  table: string,
): Promise<TableDescription> {
  const tables = await listTables(connection, schema);
  const columns = await listColumns(connection, schema, table);
  return {
    table: tables.find((info) => info.name === table),
    columns,
  };
}
