import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexCommandOutcome } from
  '../../src/cli/index-summary.js';
import type { Db } from '../../src/db/connection.js';
import {
  listRepositories,
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
} from '../../src/db/index-publication-failure.js';
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
    'contains $label to its fact',
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

        expect(summary).toMatchObject({
          repoCount: 3,
          indexedCount: 3,
          failedCount: 0,
          failedRepos: [],
        });
        expectSuccessfulRepositoryStates(db, before);
        expectContainedDiagnostics(
          db, 'broken', code, factKind, sourceLine,
          code === 'duplicate_service_binding_site' ? 2 : 1,
        );
        expect(graphSnapshot(db)).toBe(graph);
      } finally {
        db.close();
      }
    },
  );

  it('retains every package-provenance failure as an unresolved fact', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const rows = await preparedRows(db, workspaceId);
      const prepared = preparedByName(rows);
      const call = symbolCall(prepared);
      call.importSource = '@neutral/external';
      call.evidence = { ...call.evidence, relation: 'package_import' };
      const runId = claimIndexRun(db, workspaceId, rows.length);

      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, rows,
      );

      expect(summary).toMatchObject({
        indexedCount: 3,
        failedCount: 0,
      });
      expect(db.prepare(`SELECT status,unresolved_reason reason,
        json_extract(evidence_json,'$.candidateStrategy') strategy
        FROM symbol_calls WHERE import_source='@neutral/external'`).get())
        .toEqual({
          status: 'unresolved',
          reason: 'package_import_provenance_missing',
          strategy: 'package_import_provenance_missing',
        });
      expect(db.prepare(`SELECT code,source_file sourceFile,
        source_line sourceLine FROM diagnostics
        WHERE code='package_import_provenance_missing'`).all())
        .toEqual([{
          code: 'package_import_provenance_missing',
          sourceFile: call.sourceFile,
          sourceLine: call.sourceLine,
        }]);
    } finally {
      db.close();
    }
  });

  it('publishes package factory-return and package-instance calls fail-closed', async () => {
    const root = await mkdtemp(path.join(
      os.tmpdir(), 'sf-package-provenance-shapes-',
    ));
    await repositoryFiles(root, 'package-shapes', `
import lodash from 'lodash';
import NodeCache from 'node-cache';
function work(): void {}
export function run(): void {
  const throttled = lodash.throttle(work, 1);
  throttled();
  const cache = new NodeCache();
  cache.flushAll();
}
`);

    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      expect(db.prepare(`SELECT index_status status,error_count errorCount
        FROM repositories WHERE name='package-shapes'`).get()).toEqual({
        status: 'indexed',
        errorCount: 0,
      });
      const rows = db.prepare(`SELECT callee_expression expression,status,
        unresolved_reason reason
        FROM symbol_calls
        WHERE import_source IN ('lodash','node-cache')
        ORDER BY source_line,call_site_start_offset`).all();
      expect(rows).toEqual([
        {
          expression: 'lodash.throttle',
          status: 'unresolved',
          reason: 'package_resolution_pending',
        },
        {
          expression: 'throttled',
          status: 'unresolved',
          reason: 'package_import_provenance_missing',
        },
        {
          expression: 'cache.flushAll',
          status: 'unresolved',
          reason: 'package_import_provenance_missing',
        },
      ]);
      expect(db.prepare(`SELECT COUNT(*) count FROM diagnostics
        WHERE code='package_import_provenance_missing'`).get())
        .toEqual({ count: 2 });
      expect(() => linkWorkspace(db, workspaceId)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('commits a repository while omitting only invalid prepared facts', async () => {
    const { db, workspaceId } = await createFixture();
    try {
      const before = repositoryState(db);
      const graph = graphSnapshot(db);
      const rows = await preparedRows(db, workspaceId);
      forgeDuplicateBinding(rows);
      const runId = claimIndexRun(db, workspaceId, rows.length);

      const summary = publishPreparedWorkspaceRows(
        db, workspaceId, runId, rows,
      );

      expect(summary).toMatchObject({
        repoCount: 3,
        indexedCount: 3,
        skippedCount: 0,
        failedCount: 0,
        failedRepos: [],
        diagnosticCount: 3,
      });
      const command = indexCommandOutcome(summary);
      expect(command).toEqual({
        stdout: 'Indexed 3 repositories, skipped 0, 3 files, 3 diagnostics\n',
        exitCode: 0,
      });
      expect(command.stdout).not.toContain('PreparedRepositorySnapshotError');
      expect(command.stdout).not.toMatch(/\n\s+at /);
      expectSuccessfulRepositoryStates(db, before);
      expect(graphSnapshot(db)).toBe(graph);
      expectContainedDiagnostics(
        db,
        'broken',
        'duplicate_service_binding_site',
        'service_binding',
        4,
        2,
      );
      expect(db.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(['first', 'last'] as const)(
    'contains invalid facts independently when their repository is %s',
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
          indexedCount: 3,
          failedCount: 0,
        });
        expectSuccessfulRepositoryStates(db, before);
        expectContainedDiagnostics(
          db,
          'broken',
          'duplicate_service_binding_site',
          'service_binding',
          4,
          2,
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

  it('contains invalid facts independently in every repository', async () => {
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
        indexedCount: 3,
        failedCount: 0,
      });
      expect(db.prepare('SELECT status FROM index_runs WHERE id=?')
        .get(runId)).toEqual({ status: 'success' });
      for (const name of ['alpha', 'broken', 'zeta'])
        expectContainedDiagnostics(
          db,
          name,
          'duplicate_service_binding_site',
          'service_binding',
          4,
          2,
        );
    } finally {
      db.close();
    }
  });
});

function expectSuccessfulRepositoryStates(
  db: Db,
  before: readonly Record<string, unknown>[],
): void {
  const after = repositoryState(db);
  for (const name of ['alpha', 'broken', 'zeta']) {
    expect(Number(rowByName(after, name).factGeneration)).toBe(
      Number(rowByName(before, name).factGeneration) + 1,
    );
    expect(rowByName(after, name).indexStatus).toBe('indexed');
    expect(rowByName(after, name).errorCount).toBe(0);
  }
  expect(db.prepare('SELECT status FROM index_runs ORDER BY id DESC LIMIT 1')
    .get()).toEqual({ status: 'success' });
}

function expectContainedDiagnostics(
  db: Db,
  repoName: string,
  code: PreparedSnapshotFailureCode,
  factKind: PreparedRepositoryFactKind,
  sourceLine: number,
  count: number,
): void {
  const rows = db.prepare(`SELECT d.code,d.message,
    d.source_file sourceFile,d.source_line sourceLine
    FROM diagnostics d JOIN repositories r ON r.id=d.repo_id
    WHERE r.name=? AND d.code=?
    ORDER BY d.id`).all(
    repoName, `invalid_prepared_repository_snapshot:${code}`,
  );
  expect(rows).toHaveLength(count);
  for (const row of rows)
    expect(row).toEqual({
      code: `invalid_prepared_repository_snapshot:${code}`,
      message: `Prepared ${factKind} was omitted because its fail-closed publication proof failed.`,
      sourceFile: 'src/run.ts',
      sourceLine,
    });
}
