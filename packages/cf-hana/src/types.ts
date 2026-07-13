/** A value that can be bound to a SQL `?` placeholder. */
export type SqlParam = string | number | boolean | null | Date | Buffer;

/** Default row shape — a map of column name to value. */
export type QueryRow = Record<string, SqlParam>;

/** Coarse classification of a SQL statement. */
export type StatementKind = "select" | "dml" | "ddl" | "unknown";

/** Which HANA user from a service binding to authenticate as. */
export type DbUserRole = "runtime" | "hdi";

/** Where resolved credentials came from. */
export type CredentialSource = "live";

/** Whether the app selector was pinned by the caller or inherited from `cf target`. */
export type SelectorSource = "explicit" | "ambient";

/** Output rendering for CLI results. */
export type OutputFormat = "table" | "json" | "csv";

export interface QueryResultColumn {
  readonly name: string;
  readonly typeName: string;
}

export interface QueryResult<TRow = QueryRow> {
  readonly rows: readonly TRow[];
  readonly columns: readonly QueryResultColumn[];
  /** Rows returned for a SELECT, or rows affected for a DML statement. */
  readonly rowCount: number;
  readonly statement: StatementKind;
  /** True when an auto-applied row limit clipped the result set. */
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface PoolOptions {
  readonly max?: number;
  readonly idleTimeoutMs?: number;
}

export interface ConnectOptions {
  /** HANA user to connect as. Defaults to `"runtime"`. */
  readonly role?: DbUserRole;
  /** Pick a specific HANA binding by service-instance name. */
  readonly bindingName?: string;
  /** Pick a specific HANA binding by index. */
  readonly bindingIndex?: number;
  /** Block all DML/DDL statements when true. Defaults to false. */
  readonly readOnly?: boolean;
  /** Allow destructive statements (DROP/TRUNCATE/ALTER, unscoped UPDATE/DELETE). */
  readonly allowDestructive?: boolean;
  /** Row cap auto-applied to bare SELECT statements. `false` disables it. */
  readonly autoLimit?: number | false;
  readonly queryTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  /** Deprecated compatibility flag. Binding discovery is already live. */
  readonly refresh?: boolean;
  /** SAP BTP email for the live credential fetch (else `SAP_EMAIL`). */
  readonly email?: string;
  /** SAP BTP password for the live credential fetch (else `SAP_PASSWORD`). */
  readonly password?: string;
  /** Connection pool tuning, or `false` for a single dedicated connection. */
  readonly pool?: PoolOptions | false;
}

export interface QueryOptions {
  readonly timeoutMs?: number;
  readonly autoLimit?: number | false;
  readonly allowDestructive?: boolean;
}

export interface SelectSpec {
  readonly schema: string;
  readonly table: string;
  /** Columns to project. Defaults to all columns. */
  readonly columns?: readonly string[];
  /** Equality filters, combined with `AND` and bound as parameters. */
  readonly where?: Readonly<Record<string, SqlParam>>;
  readonly orderBy?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface BuiltStatement {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  readonly type: string;
  readonly rowCount: number | undefined;
}

export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly length: number | undefined;
  readonly scale: number | undefined;
  readonly nullable: boolean;
  readonly position: number;
}

export interface HanaClientInfo {
  readonly selector: string;
  readonly appName: string;
  readonly host: string;
  readonly schema: string;
  readonly role: DbUserRole;
  readonly driver: string;
  readonly credentialSource: CredentialSource;
  readonly selectorSource?: SelectorSource;
  readonly regionConfirmed?: boolean;
  readonly selectorCanBePinned?: boolean;
}

/** HANA binding credentials (from VCAP). */
export interface HanaBindingCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly hdiUser: string;
  readonly hdiPassword: string;
  readonly url?: string;
  readonly databaseId?: string;
  readonly certificate: string;
}

export interface HanaBinding {
  readonly name?: string;
  readonly credentials: HanaBindingCredentials;
}
