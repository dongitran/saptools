import type { Db } from '../db/connection.js';
import { currentFactLifecycleDiagnostic } from '../db/001-fact-lifecycle.js';
import { resolveTraversalWorkspaceId } from './010-traversal-scope.js';

function workspaceScopeIsAmbiguous(db: Db): boolean {
  const rows = db.prepare(`SELECT DISTINCT workspace_id workspaceId
    FROM repositories ORDER BY workspace_id LIMIT 2`).all();
  return rows.length > 1;
}

export function shouldDeferTraceStartSelection(
  db: Db,
  requestedWorkspaceId: number | undefined,
  repoId: number | undefined,
): boolean {
  const workspaceId = resolveTraversalWorkspaceId(
    db, requestedWorkspaceId, repoId,
  );
  if (workspaceId === undefined) return workspaceScopeIsAmbiguous(db);
  return currentFactLifecycleDiagnostic(db, workspaceId) !== undefined;
}
