import type { Db } from './connection.js';
import type { OutboundCallFact } from '../types.js';

function priorEventFactCount(db: Db, repoId: number): number {
  const row = db.prepare(`SELECT COUNT(*) count FROM outbound_calls
    WHERE repo_id=? AND call_type IN ('async_emit','async_subscribe')`).get(
    repoId,
  );
  return Number(row?.count ?? 0);
}

function repositoryEnvironment(
  db: Db,
  repoId: number,
): string | null {
  const row = db.prepare(`SELECT environment_declarations_json value
    FROM repositories WHERE id=?`).get(repoId);
  return typeof row?.value === 'string' ? row.value : null;
}

export function invalidateEventSurfaceFacts(
  db: Db,
  repoId: number,
  calls: readonly OutboundCallFact[],
  nextEnvironmentJson: string,
): void {
  const hasNewEvents = calls.some((call) =>
    call.callType === 'async_emit' || call.callType === 'async_subscribe');
  const environmentChanged = repositoryEnvironment(db, repoId)
    !== nextEnvironmentJson;
  if (!hasNewEvents && priorEventFactCount(db, repoId) === 0
    && !environmentChanged) return;
  db.prepare(`UPDATE repositories SET
    graph_stale_reason='event_surface_facts_changed',
    graph_stale_at=datetime('now')
    WHERE workspace_id=(SELECT workspace_id FROM repositories WHERE id=?)`)
    .run(repoId);
}
