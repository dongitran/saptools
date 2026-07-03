import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';
export interface Statement { run: (...params: unknown[]) => { changes: number }; get: (...params: unknown[]) => Record<string, unknown> | undefined; all: (...params: unknown[]) => Array<Record<string, unknown>>; }
export interface Db { path: string; exec: (sql: string) => void; prepare: (sql: string) => Statement; pragma: (sql: string) => void; close: () => void; }
function quote(value: unknown): string { if (value === null || value === undefined) return 'NULL'; if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'; if (typeof value === 'boolean') return value ? '1' : '0'; return `'${String(value).replaceAll("'", "''")}'`; }
function bind(sql: string, params: unknown[]): string { let index = 0; return sql.replaceAll('?', () => quote(params[index++])); }
function call(dbPath: string, args: string[]): string { return execFileSync('sqlite3', [dbPath, ...args], { encoding: 'utf8' }); }
function jsonRows(dbPath: string, sql: string): Array<Record<string, unknown>> { const out = call(dbPath, ['-json', sql]); if (!out.trim()) return []; return JSON.parse(out) as Array<Record<string, unknown>>; }
export function openDatabase(dbPath: string): Db { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); const db: Db = { path: dbPath, exec(sql: string): void { call(dbPath, [sql]); }, prepare(sql: string): Statement { return { run: (...params: unknown[]) => { call(dbPath, [bind(sql, params)]); return { changes: 0 }; }, get: (...params: unknown[]) => jsonRows(dbPath, bind(sql, params))[0], all: (...params: unknown[]) => jsonRows(dbPath, bind(sql, params)) }; }, pragma(sql: string): void { call(dbPath, [`PRAGMA ${sql}`]); }, close(): void { /* sqlite3 CLI opens per statement */ } }; db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); migrate(db); return db; }
