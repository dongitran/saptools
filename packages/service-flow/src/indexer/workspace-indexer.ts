import type { Db } from '../db/connection.js';
import { listRepositories, reposByName } from '../db/repositories.js';
import { errorMessage } from '../utils/diagnostics.js';
import {
  prepareRepositoryIndex,
  publishOneRepository,
  recordIndexFailure,
  type PreparedRepositoryIndex,
} from './repository-indexer.js';
import { materializeCdsExtensionOperations } from './cds-extension-resolver.js';
import {
  createPackageInvalidationBatch,
  finalizePackageTargetInvalidations,
  mergePackageInvalidationEffects,
  type PackageInvalidationBatch,
} from '../db/package-target-invalidation.js';
import {
  isPreparedRepositorySnapshotError,
} from '../db/index-publication-failure.js';
import { binaryCompare } from '../parsers/fact-identity.js';
// Ownerless rows predate PID coordination; this matches doctor's stale-run threshold without taking over a recent legacy writer.
const LEGACY_OWNER_RECOVERY_MS = 60 * 60 * 1_000;
type RunningIndexRow = Record<string, unknown>;
function ownerPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves that ownership ended; permission and platform errors must fail closed.
    const ownerIsMissing = typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ESRCH';
    return !ownerIsMissing;
  }
}
function isRecoverableRun(row: RunningIndexRow, now: number): boolean {
  const pid = ownerPid(row.ownerPid);
  if (pid !== undefined) return !processIsAlive(pid);
  if (typeof row.startedAt !== 'string') return false;
  const startedAt = Date.parse(row.startedAt);
  return Number.isFinite(startedAt) && now - startedAt >= LEGACY_OWNER_RECOVERY_MS;
}
function recoveredOwnerMessage(row: RunningIndexRow): string {
  const pid = ownerPid(row.ownerPid);
  return pid === undefined
    ? 'Recovered stale legacy index writer without owner process metadata.'
    : `Recovered stale index writer because owner process ${pid} is no longer running.`;
}
export function claimIndexRun(
  db: Db,
  workspaceId: number,
  repoCount: number,
): number {
  // The short write transaction serializes claims without holding a SQLite writer lock during source preparation.
  try {
    return db.transaction(() => {
      const now = Date.now();
      const rows = db
        .prepare("SELECT id,workspace_id workspaceId,owner_pid ownerPid,started_at startedAt FROM index_runs WHERE status='running' ORDER BY id")
        .all();
      const active = rows.find((row) => !isRecoverableRun(row, now));
      if (active) {
        const pid = ownerPid(active.ownerPid);
        const owner = pid === undefined ? 'an unknown owner' : `process ${pid}`;
        throw new Error(`index_writer_active: this database is already being indexed for workspace ${String(active.workspaceId ?? 'unknown')} by ${owner}; wait for that writer to finish.`);
      }
      const finish = db.prepare(
        "UPDATE index_runs SET finished_at=?,status='failed',error_message=? WHERE id=?",
      );
      for (const row of rows)
        finish.run(new Date(now).toISOString(), recoveredOwnerMessage(row), row.id);
      const inserted = db
        .prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count,owner_pid) VALUES(?,?,?,?,?,?,?) RETURNING id')
        .get(workspaceId, new Date(now).toISOString(), 'running', repoCount, 0, 0, process.pid);
      const runId = Number(inserted?.id);
      if (!Number.isSafeInteger(runId)) throw new Error('index_writer_claim_failed: SQLite did not return an index run identifier.');
      return runId;
    });
  } catch (error) {
    if (/\b(?:locked|busy)\b/i.test(errorMessage(error)))
      throw new Error(
        'index_writer_coordination_failed: SQLite remained busy beyond the bounded writer-claim interval; wait for the active publication to finish.',
        { cause: error },
      );
    throw error;
  }
}
export interface IndexWorkspaceSummary {
  repoCount: number;
  indexedCount: number;
  skippedCount: number;
  failedCount: number;
  failedRepos: Array<{ name: string; code: string }>;
  fileCount: number;
  diagnosticCount: number;
}

export async function indexWorkspace(
  db: Db,
  workspaceId: number,
  options: {
    repo?: string;
    force: boolean;
    eventEnvironmentKeys?: readonly string[];
    injectDerivedMaterializationFailure?: boolean;
  },
): Promise<IndexWorkspaceSummary> {
  const repos = selectedRepositories(db, workspaceId, options.repo);
  const runId = claimIndexRun(db, workspaceId, repos.length);
  const state: PreparationState = {
    fileCount: 0, diagnosticCount: 0, skippedCount: 0, rows: [],
  };
  try {
    await prepareRepositories(
      repos, options.force, state, options.eventEnvironmentKeys,
    );
    return publishPreparedWorkspaceRows(
      db, workspaceId, runId, state.rows, options,
    );
  } catch (error) {
    finishFailedRun(db, runId, state, error);
    if (state.activeRepoId && state.rows.length < repos.length)
      recordIndexFailure(db, state.activeRepoId, error);
    throw error;
  }
}

type IndexRepository = ReturnType<typeof listRepositories>[number];
interface PreparationState {
  fileCount: number;
  diagnosticCount: number;
  skippedCount: number;
  rows: PreparedRepositoryIndex[];
  activeRepoId?: number;
}

interface PublicationState {
  fileCount: number;
  diagnosticCount: number;
  skippedCount: number;
  indexedCount: number;
  publicationFailureCount: number;
  failedRepoIds: Set<number>;
  failedRepos: Array<{ name: string; code: string }>;
  rows: readonly PreparedRepositoryIndex[];
  activeRepoId?: number;
}

function selectedRepositories(
  db: Db,
  workspaceId: number,
  repoName: string | undefined,
): IndexRepository[] {
  const repos = repoName
    ? reposByName(db, repoName, workspaceId)
    : listRepositories(db, workspaceId);
  if (repoName && repos.length === 0)
    throw new Error(
      `selector_repo_not_found: no indexed repository matched ${repoName}.`,
    );
  if (repoName && repos.length > 1)
    throw new Error(
      `selector_repo_ambiguous: repository selector ${repoName} matched ${repos.length} repositories; use a unique repository name.`,
    );
  return repos;
}

async function prepareRepositories(
  repos: readonly IndexRepository[],
  force: boolean,
  state: PreparationState,
  eventEnvironmentKeys?: readonly string[],
): Promise<void> {
  for (const repo of repos) {
    state.activeRepoId = repo.id;
    const result = await prepareRepositoryIndex(
      repo, force, undefined, eventEnvironmentKeys,
    );
    state.rows.push(result);
    state.fileCount += result.fileCount;
    state.diagnosticCount += result.diagnosticCount;
    state.skippedCount += result.skipped ? 1 : 0;
  }
}

export function publishPreparedWorkspaceRows(
  db: Db,
  workspaceId: number,
  runId: number,
  rows: readonly PreparedRepositoryIndex[],
  options: { injectDerivedMaterializationFailure?: boolean } = {},
): IndexWorkspaceSummary {
  const state = publicationState(rows);
  db.transaction(() => {
    const effects = createPackageInvalidationBatch([]);
    const publishedRepoIds: number[] = [];
    for (const row of state.rows) {
      state.activeRepoId = row.repo.id;
      if (row.skipped) continue;
      const result = publishPreparedRow(db, row);
      if (result.status === 'failed') {
        recordPublicationFailure(db, state, row, result.error);
        continue;
      }
      state.indexedCount += 1;
      state.diagnosticCount += result.diagnosticCount;
      publishedRepoIds.push(row.repo.id);
      mergePackageInvalidationEffects(effects, result.effects);
    }
    if (options.injectDerivedMaterializationFailure)
      throw new Error('Injected derived materialization failure');
    materializeCdsExtensionOperations(
      db, workspaceId, state.failedRepoIds,
    );
    const invalidations = createPackageInvalidationBatch(publishedRepoIds);
    mergePackageInvalidationEffects(invalidations, effects);
    finalizePackageTargetInvalidations(db, invalidations);
    finishCompletedRun(db, runId, state);
  });
  return indexSummary(rows.length, state);
}

function publicationState(
  rows: readonly PreparedRepositoryIndex[],
): PublicationState {
  return {
    rows,
    fileCount: rows.reduce((total, row) => total + row.fileCount, 0),
    diagnosticCount: rows.reduce(
      (total, row) => total + row.diagnosticCount, 0,
    ),
    skippedCount: rows.filter((row) => row.skipped).length,
    indexedCount: 0,
    publicationFailureCount: 0,
    failedRepoIds: new Set(),
    failedRepos: [],
  };
}

type PublicationResult =
  | {
      status: 'published';
      effects: PackageInvalidationBatch;
      diagnosticCount: number;
    }
  | { status: 'failed'; error: unknown };

function publishPreparedRow(
  db: Db,
  row: PreparedRepositoryIndex,
): PublicationResult {
  const effects = createPackageInvalidationBatch([row.repo.id]);
  const outcome = publishOneRepository(db, row, effects);
  if (!outcome.ok && !isPreparedRepositorySnapshotError(outcome.error))
    throw outcome.error;
  return outcome.ok
    ? {
        status: 'published',
        effects,
        diagnosticCount: outcome.diagnosticCount,
      }
    : { status: 'failed', error: outcome.error };
}

function recordPublicationFailure(
  db: Db,
  state: PublicationState,
  row: PreparedRepositoryIndex,
  error: unknown,
): void {
  state.failedRepoIds.add(row.repo.id);
  state.failedRepos.push({
    name: row.repo.name,
    code: isPreparedRepositorySnapshotError(error)
      ? error.message : 'source_read_failed',
  });
  state.publicationFailureCount += 1;
}

function finishCompletedRun(
  db: Db,
  runId: number,
  state: PublicationState,
): void {
  const status = completedRunStatus(
    state.rows.length, state.publicationFailureCount,
  );
  const error = status === 'success' ? null
    : `${state.publicationFailureCount} repositories failed index publication.`;
  db.prepare(`UPDATE index_runs SET finished_at=?,status=?,
    file_count=?,diagnostic_count=?,error_message=? WHERE id=?`).run(
    new Date().toISOString(), status, state.fileCount,
    completedDiagnosticCount(state), error, runId,
  );
}

function completedRunStatus(
  repoCount: number,
  failedCount: number,
): 'success' | 'partial_failure' | 'failed' {
  if (failedCount === 0) return 'success';
  return failedCount === repoCount ? 'failed' : 'partial_failure';
}

function completedDiagnosticCount(state: PublicationState): number {
  return state.diagnosticCount + state.publicationFailureCount;
}

function finishFailedRun(
  db: Db,
  runId: number,
  state: PreparationState,
  error: unknown,
): void {
  db.prepare(`UPDATE index_runs SET finished_at=?,status='failed',
    file_count=?,diagnostic_count=?,error_message=? WHERE id=?`).run(
    new Date().toISOString(), state.fileCount, state.diagnosticCount + 1,
    errorMessage(error), runId,
  );
}

function indexSummary(
  repoCount: number,
  state: PublicationState,
): IndexWorkspaceSummary {
  return {
    repoCount,
    indexedCount: state.indexedCount,
    skippedCount: state.skippedCount,
    failedCount: state.publicationFailureCount,
    failedRepos: [...state.failedRepos].sort((left, right) =>
      binaryCompare(left.name, right.name)
      || binaryCompare(left.code, right.code)),
    fileCount: state.fileCount,
    diagnosticCount: completedDiagnosticCount(state),
  };
}
