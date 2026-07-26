import type { Db } from '../db/connection.js';

export function outboundScopeSymbolIds(
  db: Db,
  symbolIds: ReadonlySet<number> | undefined,
  includeAsync: boolean,
): ReadonlySet<number> | undefined {
  if (!includeAsync || !symbolIds || symbolIds.size === 0) return symbolIds;
  const ids = [...symbolIds];
  const rows = db.prepare(`SELECT DISTINCT child.id FROM symbols parent
    JOIN symbols child ON child.repo_id=parent.repo_id
      AND child.source_file=parent.source_file
      AND child.kind='event_registration'
      AND parent.start_offset<=child.start_offset
      AND parent.end_offset>=child.end_offset
    WHERE parent.id IN (${ids.map(() => '?').join(',')})
    ORDER BY child.id`).all(...ids);
  return new Set([
    ...ids,
    ...rows.flatMap((row) =>
      typeof row.id === 'number' ? [row.id] : []),
  ]);
}
