import type { Db } from '../db/connection.js';
import { CURRENT_SCHEMA_VERSION } from '../db/migrations.js';
import type { CompactGraphV1, CompactSourceContext } from './014-compact-contract.js';
import { CompactObservationCollector } from './014-compact-contract.js';
import { projectCompactGraph } from './016-compact-projector.js';
import { traceWithObserver } from './trace-engine.js';
import type { TraceOptions, TraceResult, TraceStart } from '../types.js';

export interface CompactTraceExecution {
  trace: TraceResult;
  compact: CompactGraphV1;
}

export function compactTrace(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
): CompactGraphV1 {
  return traceAndCompact(db, start, options).compact;
}

export function traceAndCompact(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
): CompactTraceExecution {
  const collector = new CompactObservationCollector();
  const trace = traceWithObserver(db, start, options, collector);
  const source = compactSourceContext(db, options, collector.workspaceId);
  const compact = projectCompactGraph({
    db, start, options, source, trace,
    observations: collector.observations,
  });
  return { trace, compact };
}

export function compactSourceContext(
  db: Db,
  options: TraceOptions,
  traversalWorkspaceId?: number,
): CompactSourceContext {
  return {
    schemaVersion: schemaVersion(db),
    analyzerVersion: sourceAnalyzerVersion(
      db, traversalWorkspaceId ?? options.workspaceId,
    ),
    graphGeneration: graphGeneration(
      db, traversalWorkspaceId ?? options.workspaceId,
    ),
  };
}

function sourceAnalyzerVersion(
  db: Db,
  workspaceId: number | undefined,
): string {
  const rows = db.prepare(`SELECT DISTINCT
      COALESCE(fact_analyzer_version,'legacy_unknown') analyzerVersion
    FROM repositories WHERE (? IS NULL OR workspace_id=?)
    ORDER BY analyzerVersion COLLATE BINARY LIMIT 2`).all(
    workspaceId, workspaceId,
  );
  if (rows.length === 0) return 'none';
  if (rows.length > 1) return 'mixed';
  return stringValue(rows[0]?.analyzerVersion) ?? 'legacy_unknown';
}

function graphGeneration(db: Db, workspaceId: number | undefined): number {
  if (workspaceId === undefined) return 0;
  const rows = db.prepare(`SELECT DISTINCT graph_generation generation
    FROM repositories WHERE workspace_id=?
    ORDER BY graph_generation LIMIT 2`).all(workspaceId);
  return rows.length === 1 ? numberValue(rows[0]?.generation) ?? 0 : 0;
}

function schemaVersion(db: Db): number {
  const row = db.pragma('user_version')[0];
  return numberValue(row?.user_version) ?? CURRENT_SCHEMA_VERSION;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
