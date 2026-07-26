import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexCommandOutcome } from
  '../../src/cli/001-index-summary.js';
import type { Db } from '../../src/db/connection.js';
import {
  listRepositories,
  repoByName,
} from '../../src/db/repositories.js';
import {
  claimIndexRun,
  indexWorkspace,
  publishPreparedWorkspaceRows,
} from '../../src/indexer/workspace-indexer.js';
import {
  prepareRepositoryIndex,
  type PreparedRepositoryIndex,
} from '../../src/indexer/repository-indexer.js';
import type {
  PreparedRepositoryFactKind,
  PreparedSnapshotFailureCode,
} from '../../src/db/013-index-publication-failure.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import type {
  OutboundCallFact,
  ServiceBindingFact,
  ServiceBindingReference,
  SymbolCallFact,
} from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const brokenSource = `
function helper(): void {}
export async function run(): Promise<void> {
  const remote = await cds.connect.to('target-api');
  helper();
  await remote.send({ method: 'POST', path: '/run' });
}
`;

async function createFixture(): Promise<{
  db: Db;
  workspaceId: number;
}> {
  const root = await mkdtemp(path.join(
    os.tmpdir(), 'sf-index-partial-publication-',
  ));
  await Promise.all([
    repositoryFiles(root, 'alpha', brokenSource),
    repositoryFiles(root, 'broken', brokenSource),
    repositoryFiles(root, 'zeta', brokenSource),
  ]);
  const fixture = await prepareWorkspace(root);
  linkWorkspace(fixture.db, fixture.workspaceId);
  return fixture;
}

async function repositoryFiles(
  root: string,
  name: string,
  source: string,
): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, `${name}/.git-fixture`),
    writeFixtureFile(root, `${name}/package.json`, JSON.stringify({
      name: `@neutral/${name}`,
      version: '1.0.0',
    })),
    writeFixtureFile(root, `${name}/src/run.ts`, source),
  ]);
}

async function createPackageFixture(): Promise<{
  db: Db;
  workspaceId: number;
}> {
  const root = await mkdtemp(path.join(
    os.tmpdir(), 'sf-index-failed-package-target-',
  ));
  await Promise.all([
    repositoryFiles(root, 'consumer', `
      import { work } from '@neutral/provider';
      export function start(): void { work(); }
    `),
    writeFixtureFile(root, 'provider/.git-fixture'),
    writeFixtureFile(root, 'provider/package.json', JSON.stringify({
      name: '@neutral/provider',
      version: '1.0.0',
      exports: './src/run.ts',
    })),
    writeFixtureFile(root, 'provider/src/run.ts', `
      export function work(): void {}
      export async function probe(): Promise<void> {
        const remote = await cds.connect.to('target-api');
        await remote.send({ method: 'POST', path: '/probe' });
      }
    `),
  ]);
  const fixture = await prepareWorkspace(root);
  linkWorkspace(fixture.db, fixture.workspaceId);
  return fixture;
}

async function preparedRows(
  db: Db,
  workspaceId: number,
): Promise<PreparedRepositoryIndex[]> {
  const rows: PreparedRepositoryIndex[] = [];
  for (const repo of listRepositories(db, workspaceId))
    rows.push(await prepareRepositoryIndex(repo, true));
  return rows;
}

type PreparedWithFacts = PreparedRepositoryIndex & {
  parsed: NonNullable<PreparedRepositoryIndex['parsed']>;
};

function forgeDuplicateBinding(
  rows: readonly PreparedRepositoryIndex[],
  repoName = 'broken',
): PreparedRepositoryIndex {
  const prepared = preparedByName(rows, repoName);
  const binding = serviceBinding(prepared);
  prepared.parsed.bindings.push({ ...binding });
  return prepared;
}

function preparedByName(
  rows: readonly PreparedRepositoryIndex[],
  repoName = 'broken',
): PreparedWithFacts {
  const prepared = rows.find((row) => row.repo.name === repoName);
  if (!prepared?.parsed)
    throw new Error(`Expected prepared facts for ${repoName}`);
  return {
    ...prepared,
    parsed: prepared.parsed,
  };
}

function serviceBinding(
  prepared: PreparedWithFacts,
): ServiceBindingFact {
  const binding = prepared.parsed.bindings.find((row) =>
    row.variableName === 'remote');
  if (!binding) throw new Error('Expected remote service binding');
  return binding;
}

function outboundCall(
  prepared: PreparedWithFacts,
): OutboundCallFact {
  const call = prepared.parsed.calls.find((row) =>
    row.serviceVariableName === 'remote');
  if (!call) throw new Error('Expected remote outbound call');
  return call;
}

function symbolCall(
  prepared: PreparedWithFacts,
): SymbolCallFact {
  const call = prepared.parsed.symbolCalls.find((row) =>
    row.calleeExpression === 'helper');
  if (!call) throw new Error('Expected local helper symbol call');
  return call;
}

function exactReference(call: OutboundCallFact): ServiceBindingReference {
  const reference = call.serviceBindingReference;
  if (!reference || reference.status !== 'resolved_exact')
    throw new Error('Expected exact service binding reference');
  return reference;
}

interface SnapshotFailureCase {
  label: string;
  code: PreparedSnapshotFailureCode;
  factKind: PreparedRepositoryFactKind;
  forge: (prepared: PreparedWithFacts) => number;
}

const snapshotFailureCases: SnapshotFailureCase[] = [
  {
    label: 'missing package provenance',
    code: 'package_import_provenance_missing',
    factKind: 'symbol_call',
    forge: (prepared) => {
      const call = symbolCall(prepared);
      call.importSource = '@neutral/external';
      call.evidence = { ...call.evidence, relation: 'package_import' };
      return call.sourceLine;
    },
  },
  {
    label: 'symbol-call owner mismatch',
    code: 'symbol_call_owner_mismatch',
    factKind: 'symbol_call',
    forge: (prepared) => {
      const call = symbolCall(prepared);
      call.callerQualifiedName = 'missing.owner';
      return call.sourceLine;
    },
  },
  {
    label: 'outbound owner mismatch',
    code: 'outbound_owner_mismatch',
    factKind: 'outbound_call',
    forge: (prepared) => {
      const call = outboundCall(prepared);
      call.sourceSymbolQualifiedName = 'missing.owner';
      return call.sourceLine;
    },
  },
  {
    label: 'missing binding reference',
    code: 'binding_reference_missing',
    factKind: 'outbound_call',
    forge: (prepared) => {
      const call = outboundCall(prepared);
      call.serviceBindingReference = undefined;
      return call.sourceLine;
    },
  },
  {
    label: 'binding reference mismatch',
    code: 'binding_reference_mismatch',
    factKind: 'outbound_call',
    forge: (prepared) => {
      const call = outboundCall(prepared);
      const reference = exactReference(call);
      call.serviceBindingReference = {
        ...reference,
        bindingSiteStartOffset:
          (reference.bindingSiteStartOffset ?? 0) + 100_000,
        bindingSiteEndOffset:
          (reference.bindingSiteEndOffset ?? 0) + 100_000,
      };
      return call.sourceLine;
    },
  },
  {
    label: 'invalid binding lexical proof',
    code: 'binding_lexical_proof_invalid',
    factKind: 'outbound_call',
    forge: (prepared) => {
      const call = outboundCall(prepared);
      const reference = exactReference(call);
      call.serviceBindingReference = {
        ...reference,
        bindingScopeIndex: reference.scopeChainTotal,
      };
      return call.sourceLine;
    },
  },
  {
    label: 'binding owner mismatch',
    code: 'binding_owner_mismatch',
    factKind: 'service_binding',
    forge: (prepared) => {
      const binding = serviceBinding(prepared);
      binding.sourceSymbolQualifiedName = 'missing.owner';
      return binding.sourceLine;
    },
  },
  {
    label: 'missing binding site',
    code: 'binding_site_missing',
    factKind: 'service_binding',
    forge: (prepared) => {
      const binding = serviceBinding(prepared);
      binding.bindingSiteStartOffset = undefined;
      binding.bindingSiteEndOffset = undefined;
      return binding.sourceLine;
    },
  },
  {
    label: 'duplicate binding site',
    code: 'duplicate_service_binding_site',
    factKind: 'service_binding',
    forge: (prepared) => {
      const binding = serviceBinding(prepared);
      prepared.parsed.bindings.push({ ...binding });
      return binding.sourceLine;
    },
  },
];

function repositoryState(
  db: Db,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT name,fingerprint,
    fact_generation factGeneration,graph_generation graphGeneration,
    index_status indexStatus,error_count errorCount
    FROM repositories ORDER BY name COLLATE BINARY`).all();
}

function factsForRepo(db: Db, repoName: string): string {
  const repoId = Number(db.prepare(
    'SELECT id FROM repositories WHERE name=?',
  ).get(repoName)?.id);
  return JSON.stringify({
    files: db.prepare('SELECT * FROM files WHERE repo_id=? ORDER BY id')
      .all(repoId),
    symbols: db.prepare('SELECT * FROM symbols WHERE repo_id=? ORDER BY id')
      .all(repoId),
    bindings: db.prepare(
      'SELECT * FROM service_bindings WHERE repo_id=? ORDER BY id',
    ).all(repoId),
    calls: db.prepare(
      'SELECT * FROM outbound_calls WHERE repo_id=? ORDER BY id',
    ).all(repoId),
  });
}

function graphSnapshot(db: Db): string {
  return JSON.stringify(db.prepare(
    'SELECT * FROM graph_edges ORDER BY id',
  ).all());
}

function consumerPackageState(db: Db): string {
  const call = db.prepare(`SELECT sc.status,sc.callee_symbol_id calleeId,
    sc.unresolved_reason reason,sc.evidence_json evidenceJson,
    r.fact_generation factGeneration
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE r.name='consumer' AND sc.callee_expression='work'`).get();
  return JSON.stringify(call);
}

function rowByName(
  rows: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> {
  const row = rows.find((item) => item.name === name);
  if (!row) throw new Error(`Expected repository state ${name}`);
  return row;
}

describe('workspace prepared-repository publication containment', () => {
  it.each(snapshotFailureCases)(
    'contains $label to its repository',
    async ({ code, factKind, forge }) => {
      const { db, workspaceId } = await createFixture();
      try {
        const before = repositoryState(db);
        const graph = graphSnapshot(db);
        const rows = await preparedRows(db, workspaceId);
        const prepared = preparedByName(rows);
        const sourceLine = forge(prepared);
        const runId = claimIndexRun(db, workspaceId, rows.length);

        const summary = publishPreparedWorkspaceRows(
          db, workspaceId, runId, rows,
        );

        expect(summary.failedRepos).toEqual([{
          name: 'broken',
          code: `invalid_prepared_repository_snapshot:${code}`,
        }]);
        expectPartialRepositoryStates(db, before);
        expectFailureDiagnostic(
          db, 'broken', code, factKind, sourceLine,
        );
        expect(graphSnapshot(db)).toBe(graph);
      } finally {
        db.close();
      }
    },
  );

  it('commits valid repositories and preserves one failed snapshot', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const before = repositoryState(db);
      const brokenFacts = factsForRepo(db, 'broken');
      const graph = graphSnapshot(db);
      const rows = await preparedRows(db, workspaceId);
      forgeDuplicateBinding(rows);
      const runId = claimIndexRun(db, workspaceId, rows.length);

      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, rows,
      );

      expect(summary).toMatchObject({
        repoCount: 3,
        indexedCount: 2,
        skippedCount: 0,
        failedCount: 1,
        failedRepos: [{
          name: 'broken',
          code: 'invalid_prepared_repository_snapshot:duplicate_service_binding_site',
        }],
        diagnosticCount: 1,
      });
      const command = indexCommandOutcome(summary);
      expect(command).toEqual({
        stdout: 'Indexed 2 repositories, skipped 0, failed 1 (broken: invalid_prepared_repository_snapshot:duplicate_service_binding_site), 3 files, 1 diagnostics\n',
        exitCode: 1,
      });
      expect(command.stdout).not.toContain('PreparedRepositorySnapshotError');
      expect(command.stdout).not.toMatch(/\n\s+at /);
      expectPartialRepositoryStates(db, before);
      expect(factsForRepo(db, 'broken')).toBe(brokenFacts);
      expect(graphSnapshot(db)).toBe(graph);
      expectFailureDiagnostic(
        db,
        'broken',
        'duplicate_service_binding_site',
        'service_binding',
        4,
      );
      expect(db.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('marks the run failed when every selected repository fails', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const rows = await preparedRows(db, workspaceId);
      const broken = forgeDuplicateBinding(rows);
      const runId = claimIndexRun(db, workspaceId, 1);
      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, [broken],
      );
      expect(summary).toMatchObject({
        repoCount: 1, indexedCount: 0, failedCount: 1,
        failedRepos: [{
          name: 'broken',
          code: 'invalid_prepared_repository_snapshot:duplicate_service_binding_site',
        }], diagnosticCount: 1,
      });
      expect(db.prepare(`SELECT status,error_message errorMessage
        FROM index_runs WHERE id=?`).get(runId)).toEqual({
        status: 'failed',
        errorMessage: '1 repositories failed index publication.',
      });
      expectFailureDiagnostic(
        db,
        'broken',
        'duplicate_service_binding_site',
        'service_binding',
        4,
      );
    } finally {
      db.close();
    }
  });

  it('discards package invalidation effects from a failed target', async () => {
    const { db, workspaceId } = await createPackageFixture();
    try {
      const provider = repoByName(db, 'provider', workspaceId);
      if (!provider) throw new Error('Expected provider repository');
      const prepared = await prepareRepositoryIndex(provider, true);
      forgeDuplicateBinding([prepared], 'provider');
      const consumer = consumerPackageState(db);
      const graph = graphSnapshot(db);
      expect(consumer).toContain('"status":"resolved"');
      const runId = claimIndexRun(db, workspaceId, 1);

      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, [prepared],
      );

      expect(summary).toMatchObject({
        repoCount: 1, indexedCount: 0, failedCount: 1,
        failedRepos: [{
          name: 'provider',
          code: 'invalid_prepared_repository_snapshot:duplicate_service_binding_site',
        }],
      });
      expect(consumerPackageState(db)).toBe(consumer);
      expect(graphSnapshot(db)).toBe(graph);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(['first', 'last'] as const)(
    'contains a failed repository published %s',
    async (position) => {
      const { db, workspaceId } = await createFixture();
      try {
        const before = repositoryState(db);
        const rows = await preparedRows(db, workspaceId);
        const broken = forgeDuplicateBinding(rows);
        const siblings = rows.filter((row) => row.repo.name !== 'broken');
        const ordered = position === 'first'
          ? [broken, ...siblings] : [...siblings, broken];
        const runId = claimIndexRun(db, workspaceId, ordered.length);

        const summary = publishPreparedWorkspaceRows(
          db, workspaceId, runId, ordered,
        );

        expect(summary).toMatchObject({
          indexedCount: 2,
          failedCount: 1,
        });
        expectPartialRepositoryStates(db, before);
        expectFailureDiagnostic(
          db,
          'broken',
          'duplicate_service_binding_site',
          'service_binding',
          4,
        );
      } finally {
        db.close();
      }
    },
  );

  it('clears a prior publication diagnostic after a valid retry', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const rows = await preparedRows(db, workspaceId);
      const broken = forgeDuplicateBinding(rows);
      const siblingsBefore = ['alpha', 'zeta'].map((name) =>
        factsForRepo(db, name));
      const runId = claimIndexRun(db, workspaceId, 1);
      publishPreparedWorkspaceRows(db, workspaceId, runId, [broken]);

      const summary = await indexWorkspace(db, workspaceId, {
        repo: 'broken',
        force: true,
      });

      expect(summary).toMatchObject({
        repoCount: 1,
        indexedCount: 1,
        failedCount: 0,
      });
      expect(db.prepare(`SELECT index_status indexStatus,error_count errorCount
        FROM repositories WHERE name='broken'`).get()).toEqual({
        indexStatus: 'indexed',
        errorCount: 0,
      });
      expect(db.prepare(`SELECT count(*) count FROM diagnostics d
        JOIN repositories r ON r.id=d.repo_id
        WHERE r.name='broken' AND d.code GLOB ?`).get(
        'invalid_prepared_repository_snapshot:*',
      )).toEqual({ count: 0 });
      expect(['alpha', 'zeta'].map((name) =>
        factsForRepo(db, name))).toEqual(siblingsBefore);
    } finally {
      db.close();
    }
  });

  it('marks a run failed when every repository publication fails', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const rows = await preparedRows(db, workspaceId);
      for (const row of rows) forgeDuplicateBinding(rows, row.repo.name);
      const runId = claimIndexRun(db, workspaceId, rows.length);

      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, rows,
      );

      expect(summary).toMatchObject({
        repoCount: 3,
        indexedCount: 0,
        failedCount: 3,
      });
      expect(db.prepare('SELECT status FROM index_runs WHERE id=?')
        .get(runId)).toEqual({ status: 'failed' });
      for (const name of ['alpha', 'broken', 'zeta'])
        expectFailureDiagnostic(
          db,
          name,
          'duplicate_service_binding_site',
          'service_binding',
          4,
        );
    } finally {
      db.close();
    }
  });
});

function expectPartialRepositoryStates(
  db: Db,
  before: readonly Record<string, unknown>[],
): void {
  const after = repositoryState(db);
  for (const name of ['alpha', 'zeta']) {
    expect(Number(rowByName(after, name).factGeneration)).toBe(
      Number(rowByName(before, name).factGeneration) + 1,
    );
    expect(rowByName(after, name).indexStatus).toBe('indexed');
  }
  expect(rowByName(after, 'broken')).toMatchObject({
    fingerprint: rowByName(before, 'broken').fingerprint,
    factGeneration: rowByName(before, 'broken').factGeneration,
    graphGeneration: rowByName(before, 'broken').graphGeneration,
    indexStatus: 'failed',
    errorCount: 1,
  });
  expect(db.prepare(`SELECT status,diagnostic_count diagnosticCount
    FROM index_runs ORDER BY id DESC LIMIT 1`).get()).toEqual({
    status: 'partial_failure', diagnosticCount: 1,
  });
}

function expectFailureDiagnostic(
  db: Db,
  repoName: string,
  code: PreparedSnapshotFailureCode,
  factKind: PreparedRepositoryFactKind,
  sourceLine: number,
): void {
  const rows = db.prepare(`SELECT d.code,d.message,
    d.source_file sourceFile,d.source_line sourceLine
    FROM diagnostics d JOIN repositories r ON r.id=d.repo_id
    WHERE r.name=? AND d.code GLOB ?
    ORDER BY d.id`).all(
    repoName, 'invalid_prepared_repository_snapshot:*',
  );
  expect(rows).toEqual([{
    code: `invalid_prepared_repository_snapshot:${code}`,
    message: 'Index publication failed before commit for this repository; '
      + `previous facts and fingerprint were preserved. factKind=${factKind}`,
    sourceFile: 'src/run.ts',
    sourceLine,
  }]);
}
