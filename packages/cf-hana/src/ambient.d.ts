declare module "hdb" {
  export interface HdbColumnMetadata {
    readonly columnName?: string;
    readonly columnDisplayName?: string;
    readonly tableName?: string;
    readonly schemaName?: string;
    readonly dataType: number;
    readonly length: number;
    readonly fraction: number;
  }

  export interface HdbStatement {
    readonly functionCode: number;
    readonly resultSetMetadata?: readonly HdbColumnMetadata[];
    exec(
      values: readonly unknown[],
      callback: (error: Error | null, result: unknown) => void,
    ): void;
    drop(callback?: (error?: Error | null) => void): void;
  }

  export interface HdbClient {
    readonly readyState: string;
    connect(callback: (error: Error | null) => void): HdbClient;
    prepare(
      sql: string,
      callback: (error: Error | null, statement: HdbStatement) => void,
    ): HdbClient;
    exec(sql: string, callback: (error: Error | null, result: unknown) => void): HdbClient;
    setAutoCommit(autoCommit: boolean): void;
    commit(callback: (error: Error | null) => void): void;
    rollback(callback: (error: Error | null) => void): void;
    disconnect(callback: (error: Error | null) => void): HdbClient;
    close(): void;
  }

  export interface HdbClientOptions {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly ca?: string | readonly string[];
    readonly useTLS?: boolean;
  }

  export function createClient(options: HdbClientOptions): HdbClient;
}
