import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  openReadOnlyDatabase,
  type Db,
} from '../../src/db/connection.js';
import { CURRENT_SCHEMA_VERSION, migrate } from '../../src/db/migrations.js';

const requiredIndexes = {
  idx_graph_edge_lookup: [
    'edge_type', 'from_kind', 'from_id', 'status', 'to_id',
  ],
  idx_graph_edge_from: ['from_kind', 'from_id'],
  idx_symbol_repo_qualified: ['repo_id', 'qualified_name'],
  idx_symbol_repo_name: ['repo_id', 'name'],
  idx_symbol_repo_exported_name: [
    'repo_id', 'exported', 'exported_name',
  ],
} as const;

const temporaryRoots: string[] = [];

function database(label: string): { db: Db; dbPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), `sf-${label}-`));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'graph.db');
  return { db: openDatabase(dbPath), dbPath };
}

function indexColumns(db: Db, name: string): string[] {
  return db.prepare(`PRAGMA index_info(${name})`).all()
    .map((row) => String(row.name));
}

function assertRequiredIndexes(db: Db): void {
  for (const [name, columns] of Object.entries(requiredIndexes))
    expect(indexColumns(db, name)).toEqual(columns);
}

function queryPlan(db: Db, sql: string, ...params: unknown[]): string {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    .map((row) => String(row.detail))
    .join('\n');
}

function seedPlannerFixture(db: Db): void {
  const root = path.dirname(db.path);
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(1, root, db.path, 'now', 'now');
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,kind,is_git_repo
  ) VALUES(?,?,?,?,?,?,?)`).run(
    1, 1, 'neutral', root, '.', 'cap-service', 1,
  );
  const symbol = db.prepare(`INSERT INTO symbols(
    repo_id,kind,name,qualified_name,exported,start_line,end_line,
    source_file,exported_name
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 3_000; index += 1)
    symbol.run(
      1, 'function', `name${index}`, `Qualified${index}`, 1,
      index + 1, index + 1, `src/file${index % 20}.ts`, `Exported${index}`,
    );
  const edge = db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 1_000; index += 1)
    edge.run(
      1, 'REPO_IMPORTS_HELPER_PACKAGE', 'resolved', 'repo',
      String(index % 50), 'repo', String((index + 1) % 50), 1, '{}', 0,
    );
  db.exec('ANALYZE');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('performance index contract', () => {
  it('restores exact index layouts on a current read-write database', () => {
    const current = database('index-restore');
    assertRequiredIndexes(current.db);
    for (const name of Object.keys(requiredIndexes))
      current.db.exec(`DROP INDEX ${name}`);
    current.db.close();

    const readonly = openReadOnlyDatabase(current.dbPath);
    for (const name of Object.keys(requiredIndexes))
      expect(indexColumns(readonly, name)).toEqual([]);
    readonly.close();

    const restored = openDatabase(current.dbPath);
    expect(restored.pragma('user_version')).toEqual([
      { user_version: CURRENT_SCHEMA_VERSION },
    ]);
    assertRequiredIndexes(restored);
    migrate(restored);
    assertRequiredIndexes(restored);
    expect(restored.pragma('integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(restored.pragma('foreign_key_check')).toEqual([]);
    restored.close();
  });

  it('uses covering graph lookups and the multi-index symbol OR plan', () => {
    const current = database('index-query-plan');
    seedPlannerFixture(current.db);

    const exactGraph = queryPlan(current.db, `SELECT 1 FROM graph_edges dep
      WHERE dep.edge_type=? AND dep.status=? AND dep.from_kind=?
        AND dep.from_id=? AND dep.to_id=?`,
    'REPO_IMPORTS_HELPER_PACKAGE', 'resolved', 'repo', '1', '2');
    expect(exactGraph).toContain(
      'COVERING INDEX idx_graph_edge_lookup',
    );
    const ownershipGraph = queryPlan(current.db,
      `SELECT 1 FROM graph_edges dep
       WHERE dep.edge_type=? AND dep.from_kind=? AND dep.from_id=?
         AND dep.to_id=?`,
      'REPO_IMPORTS_HELPER_PACKAGE', 'repo', '1', '2');
    expect(ownershipGraph).toContain('INDEX idx_graph_edge_lookup');
    const fromGraph = queryPlan(current.db,
      `SELECT 1 FROM graph_edges WHERE from_kind=? AND from_id=?`,
      'repo', '1');
    expect(fromGraph).toContain('idx_graph_edge_from');

    const symbols = queryPlan(current.db, `SELECT id FROM symbols
      WHERE repo_id=? AND source_file<>? AND exported=1
        AND (exported_name=? OR name=? OR qualified_name=?)
      ORDER BY id`,
    1, 'src/other.ts', 'Exported2999', 'name2998', 'Qualified2997');
    expect(symbols).toContain('MULTI-INDEX OR');
    expect(symbols).toContain('idx_symbol_repo_exported_name');
    expect(symbols).toContain('idx_symbol_repo_name');
    expect(symbols).toContain('idx_symbol_repo_qualified');
    expect(symbols).not.toContain('SCAN symbols');
    current.db.close();
  });
});
