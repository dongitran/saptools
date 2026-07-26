import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPackageInvalidationBatch,
  finalizePackageTargetInvalidations,
} from '../../src/db/package-target-invalidation.js';
import {
  PreparedRepositorySnapshotError,
  type PreparedRepositoryFactKind,
  type PreparedSnapshotFailureCode,
} from '../../src/db/index-publication-failure.js';
import { repoByName } from '../../src/db/repositories.js';
import {
  prepareRepositoryIndex,
  publishPreparedRepositoryIndex,
  type PreparedRepositoryIndex,
} from '../../src/indexer/repository-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import type {
  ExecutableSymbolFact,
  OutboundCallFact,
  ServiceBindingFact,
  ServiceBindingReference,
} from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const source = `
function unrelated(): void { const marker = 1; void marker; }
export async function run(): Promise<void> {
  const remote = await cds.connect.to('target-api');
  await remote.send({ method: 'POST', path: '/run' });
}
`;

interface PreparedFacts {
  calls: OutboundCallFact[];
  bindings: ServiceBindingFact[];
  symbols: ExecutableSymbolFact[];
}

async function fixture(): Promise<{
  prepared: PreparedRepositoryIndex;
  db: Awaited<ReturnType<typeof prepareWorkspace>>['db'];
}> {
  const root = await mkdtemp(path.join(
    os.tmpdir(), 'sf-binding-publication-',
  ));
  await writeFixtureFile(root, 'neutral/.git-fixture');
  await writeFixtureFile(root, 'neutral/package.json', JSON.stringify({
    name: '@neutral/binding-publication',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, 'neutral/src/run.ts', source);
  const state = await prepareWorkspace(root);
  linkWorkspace(state.db, state.workspaceId);
  const repo = repoByName(state.db, 'neutral', state.workspaceId);
  if (!repo) throw new Error('Expected neutral repository');
  const prepared = await prepareRepositoryIndex(repo, true);
  return { prepared, db: state.db };
}

function facts(prepared: PreparedRepositoryIndex): PreparedFacts {
  if (!prepared.parsed)
    throw new Error('Expected prepared repository facts');
  return prepared.parsed;
}

function remoteCall(prepared: PreparedRepositoryIndex): OutboundCallFact {
  const call = facts(prepared).calls.find((item) =>
    item.serviceVariableName === 'remote');
  if (!call) throw new Error('Expected prepared remote call');
  return call;
}

function reference(call: OutboundCallFact): ServiceBindingReference {
  if (!call.serviceBindingReference
    || call.serviceBindingReference.status !== 'resolved_exact')
    throw new Error('Expected exact service-binding reference');
  return call.serviceBindingReference;
}

function snapshot(
  db: Awaited<ReturnType<typeof prepareWorkspace>>['db'],
): string {
  return JSON.stringify({
    repositories: db.prepare('SELECT * FROM repositories ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM service_bindings ORDER BY id').all(),
    calls: db.prepare('SELECT * FROM outbound_calls ORDER BY id').all(),
    edges: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
  });
}

function publishPrepared(
  db: Awaited<ReturnType<typeof prepareWorkspace>>['db'],
  prepared: PreparedRepositoryIndex,
): void {
  db.transaction(() => {
    const batch = createPackageInvalidationBatch([prepared.repo.id]);
    publishPreparedRepositoryIndex(db, prepared, batch);
    finalizePackageTargetInvalidations(db, batch);
  });
}

function expectSnapshotFailure(
  publish: () => void,
  failureCode: PreparedSnapshotFailureCode,
  factKind: PreparedRepositoryFactKind,
  sourceLine: number,
): void {
  let caught: unknown;
  try {
    publish();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedRepositorySnapshotError);
  if (!(caught instanceof PreparedRepositorySnapshotError))
    throw new Error('Expected structured prepared snapshot failure');
  expect(caught).toMatchObject({
    message: `invalid_prepared_repository_snapshot:${failureCode}`,
    failureCode,
    site: {
      factKind,
      sourceFile: 'src/run.ts',
      sourceLine,
    },
  });
  expect(typeof caught.site.callSiteStartOffset).toBe('number');
  expect(typeof caught.site.callSiteEndOffset).toBe('number');
}

function forgeScopeIndex(prepared: PreparedRepositoryIndex): void {
  const call = remoteCall(prepared);
  const current = reference(call);
  call.serviceBindingReference = {
    ...current,
    bindingScopeIndex: current.scopeChainTotal,
  };
}

function forgeDeclarationAfterCall(prepared: PreparedRepositoryIndex): void {
  const call = remoteCall(prepared);
  const current = reference(call);
  const binding = facts(prepared).bindings.find((item) =>
    item.variableName === 'remote');
  if (!binding || call.callSiteEndOffset === undefined)
    throw new Error('Expected prepared call and binding spans');
  const start = call.callSiteEndOffset + 1;
  binding.bindingSiteStartOffset = start;
  binding.bindingSiteEndOffset = start + 1;
  call.serviceBindingReference = {
    ...current,
    bindingSiteStartOffset: start,
    bindingSiteEndOffset: start + 1,
  };
}

function forgeNonContainingOwner(prepared: PreparedRepositoryIndex): void {
  const call = remoteCall(prepared);
  const current = reference(call);
  const binding = facts(prepared).bindings.find((item) =>
    item.variableName === 'remote');
  const owner = facts(prepared).symbols.find((item) =>
    item.qualifiedName === 'unrelated');
  if (!binding || !owner)
    throw new Error('Expected prepared binding and unrelated owner');
  const start = owner.startOffset + 1;
  binding.bindingSiteStartOffset = start;
  binding.bindingSiteEndOffset = start + 1;
  binding.sourceSymbolQualifiedName = owner.qualifiedName;
  call.serviceBindingReference = {
    ...current,
    bindingSiteStartOffset: start,
    bindingSiteEndOffset: start + 1,
  };
}

function forgeDuplicateSite(prepared: PreparedRepositoryIndex): void {
  const binding = facts(prepared).bindings.find((item) =>
    item.variableName === 'remote');
  if (!binding) throw new Error('Expected prepared binding');
  facts(prepared).bindings.push({ ...binding });
}

describe('binding proof publication atomicity', () => {
  it.each([
    ['out-of-range scope index', forgeScopeIndex],
    ['declaration after call', forgeDeclarationAfterCall],
    ['binding owner that does not contain the call', forgeNonContainingOwner],
  ])('rejects a forged %s before replacing prior facts', async (
    _label,
    forge,
  ) => {
    const { prepared, db } = await fixture();
    try {
      const before = snapshot(db);
      forge(prepared);
      expectSnapshotFailure(
        () => publishPrepared(db, prepared),
        'binding_lexical_proof_invalid',
        'outbound_call',
        5,
      );
      expect(snapshot(db)).toBe(before);
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate exact binding site before facts escape', async () => {
    const { prepared, db } = await fixture();
    try {
      const before = snapshot(db);
      forgeDuplicateSite(prepared);
      expectSnapshotFailure(
        () => publishPrepared(db, prepared),
        'duplicate_service_binding_site',
        'service_binding',
        4,
      );
      expect(snapshot(db)).toBe(before);
    } finally {
      db.close();
    }
  });
});
