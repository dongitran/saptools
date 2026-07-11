import type { Db } from '../db/connection.js';
import { listRepositories, reposByName } from '../db/repositories.js';
import { errorMessage } from '../utils/diagnostics.js';
import { prepareRepositoryIndex, publishPreparedRepositoryIndex, recordIndexFailure, type PreparedRepositoryIndex } from './repository-indexer.js';
import { materializeCdsExtensionOperations } from './cds-extension-resolver.js';
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
export async function indexWorkspace(
  db: Db,
  workspaceId: number,
  options: { repo?: string; force: boolean; injectDerivedMaterializationFailure?: boolean },
): Promise<{ repoCount: number; indexedCount: number; skippedCount: number; fileCount: number; diagnosticCount: number }> {
  const repos = options.repo
    ? reposByName(db, options.repo, workspaceId)
    : listRepositories(db, workspaceId);
  if (options.repo && repos.length === 0)
    throw new Error(`selector_repo_not_found: no indexed repository matched ${options.repo}.`);
  if (options.repo && repos.length > 1)
    throw new Error(`selector_repo_ambiguous: repository selector ${options.repo} matched ${repos.length} repositories; use a unique repository name.`);
  const runId = claimIndexRun(db, workspaceId, repos.length);
  let fileCount = 0;
  let diagnosticCount = 0;
  let skippedCount = 0;
  const preparedRows: PreparedRepositoryIndex[] = [];
  let activeRepoId: number | undefined;
  try {
    for (const repo of repos) {
      activeRepoId = repo.id;
      const result = await prepareRepositoryIndex(repo, options.force);
      preparedRows.push(result);
      fileCount += result.fileCount;
      diagnosticCount += result.diagnosticCount;
      skippedCount += result.skipped ? 1 : 0;
    }
    db.transaction(() => {
      for (const row of preparedRows) {
        activeRepoId = row.repo.id;
        publishPreparedRepositoryIndex(db, row);
      }
      if (options.injectDerivedMaterializationFailure) throw new Error('Injected derived materialization failure');
      materializeCdsExtensionOperations(db, workspaceId);
      db.prepare("UPDATE index_runs SET finished_at=?, status='success', file_count=?, diagnostic_count=? WHERE id=?").run(new Date().toISOString(), fileCount, diagnosticCount, runId);
    });
    return { repoCount: repos.length, indexedCount: repos.length - skippedCount, skippedCount, fileCount, diagnosticCount };
  } catch (error) {
    db.prepare("UPDATE index_runs SET finished_at=?, status='failed', file_count=?, diagnostic_count=?, error_message=? WHERE id=?").run(new Date().toISOString(), fileCount, diagnosticCount + 1, errorMessage(error), runId);
    if (activeRepoId && preparedRows.length < repos.length) recordIndexFailure(db, activeRepoId, error);
    throw error;
  }
}
