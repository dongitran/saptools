import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/001-fact-lifecycle.js';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

interface Fixture {
  db: Db;
  workspaceId: number;
}

interface SurfaceMutation {
  label: string;
  apply(surface: Record<string, unknown>): void;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected record');
  return value as Record<string, unknown>;
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
): unknown[] {
  const items = value[key];
  if (!Array.isArray(items)) throw new Error(`Expected array ${key}`);
  return items;
}

function firstScope(surface: Record<string, unknown>): Record<string, unknown> {
  const scope = arrayField(surface, 'scopes')[0];
  return record(scope);
}

const surfaceMutations: SurfaceMutation[] = [
  { label: 'missing entries', apply: (surface) => {
    delete surface.entries;
  } },
  { label: 'retyped entries', apply: (surface) => {
    surface.entries = {};
  } },
  { label: 'missing scopes', apply: (surface) => {
    delete surface.scopes;
  } },
  { label: 'retyped scopes', apply: (surface) => {
    surface.scopes = {};
  } },
  { label: 'missing nested targets', apply: (surface) => {
    delete firstScope(surface).targets;
  } },
  { label: 'retyped nested targets', apply: (surface) => {
    firstScope(surface).targets = {};
  } },
  { label: 'malformed nested target item', apply: (surface) => {
    firstScope(surface).targets = [{}];
  } },
];

async function packageFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-surface-nested-'));
  await Promise.all([
    writeFixtureFile(root, 'consumer/.git-fixture'),
    writeFixtureFile(root, 'consumer/package.json', JSON.stringify({
      name: '@neutral/consumer',
      dependencies: { '@neutral/provider': '1.0.0' },
    })),
    writeFixtureFile(root, 'consumer/src/start.ts', `
      import { exposed } from '@neutral/provider';
      export function start(): void { exposed(); }
    `),
    writeFixtureFile(root, 'provider/.git-fixture'),
    writeFixtureFile(root, 'provider/package.json', JSON.stringify({
      name: '@neutral/provider',
      exports: './src/index.ts',
    })),
    writeFixtureFile(root, 'provider/src/index.ts', `
      export function exposed(): void {}
    `),
  ]);
  return prepareWorkspace(root);
}

function providerSurface(
  db: Db,
): { id: number; value: Record<string, unknown> } {
  const row = db.prepare(`SELECT id,
    package_public_surface_json surfaceJson FROM repositories
    WHERE package_name='@neutral/provider'`).get();
  if (typeof row?.id !== 'number' || typeof row.surfaceJson !== 'string')
    throw new Error('Expected provider package surface');
  return {
    id: row.id,
    value: record(JSON.parse(row.surfaceJson) as unknown),
  };
}

function graphGenerationSnapshot(db: Db): string {
  return JSON.stringify({
    edges: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
    generations: db.prepare(`SELECT id,fact_generation factGeneration,
      graph_generation graphGeneration,graph_stale_reason graphStaleReason
      FROM repositories ORDER BY id`).all(),
  });
}

function diagnosticCategories(
  diagnostic: FactLifecycleDiagnostic | undefined,
): string[] {
  const categories: unknown = diagnostic?.invalidFactCategories;
  if (!Array.isArray(categories)) return [];
  return categories.flatMap((value): string[] => {
    const item = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
    return typeof item?.category === 'string' ? [item.category] : [];
  });
}

function expectBoundedLifecycle(fixture: Fixture): void {
  let diagnostic: FactLifecycleDiagnostic | undefined;
  expect(() => {
    diagnostic = factLifecycleDiagnostic(
      fixture.db, fixture.workspaceId,
    );
  }).not.toThrow();
  expect(diagnostic).toMatchObject({
    code: 'reindex_required',
    staleRepositoryCount: 0,
  });
  expect(diagnosticCategories(diagnostic))
    .toContain('repository_package_public_surface_invalid');
}

function expectBoundedReaders(fixture: Fixture, before: string): void {
  const traced = trace(fixture.db, {
    repo: 'consumer', operation: 'start',
  }, { depth: 2, workspaceId: fixture.workspaceId });
  expect(traced.edges).toEqual([]);
  expect(traced.diagnostics).toEqual([
    expect.objectContaining({ code: 'reindex_required' }),
  ]);
  expect(graphGenerationSnapshot(fixture.db)).toBe(before);
  expect(doctorDiagnostics(fixture.db, true, {
    detail: true, workspaceId: fixture.workspaceId,
  })).toEqual([
    expect.objectContaining({ code: 'reindex_required' }),
  ]);
  expect(graphGenerationSnapshot(fixture.db)).toBe(before);
}

function expectBoundedLink(fixture: Fixture, before: string): void {
  expect(() => linkWorkspace(fixture.db, fixture.workspaceId))
    .toThrow(/reindex_required/);
  expect(graphGenerationSnapshot(fixture.db)).toBe(before);
}

async function verifyMutation(mutation: SurfaceMutation): Promise<void> {
  const fixture = await packageFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    expect(fixture.db.prepare(
      'SELECT COUNT(*) count FROM graph_edges',
    ).get()?.count).toBeGreaterThan(0);
    const before = graphGenerationSnapshot(fixture.db);
    const surface = providerSurface(fixture.db);
    mutation.apply(surface.value);
    fixture.db.prepare(`UPDATE repositories
      SET package_public_surface_json=? WHERE id=?`).run(
      JSON.stringify(surface.value), surface.id,
    );
    expectBoundedLifecycle(fixture);
    expectBoundedReaders(fixture, before);
    expectBoundedLink(fixture, before);
  } finally {
    fixture.db.close();
  }
}

describe('nested package-surface lifecycle validation', () => {
  it.each(surfaceMutations)(
    'bounds $label before trace, doctor, or link', verifyMutation,
  );
});
