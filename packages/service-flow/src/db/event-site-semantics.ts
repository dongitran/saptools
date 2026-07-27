import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';

export interface EventSiteCategoryCount {
  category: string;
  count: number;
}

function count(
  db: Db,
  sql: string,
  workspaceId?: number,
): number {
  const row = db.prepare(sql).get(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return Number(row?.count ?? 0);
}

function category(
  name: string,
  value: number,
): EventSiteCategoryCount[] {
  return value > 0 ? [{ category: name, count: value }] : [];
}

function duplicateSiteCount(
  db: Db,
  workspaceId: number | undefined,
  callType: 'async_emit' | 'async_subscribe',
): number {
  return count(db, `SELECT COUNT(*) count FROM (
    SELECT fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset,COUNT(*) duplicate_count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND fact.call_type='${callType}'
    GROUP BY fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset HAVING COUNT(*)<>1
  )`, workspaceId);
}

export function eventSiteCategories(
  db: Db,
  workspaceId?: number,
): EventSiteCategoryCount[] {
  const invalidName = count(db, `SELECT COUNT(*) count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND fact.call_type IN ('async_emit','async_subscribe')
      AND (typeof(fact.event_name_expr)<>'text'
        OR length(fact.event_name_expr)=0)`, workspaceId);
  return [
    ...category('event_name_invalid', invalidName),
    ...category('async_subscription_site_duplicate',
      duplicateSiteCount(db, workspaceId, 'async_subscribe')),
    ...category('async_emit_site_duplicate',
      duplicateSiteCount(db, workspaceId, 'async_emit')),
  ];
}
