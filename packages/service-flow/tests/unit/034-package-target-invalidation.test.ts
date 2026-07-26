import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import {
  createPackageInvalidationBatch,
  finalizePackageTargetInvalidations,
  invalidatePackageTargetFacts,
} from '../../src/db/004-package-target-invalidation.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import {
  prepareWorkspace,
  writeFixtureFile,
} from './test-workspace.js';

interface Fixture {
  db: Db;
  root: string;
  workspaceId: number;
}

interface PackageCallState {
  expression: string;
  status: string;
  reason: string | null;
  calleeId: number | null;
  evidence: Record<string, unknown>;
}

const packageFiles: ReadonlyArray<readonly [string, string]> = [
  ['consumer/.git-fixture', ''],
  ['consumer/package.json', JSON.stringify({
    name: '@neutral/consumer',
    dependencies: {
      '@neutral/provider': '1.0.0',
      '@neutral/idle': '1.0.0',
    },
  })],
  ['consumer/src/entry.ts', `
    import { steady, changing, missing } from '@neutral/provider';
    export function runLifecycle(): void { steady(); changing(); missing(); }
  `],
  ['provider/.git-fixture', ''],
  ['provider/package.json', JSON.stringify({
    name: '@neutral/provider',
    exports: './src/index.ts',
  })],
  ['provider/src/index.ts', `
    export * from './steady';
    export * from './changing-a';
    export * from './changing-b';
  `],
  ['provider/src/steady.ts', 'export function steady(): void {}\n'],
  ['provider/src/changing-a.ts', 'export function changing(): void {}\n'],
  ['provider/src/changing-b.ts', 'export function changing(): void {}\n'],
  ['shadow-provider/.git-fixture', ''],
  ['shadow-provider/package.json', JSON.stringify({
    name: '@neutral/shadow-provider',
    exports: './src/index.ts',
  })],
  ['shadow-provider/src/index.ts', `
    export function steady(): void {}
    export function changing(): void {}
    export function missing(): void {}
  `],
  ['idle/.git-fixture', ''],
  ['idle/package.json', JSON.stringify({
    name: '@neutral/idle',
    exports: './src/index.ts',
  })],
  ['idle/src/index.ts', 'export function idle(): void {}\n'],
];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected record');
  return value as Record<string, unknown>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'sf-package-target-invalidation-'),
  );
  await Promise.all(packageFiles.map(([relative, content]) =>
    writeFixtureFile(root, relative, content)));
  const prepared = await prepareWorkspace(root);
  return { ...prepared, root };
}

function repository(
  db: Db,
  name: string,
): { id: number; generation: number; staleReason: string | null } {
  const row = db.prepare(`SELECT id,fact_generation generation,
    graph_stale_reason staleReason FROM repositories WHERE name=?`).get(name);
  if (typeof row?.id !== 'number' || typeof row.generation !== 'number')
    throw new Error(`Expected repository ${name}`);
  return {
    id: row.id,
    generation: row.generation,
    staleReason: typeof row.staleReason === 'string'
      ? row.staleReason : null,
  };
}

function packageCallStates(db: Db): PackageCallState[] {
  return db.prepare(`SELECT sc.callee_expression expression,sc.status,
    sc.unresolved_reason reason,sc.callee_symbol_id calleeId,
    sc.evidence_json evidenceJson FROM symbol_calls sc
    JOIN repositories r ON r.id=sc.repo_id
    WHERE r.name='consumer'
      AND json_extract(sc.evidence_json,'$.relation')='package_import'
    ORDER BY sc.callee_expression COLLATE BINARY`).all().map((row) => ({
      expression: String(row.expression ?? ''),
      status: String(row.status ?? ''),
      reason: typeof row.reason === 'string' ? row.reason : null,
      calleeId: typeof row.calleeId === 'number' ? row.calleeId : null,
      evidence: record(JSON.parse(String(row.evidenceJson)) as unknown),
    }));
}

function state(
  rows: readonly PackageCallState[],
  expression: string,
): PackageCallState {
  const found = rows.find((row) => row.expression === expression);
  if (!found) throw new Error(`Expected package call ${expression}`);
  return found;
}

function expectInitialMatrix(rows: readonly PackageCallState[]): void {
  expect(state(rows, 'steady')).toMatchObject({
    status: 'resolved', reason: null,
  });
  expect(state(rows, 'changing')).toMatchObject({
    status: 'ambiguous', reason: 'package_public_target_ambiguous',
  });
  expect(state(rows, 'missing')).toMatchObject({
    status: 'unresolved', reason: 'package_public_name_not_exposed',
  });
}

function expectExactPending(rows: readonly PackageCallState[]): void {
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toMatchObject({
      status: 'unresolved',
      reason: 'package_resolution_pending',
      calleeId: null,
    });
    expect(row.evidence).toMatchObject({
      relation: 'package_import',
      candidateStrategy: 'package_import_pending',
      candidateCount: 0,
      eligibleCandidateCount: 0,
      selectedCandidateCount: 0,
      candidateSetComplete: false,
      unresolvedReason: 'package_resolution_pending',
    });
    expect(record(row.evidence.importBinding)).toMatchObject({
      moduleKind: 'package',
      requestedPackageName: '@neutral/provider',
      requestedModuleSubpath: '.',
    });
    for (const key of [
      'resolvedModulePath', 'resolvedTargetRepositoryId',
      'targetRepositoryCandidates', 'publicSurface',
    ]) expect(Object.hasOwn(row.evidence, key)).toBe(false);
  }
}

function expectWorkspaceStale(db: Db, reason: string | null): void {
  const rows = db.prepare(`SELECT graph_stale_reason reason
    FROM repositories ORDER BY id`).all();
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => (row.reason ?? null) === reason)).toBe(true);
}

function expectPendingDoctor(db: Db): void {
  const diagnostics = doctorDiagnostics(db, true);
  const pending = diagnostics.find((item) =>
    item.code === 'package_import_resolution_pending');
  expect(pending).toMatchObject({
    packageResolutionState: 'pre_link_pending',
    pendingPackageImportCount: 3,
    graphState: 'stale',
    requiredAction: 'relink',
  });
  const quality = diagnostics.find((item) =>
    item.code === 'strict_symbol_call_quality');
  expect(quality).toMatchObject({
    total: 0,
    unresolved: 0,
    topUnresolvedCallees: [],
  });
}

function expectPendingWithoutStaleMarker(fixture: Fixture): void {
  fixture.db.prepare(
    'UPDATE repositories SET graph_stale_reason=NULL WHERE workspace_id=?',
  ).run(fixture.workspaceId);
  const result = trace(fixture.db, { repo: 'consumer' }, {
    depth: 25,
    workspaceId: fixture.workspaceId,
  });
  expect(result.diagnostics.find((item) =>
    item.code === 'package_import_resolution_pending')).toMatchObject({
    packageResolutionState: 'pre_link_pending',
    pendingPackageImportCount: 3,
    graphState: 'stale',
    requiredAction: 'relink',
  });
  expect(doctorDiagnostics(fixture.db, true).find((item) =>
    item.code === 'package_import_resolution_pending')).toMatchObject({
    graphState: 'stale',
    staleRepositoryCount: 0,
    requiredAction: 'relink',
  });
  fixture.db.prepare(`UPDATE repositories
    SET graph_stale_reason='package_target_facts_changed'
    WHERE workspace_id=?`).run(fixture.workspaceId);
}

function symbolCount(db: Db, repoId: number): number {
  return Number(db.prepare(
    'SELECT COUNT(*) count FROM symbols WHERE repo_id=?',
  ).get(repoId)?.count ?? 0);
}

function publicationSnapshot(db: Db, providerId: number): string {
  return JSON.stringify({
    repositories: db.prepare(`SELECT id,index_status indexStatus,
      fingerprint,fact_generation factGeneration,
      graph_generation graphGeneration,graph_stale_reason graphStaleReason
      FROM repositories ORDER BY id`).all(),
    providerSymbols: db.prepare(`SELECT * FROM symbols
      WHERE repo_id=? ORDER BY id`).all(providerId),
    packageCalls: db.prepare(`SELECT * FROM symbol_calls
      WHERE json_extract(evidence_json,'$.relation')='package_import'
      ORDER BY id`).all(),
    graphEdges: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
  });
}

function helperMatch(
  db: Db,
  targetRepoId: number,
): string | undefined {
  const row = db.prepare(`SELECT evidence_json evidenceJson
    FROM graph_edges WHERE edge_type='REPO_IMPORTS_HELPER_PACKAGE'
      AND to_kind='repo' AND to_id=?`).get(String(targetRepoId));
  if (typeof row?.evidenceJson !== 'string') return undefined;
  const evidence = record(JSON.parse(row.evidenceJson) as unknown);
  return typeof evidence.match === 'string' ? evidence.match : undefined;
}

function corruptPackageImportBinding(db: Db): void {
  const row = db.prepare(`SELECT id,evidence_json evidenceJson
    FROM symbol_calls
    WHERE json_extract(evidence_json,'$.relation')='package_import'
    ORDER BY id LIMIT 1`).get();
  if (typeof row?.id !== 'number' || typeof row.evidenceJson !== 'string')
    throw new Error('Expected package import row');
  const evidence = record(JSON.parse(row.evidenceJson) as unknown);
  delete record(evidence.importBinding).requestedPackageName;
  db.prepare('UPDATE symbol_calls SET evidence_json=? WHERE id=?').run(
    JSON.stringify(evidence), row.id,
  );
}

async function verifyDirectInvalidation(): Promise<void> {
  const fixture = await createFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    expectInitialMatrix(packageCallStates(fixture.db));
    const provider = repository(fixture.db, 'provider');
    const consumer = repository(fixture.db, 'consumer');
    const beforeSymbols = symbolCount(fixture.db, provider.id);
    const batch = createPackageInvalidationBatch([provider.id]);
    invalidatePackageTargetFacts(
      fixture.db, provider.id, '@neutral/provider', batch,
    );
    expectExactPending(packageCallStates(fixture.db));
    expect(symbolCount(fixture.db, provider.id)).toBe(beforeSymbols);
    finalizePackageTargetInvalidations(fixture.db, batch);
    expect(repository(fixture.db, 'consumer').generation)
      .toBe(consumer.generation + 1);
    expect(repository(fixture.db, 'provider').generation)
      .toBe(provider.generation);
    expectWorkspaceStale(fixture.db, 'package_target_facts_changed');
    expectPendingDoctor(fixture.db);
    expectPendingWithoutStaleMarker(fixture);
    linkWorkspace(fixture.db, fixture.workspaceId);
    verifyNoMatchLeavesWorkspaceUnchanged(fixture);
  } finally {
    fixture.db.close();
  }
}

function verifyNoMatchLeavesWorkspaceUnchanged(
  fixture: Fixture,
): void {
  const idle = repository(fixture.db, 'idle');
  const consumer = repository(fixture.db, 'consumer');
  const batch = createPackageInvalidationBatch([idle.id]);
  invalidatePackageTargetFacts(
    fixture.db, idle.id, '@neutral/idle', batch,
  );
  finalizePackageTargetInvalidations(fixture.db, batch);
  expect(repository(fixture.db, 'consumer').generation)
    .toBe(consumer.generation);
  expectWorkspaceStale(fixture.db, null);
}

async function publishCorrectedSurface(fixture: Fixture): Promise<void> {
  await Promise.all([
    writeFixtureFile(fixture.root, 'provider/src/index.ts', `
      export * from './steady';
      export * from './changing-a';
      export * from './missing';
    `),
    writeFixtureFile(
      fixture.root,
      'provider/src/missing.ts',
      'export function missing(): void {}\n',
    ),
  ]);
  await indexWorkspace(fixture.db, fixture.workspaceId, {
    repo: 'provider', force: true,
  });
}

async function verifySurfaceChangeAndRename(): Promise<void> {
  const fixture = await createFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    expectInitialMatrix(packageCallStates(fixture.db));
    const before = repository(fixture.db, 'consumer').generation;
    await publishCorrectedSurface(fixture);
    expectExactPending(packageCallStates(fixture.db));
    expect(repository(fixture.db, 'consumer').generation).toBe(before + 1);
    expectWorkspaceStale(fixture.db, 'package_target_facts_changed');
    linkWorkspace(fixture.db, fixture.workspaceId);
    expect(packageCallStates(fixture.db).every(
      (row) => row.status === 'resolved' && row.calleeId !== null,
    )).toBe(true);
    await verifyOldPackageNameInvalidation(fixture);
  } finally {
    fixture.db.close();
  }
}

async function verifyOldPackageNameInvalidation(
  fixture: Fixture,
): Promise<void> {
  const before = repository(fixture.db, 'consumer').generation;
  await writeFixtureFile(
    fixture.root,
    'provider/package.json',
    JSON.stringify({
      name: '@neutral/renamed-provider',
      exports: './src/index.ts',
    }),
  );
  await indexWorkspace(fixture.db, fixture.workspaceId, {
    repo: 'provider', force: true,
  });
  expectExactPending(packageCallStates(fixture.db));
  expect(repository(fixture.db, 'consumer').generation).toBe(before + 1);
  expectWorkspaceStale(fixture.db, 'package_target_facts_changed');
  linkWorkspace(fixture.db, fixture.workspaceId);
  expect(packageCallStates(fixture.db).every((row) =>
    row.status === 'unresolved'
    && row.reason === 'package_repository_not_indexed')).toBe(true);
}

async function verifyDuplicatePackageScope(): Promise<void> {
  const fixture = await createFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    expect(state(packageCallStates(fixture.db), 'steady').status)
      .toBe('resolved');
    const before = repository(fixture.db, 'consumer').generation;
    await writeFixtureFile(
      fixture.root,
      'shadow-provider/package.json',
      JSON.stringify({
        name: '@neutral/provider',
        exports: './src/index.ts',
      }),
    );
    await indexWorkspace(fixture.db, fixture.workspaceId, {
      repo: 'shadow-provider', force: true,
    });
    expectExactPending(packageCallStates(fixture.db));
    expect(repository(fixture.db, 'consumer').generation).toBe(before + 1);
    expectWorkspaceStale(fixture.db, 'package_target_facts_changed');
    linkWorkspace(fixture.db, fixture.workspaceId);
    expectDuplicateScope(packageCallStates(fixture.db));
  } finally {
    fixture.db.close();
  }
}

async function verifyDependencyOnlyRenameStalesWorkspace(): Promise<void> {
  const fixture = await createFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    const idle = repository(fixture.db, 'idle');
    const consumer = repository(fixture.db, 'consumer');
    expect(helperMatch(fixture.db, idle.id)).toBe('exact_package_name');
    await writeFixtureFile(
      fixture.root,
      'idle/package.json',
      JSON.stringify({
        name: '@neutral/renamed-idle',
        exports: './src/index.ts',
      }),
    );
    await indexWorkspace(fixture.db, fixture.workspaceId, {
      repo: 'idle', force: true,
    });
    expect(repository(fixture.db, 'consumer').generation)
      .toBe(consumer.generation);
    expectWorkspaceStale(fixture.db, 'package_target_facts_changed');
    expect(helperMatch(fixture.db, idle.id)).toBe('exact_package_name');
    linkWorkspace(fixture.db, fixture.workspaceId);
    expect(helperMatch(fixture.db, idle.id)).toBe('normalized_directory');
  } finally {
    fixture.db.close();
  }
}

async function verifyMalformedCurrentEvidenceFailsClosed(): Promise<void> {
  const fixture = await createFixture();
  try {
    linkWorkspace(fixture.db, fixture.workspaceId);
    const provider = repository(fixture.db, 'provider');
    corruptPackageImportBinding(fixture.db);
    const before = publicationSnapshot(fixture.db, provider.id);
    await expect(indexWorkspace(fixture.db, fixture.workspaceId, {
      repo: 'provider', force: true,
    })).rejects.toThrow('invalid_current_package_import_evidence');
    expect(publicationSnapshot(fixture.db, provider.id)).toBe(before);
  } finally {
    fixture.db.close();
  }
}

function expectDuplicateScope(rows: readonly PackageCallState[]): void {
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toMatchObject({
      status: 'unresolved',
      reason: 'package_repository_scope_ambiguous',
      calleeId: null,
    });
    expect(row.evidence).toMatchObject({
      candidateStrategy: 'package_public_surface_unresolved',
      candidateCount: 2,
      eligibleCandidateCount: 0,
      selectedCandidateCount: 0,
      candidateSetComplete: false,
      targetRepositoryCandidateCount: 2,
      shownTargetRepositoryCandidateCount: 2,
      omittedTargetRepositoryCandidateCount: 0,
    });
    expect(row.evidence.targetRepositoryCandidates).toHaveLength(2);
  }
}

describe('package target invalidation lifecycle', () => {
  it('resets every prior status before target deletion and updates lifecycle once', async () => {
    await verifyDirectInvalidation();
  });

  it('reevaluates unresolved and ambiguous calls after surface change and rename', async () => {
    await verifySurfaceChangeAndRename();
  });

  it('fails closed when a sibling is renamed to a duplicate package name', async () => {
    await verifyDuplicatePackageScope();
  });

  it('stales helper edges when a dependency-only provider is renamed', async () => {
    await verifyDependencyOnlyRenameStalesWorkspace();
  });

  it('rejects malformed current package provenance before target publication', async () => {
    await verifyMalformedCurrentEvidenceFailsClosed();
  });
});
