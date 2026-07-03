import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';
export interface Statement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
}
export interface Db {
  path: string;
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  pragma: (sql: string) => void;
  close: () => void;
}
function quote(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}
function bind(sql: string, params: unknown[]): string {
  let index = 0;
  return sql.replaceAll('?', () => quote(params[index++]));
}
function isBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked|database is busy/i.test(error.message);
}
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function call(dbPath: string, args: string[], attempt = 0): string {
  try {
    return execFileSync('sqlite3', [dbPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, SQLITE_BUSY_TIMEOUT: '10000' }
    });
  } catch (error) {
    if (isBusy(error) && attempt < 5) {
      sleep(50 * 2 ** attempt);
      return call(dbPath, args, attempt + 1);
    }
    if (isBusy(error))
      throw new Error(
        'SQLite database is busy or locked. Another service-flow writer may be active; retry after it finishes.',
        { cause: error }
      );
    throw error;
  }
}
function jsonRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const out = call(dbPath, ['-json', sql]);
  if (!out.trim()) return [];
  return JSON.parse(out) as Array<Record<string, unknown>>;
}
export function openDatabase(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: Db = {
    path: dbPath,
    exec(sql: string): void {
      call(dbPath, [sql]);
    },
    prepare(sql: string): Statement {
      return {
        run: (...params: unknown[]) => {
          call(dbPath, [bind(sql, params)]);
          return { changes: 0 };
        },
        get: (...params: unknown[]) => jsonRows(dbPath, bind(sql, params))[0],
        all: (...params: unknown[]) => jsonRows(dbPath, bind(sql, params))
      };
    },
    pragma(sql: string): void {
      call(dbPath, [`PRAGMA ${sql}`]);
    },
    close(): void {
      /* sqlite3 CLI opens per statement */
    }
  };
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
