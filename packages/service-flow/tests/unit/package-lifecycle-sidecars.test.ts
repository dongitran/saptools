import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import {
  invalidPackageFactCategories,
} from '../../src/db/package-fact-semantics.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import {
  prepareWorkspace,
  writeFixtureFile,
} from './test-workspace.js';

interface Fixture {
  db: Db;
  workspaceId: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected record');
  return value as Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return record(JSON.parse(JSON.stringify(value)) as unknown);
}

async function packageFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-package-lifecycle-'));
  await Promise.all([
    writeFixtureFile(root, 'consumer/.git-fixture'),
    writeFixtureFile(root, 'consumer/package.json', JSON.stringify({
      name: '@neutral/consumer',
      dependencies: { '@neutral/provider': '1.0.0' },
    })),
    writeFixtureFile(root, 'consumer/src/entry.ts', `
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
      export function unreferenced(): void {}
    `),
  ]);
  return prepareWorkspace(root);
}

function categoryCount(
  fixture: Fixture,
  category: string,
  phase: 'pre_package' | 'terminal',
): number {
  return invalidPackageFactCategories(
    fixture.db, fixture.workspaceId, phase,
  ).find((item) => item.category === category)?.count ?? 0;
}

function graphSnapshot(db: Db): string {
  return JSON.stringify(db.prepare(`SELECT * FROM graph_edges
    ORDER BY id`).all());
}

function providerSymbol(
  db: Db,
): { id: number; evidence: Record<string, unknown> } {
  const row = db.prepare(`SELECT s.id,s.evidence_json evidenceJson
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE r.package_name='@neutral/provider'
      AND s.qualified_name='unreferenced'`).get();
  if (typeof row?.id !== 'number' || typeof row.evidenceJson !== 'string')
    throw new Error('Expected unreferenced provider symbol');
  return {
    id: row.id,
    evidence: record(JSON.parse(row.evidenceJson) as unknown),
  };
}

function updateSymbolEvidence(
  db: Db,
  id: number,
  evidence: Record<string, unknown>,
): void {
  db.prepare('UPDATE symbols SET evidence_json=? WHERE id=?').run(
    JSON.stringify(evidence), id,
  );
}

function sidecarOf(
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return record(evidence.packagePublicSurface);
}

function exposuresOf(
  sidecar: Record<string, unknown>,
): unknown[] {
  if (!Array.isArray(sidecar.exposures))
    throw new Error('Expected exposure array');
  return sidecar.exposures;
}

function sidecarMutations(): Array<
  (evidence: Record<string, unknown>) => void
> {
  return [
    (evidence) => { sidecarOf(evidence).schema = 'wrong-schema'; },
    (evidence) => {
      record(sidecarOf(evidence).bodyEligibility).eligible = false;
    },
    (evidence) => { exposuresOf(sidecarOf(evidence)).push({}); },
    (evidence) => {
      const values = exposuresOf(sidecarOf(evidence));
      values.push(values[0]);
      sidecarOf(evidence).exposureTotal = values.length;
      sidecarOf(evidence).shownExposureCount = values.length;
    },
    (evidence) => { sidecarOf(evidence).recordCap = 255; },
    (evidence) => { sidecarOf(evidence).exposureTotal = 99; },
    (evidence) => {
      sidecarOf(evidence).exposures = [];
      sidecarOf(evidence).exposureTotal = 0;
      sidecarOf(evidence).shownExposureCount = 0;
    },
    (evidence) => {
      record(exposuresOf(sidecarOf(evidence))[0]).publicName = 'absent';
    },
  ];
}

function expectRejectedWithoutGraphMutation(
  fixture: Fixture,
  graph: string,
): void {
  expect(categoryCount(
    fixture, 'symbol_package_public_surface_invalid', 'pre_package',
  )).toBeGreaterThan(0);
  expect(() => linkWorkspace(fixture.db, fixture.workspaceId))
    .toThrow(/symbol_package_public_surface_invalid/);
  expect(graphSnapshot(fixture.db)).toBe(graph);
}

function providerSurfaceRow(
  db: Db,
): { id: number; surface: Record<string, unknown> } {
  const row = db.prepare(`SELECT id,
    package_public_surface_json surfaceJson FROM repositories
    WHERE package_name='@neutral/provider'`).get();
  if (typeof row?.id !== 'number' || typeof row.surfaceJson !== 'string')
    throw new Error('Expected provider surface');
  return {
    id: row.id,
    surface: record(JSON.parse(row.surfaceJson) as unknown),
  };
}

function removeUnreferencedScope(surface: Record<string, unknown>): void {
  if (!Array.isArray(surface.scopes) || !Array.isArray(surface.entries))
    throw new Error('Expected package surface arrays');
  const entries: unknown[] = surface.entries;
  const scopes = surface.scopes.filter((value) =>
    record(value).publicName !== 'unreferenced');
  surface.scopes = scopes;
  const represented = surfaceRecordCount(entries, scopes);
  surface.total = represented;
  surface.shown = represented;
  surface.omitted = 0;
}

function surfaceRecordCount(
  entries: readonly unknown[],
  scopes: readonly unknown[],
): number {
  return entries.length + scopes.reduce<number>((total, value) => {
    const scope = record(value);
    if (!Array.isArray(scope.targets)) throw new Error('Expected targets');
    return total + 1 + scope.targets.length;
  }, 0);
}

async function verifiesImportSourceIdentity(): Promise<void> {
  const fixture = await packageFixture();
  try {
    const call = fixture.db.prepare(`SELECT id,import_source importSource
      FROM symbol_calls WHERE import_source='@neutral/provider'`).get();
    if (typeof call?.id !== 'number' || typeof call.importSource !== 'string')
      throw new Error('Expected package import call');
    fixture.db.prepare('UPDATE symbol_calls SET import_source=? WHERE id=?')
      .run('@neutral/other', call.id);
    expect(categoryCount(
      fixture, 'package_import_fact_or_target_invalid', 'pre_package',
    )).toBe(1);
    fixture.db.prepare('UPDATE symbol_calls SET import_source=? WHERE id=?')
      .run(call.importSource, call.id);
    linkWorkspace(fixture.db, fixture.workspaceId);
    const graph = graphSnapshot(fixture.db);
    fixture.db.prepare('UPDATE symbol_calls SET import_source=? WHERE id=?')
      .run('@neutral/other', call.id);
    expect(categoryCount(
      fixture, 'package_import_fact_or_target_invalid', 'terminal',
    )).toBe(1);
    expect(() => linkWorkspace(fixture.db, fixture.workspaceId))
      .toThrow(/package_import_fact_or_target_invalid/);
    expect(graphSnapshot(fixture.db)).toBe(graph);
  } finally {
    fixture.db.close();
  }
}

async function verifiesImportedPublicNameIdentity(): Promise<void> {
  const fixture = await packageFixture();
  try {
    const row = fixture.db.prepare(`SELECT id,evidence_json evidenceJson
      FROM symbol_calls WHERE import_source='@neutral/provider'`).get();
    if (typeof row?.id !== 'number' || typeof row.evidenceJson !== 'string')
      throw new Error('Expected package call evidence');
    const evidence = record(JSON.parse(row.evidenceJson) as unknown);
    evidence.targetName = 'hidden';
    fixture.db.prepare(
      'UPDATE symbol_calls SET evidence_json=? WHERE id=?',
    ).run(JSON.stringify(evidence), row.id);
    expect(categoryCount(
      fixture, 'package_import_fact_or_target_invalid', 'pre_package',
    )).toBe(1);
  } finally {
    fixture.db.close();
  }
}

async function rejectsMalformedSidecars(): Promise<void> {
  const fixture = await packageFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    const graph = graphSnapshot(fixture.db);
    const symbol = providerSymbol(fixture.db);
    for (const mutate of sidecarMutations()) {
      const evidence = cloneRecord(symbol.evidence);
      mutate(evidence);
      updateSymbolEvidence(fixture.db, symbol.id, evidence);
      expectRejectedWithoutGraphMutation(fixture, graph);
    }
    const missing = cloneRecord(symbol.evidence);
    delete missing.packagePublicSurface;
    updateSymbolEvidence(fixture.db, symbol.id, missing);
    expectRejectedWithoutGraphMutation(fixture, graph);
    updateSymbolEvidence(fixture.db, symbol.id, symbol.evidence);
    fixture.db.prepare('UPDATE symbols SET start_offset=? WHERE id=?')
      .run('bad', symbol.id);
    expectRejectedWithoutGraphMutation(fixture, graph);
  } finally {
    fixture.db.close();
  }
}

async function rejectsUncorrelatedScope(): Promise<void> {
  const fixture = await packageFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    const graph = graphSnapshot(fixture.db);
    const repository = providerSurfaceRow(fixture.db);
    const changed = cloneRecord(repository.surface);
    removeUnreferencedScope(changed);
    fixture.db.prepare(`UPDATE repositories
      SET package_public_surface_json=? WHERE id=?`).run(
      JSON.stringify(changed), repository.id,
    );
    expectRejectedWithoutGraphMutation(fixture, graph);
  } finally {
    fixture.db.close();
  }
}

describe('package lifecycle relational and sidecar proof', () => {
  it('requires relational import_source to equal typed package provenance',
    verifiesImportSourceIdentity);
  it('requires targetName to equal the imported public name',
    verifiesImportedPublicNameIdentity);
  it('rejects every malformed or uncorrelated unreferenced sidecar',
    rejectsMalformedSidecars);
  it('cross-proves symbol exposures against repository surface scopes',
    rejectsUncorrelatedScope);
});
