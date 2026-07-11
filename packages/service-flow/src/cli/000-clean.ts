import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceConfig } from '../config/workspace-config.js';
import { openDatabase } from '../db/connection.js';
import { getWorkspace, upsertWorkspace } from '../db/repositories.js';
import { claimIndexRun } from '../indexer/workspace-indexer.js';
import { errorMessage } from '../utils/diagnostics.js';

type CleanConfig = Pick<WorkspaceConfig, 'dbPath' | 'rootPath'>;

export async function cleanWorkspaceState(
  config: CleanConfig,
  dbOnly: boolean,
): Promise<void> {
  const dbDir = path.resolve(path.dirname(config.dbPath));
  if (!dbOnly) await assertOwnedStateDirectory(dbDir, config.rootPath);
  const runId = claimCleanWriter(config);
  try {
    if (dbOnly) await removeDatabaseFiles(config.dbPath);
    else await fs.rm(dbDir, { recursive: true, force: true });
  } catch (error) {
    await markCleanClaimFailed(config.dbPath, runId, error);
    throw error;
  }
}

function claimCleanWriter(config: CleanConfig): number {
  const db = openDatabase(config.dbPath);
  try {
    const workspaceId = getWorkspace(db, config.rootPath)?.id
      ?? upsertWorkspace(db, config.rootPath, config.dbPath);
    return claimIndexRun(db, workspaceId, 0);
  } finally {
    db.close();
  }
}

async function assertOwnedStateDirectory(
  dbDir: string,
  rootPath: string,
): Promise<void> {
  const marker = path.join(dbDir, '.service-flow-state');
  const dangerous = new Set([
    path.parse(dbDir).root,
    '/tmp',
    process.env.HOME ? path.resolve(process.env.HOME) : '',
    path.resolve(rootPath),
  ]);
  const ownsState = await fs.stat(marker)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!ownsState || dangerous.has(dbDir))
    throw new Error(
      `Refusing to recursively delete unowned or dangerous state directory: ${dbDir}. Use --db-only to remove only the database file.`,
    );
}

async function removeDatabaseFiles(dbPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal'])
    await fs.rm(`${dbPath}${suffix}`, { force: true });
  await fs.rm(dbPath, { force: true });
}

async function markCleanClaimFailed(
  dbPath: string,
  runId: number,
  error: unknown,
): Promise<void> {
  const exists = await fs.stat(dbPath).then(() => true).catch(() => false);
  if (!exists) return;
  const db = openDatabase(dbPath);
  try {
    db.prepare(`UPDATE index_runs SET finished_at=?,status='failed',
      error_message=? WHERE id=? AND status='running'`).run(
      new Date().toISOString(),
      `Clean failed after writer claim: ${errorMessage(error)}`,
      runId,
    );
  } finally {
    db.close();
  }
}
