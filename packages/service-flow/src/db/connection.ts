import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';

type SqlValue = string | number | bigint | Buffer | null | undefined;
interface NativeStatement {
  run: (...params: SqlValue[]) => { changes: number };
  get: (...params: SqlValue[]) => Record<string, unknown> | undefined;
  all: (...params: SqlValue[]) => Array<Record<string, unknown>>;
}
interface NativeDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => NativeStatement;
  close: () => void;
}
interface NodeSqliteModule {
  DatabaseSync: new (location: string, options?: { open?: boolean; readOnly?: boolean }) => NativeDatabase;
}

let sqliteWarningFilterInstalled = false;
function installSqliteWarningFilter(): void {
  if (sqliteWarningFilterInstalled) return;
  sqliteWarningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    const text = warning instanceof Error ? warning.message : String(warning);
    if (text.includes('SQLite is an experimental feature')) return;
    Reflect.apply(original, process, [warning, ...args]);
  }) as typeof process.emitWarning;
}
export interface Statement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}
export interface Db {
  path: string;
  readonly: boolean;
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  pragma: (sql: string) => Array<Record<string, unknown>>;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
}
export interface OpenDatabaseOptions {
  readonly?: boolean;
  migrate?: boolean;
}
function loadSqlite(): NodeSqliteModule {
  try {
    installSqliteWarningFilter();
    const moduleValue = process.getBuiltinModule('node:sqlite') as unknown;
    if (!moduleValue || typeof moduleValue !== 'object' || !('DatabaseSync' in moduleValue))
      throw new Error('node:sqlite DatabaseSync is unavailable');
    const sqlite = moduleValue as NodeSqliteModule;
    if (typeof sqlite.DatabaseSync !== 'function')
      throw new Error('node:sqlite DatabaseSync is not a constructor');
    return sqlite;
  } catch (error) {
    throw new Error(
      'service-flow 0.1.8 requires Node.js >=24 with node:sqlite DatabaseSync support. Upgrade Node.js or install a service-flow build with a compatible SQLite driver.',
      { cause: error },
    );
  }
}
function bindParams(params: unknown[]): SqlValue[] {
  return params.map((param) => {
    if (param === undefined || param === null) return null;
    if (typeof param === 'string' || typeof param === 'number' || typeof param === 'bigint' || Buffer.isBuffer(param)) return param;
    if (typeof param === 'boolean') return param ? 1 : 0;
    return JSON.stringify(param);
  });
}
export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = loadSqlite();
  const native = new sqlite.DatabaseSync(dbPath, { readOnly: Boolean(options.readonly) });
  let inTransaction = false;
  const db: Db = {
    path: dbPath,
    readonly: Boolean(options.readonly),
    exec(sql: string): void {
      native.exec(sql);
    },
    prepare(sql: string): Statement {
      const statement = native.prepare(sql);
      return {
        run: (...params: unknown[]) => statement.run(...bindParams(params)),
        get: (...params: unknown[]) => statement.get(...bindParams(params)),
        all: (...params: unknown[]) => statement.all(...bindParams(params)),
      };
    },
    pragma(sql: string): Array<Record<string, unknown>> {
      const normalized = sql.trim().replace(/;$/, '');
      if (/=/.test(normalized)) {
        native.exec(`PRAGMA ${normalized}`);
        return [];
      }
      return native.prepare(`PRAGMA ${normalized}`).all();
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) return fn();
      inTransaction = true;
      native.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close(): void {
      native.close();
    },
  };
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    if (options.migrate !== false) migrate(db);
  }
  return db;
}
export function openReadOnlyDatabase(dbPath: string): Db {
  return openDatabase(dbPath, { readonly: true, migrate: false });
}
