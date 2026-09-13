import { resolveTimeRange } from "./query-builder.js";

export interface RtrAnalyticsFilters {
  readonly app?: string;
  readonly since?: string;
  readonly until?: string;
}

/**
 * The filter clauses every RTR-analytics command (`errors`, `latency`,
 * `top-routes`) shares: always scoped to `source_type: RTR` (these commands
 * are meaningless on APP-log rows, which have no `response_status`/
 * `response_time_ms`), the same default-1h time range as `search`/`count`,
 * and an optional `app_name.keyword` filter. Three call sites — this repo's
 * Rule of Three — is why this is a shared helper rather than copied a third
 * time (contrast with Phase 1's `apps`/`sources`, which stayed at two).
 */
export function buildRtrFilterClauses(filters: RtrAnalyticsFilters, now: () => Date = () => new Date()): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [{ term: { "source_type.keyword": "RTR" } }];
  const range = resolveTimeRange(filters.since, filters.until, now);
  if (range !== undefined) {
    clauses.push({ range: { "@timestamp": range } });
  }
  if (filters.app !== undefined) {
    clauses.push({ term: { "app_name.keyword": filters.app } });
  }
  return clauses;
}
