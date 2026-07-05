import type { Db } from '../db/connection.js';
import { listRepositories, repoByName } from '../db/repositories.js';
import { errorMessage } from '../utils/diagnostics.js';
import { prepareRepositoryIndex, publishPreparedRepositoryIndex, recordIndexFailure, type PreparedRepositoryIndex } from './repository-indexer.js';
import { materializeCdsExtensionOperations } from './cds-extension-resolver.js';
export async function indexWorkspace(
  db: Db,
  workspaceId: number,
  options: { repo?: string; force: boolean; injectDerivedMaterializationFailure?: boolean },
): Promise<{ repoCount: number; indexedCount: number; skippedCount: number; fileCount: number; diagnosticCount: number }> {
  const started = new Date().toISOString();
  const repos = options.repo ? [repoByName(db, options.repo)].filter((r) => r !== undefined) : listRepositories(db);
  const runId = Number(db.prepare('INSERT INTO index_runs(workspace_id,started_at,status,repo_count,file_count,diagnostic_count) VALUES(?,?,?,?,?,?) RETURNING id').get(workspaceId, started, 'running', repos.length, 0, 0)?.id);
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
      db.prepare('UPDATE index_runs SET finished_at=?, status=?, file_count=?, diagnostic_count=? WHERE id=?').run(new Date().toISOString(), diagnosticCount ? 'failed' : 'success', fileCount, diagnosticCount, runId);
    });
    return { repoCount: repos.length, indexedCount: repos.length - skippedCount, skippedCount, fileCount, diagnosticCount };
  } catch (error) {
    if (activeRepoId && preparedRows.length < repos.length) recordIndexFailure(db, activeRepoId, error);
    db.prepare("UPDATE index_runs SET finished_at=?, status='failed', file_count=?, diagnostic_count=?, error_message=? WHERE id=?").run(new Date().toISOString(), fileCount, diagnosticCount + 1, errorMessage(error), runId);
    throw error;
  }
}
