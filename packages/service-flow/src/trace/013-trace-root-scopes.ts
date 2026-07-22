import type { Db } from '../db/connection.js';
import { currentFactLifecycleDiagnostic } from '../db/001-fact-lifecycle.js';
import type { ContextBinding } from './008-contextual-runtime-state.js';
import {
  resolveTraversalWorkspaceId,
  type TraversalScopeScheduler,
  type TraversalScopeState,
} from './010-traversal-scope.js';

export interface TraceQueueScope {
  repoId?: number;
  files?: Set<string>;
  symbolIds?: Set<number>;
  depth: number;
  context: Map<string, ContextBinding>;
  state: TraversalScopeState;
  unownedOnly?: boolean;
  rootObservationOnly?: boolean;
}

export interface PendingTraceRootScope {
  repoId: number;
  files: Set<string>;
  symbolIds: Set<number>;
  unownedOnly: boolean;
  rootObservationOnly: boolean;
}

interface RootCallRow {
  id: number;
  repoId: number;
  repoName: string;
  workspaceId: number;
  graphGeneration: number;
  sourceSymbolId?: number | null;
  sourceFile: string;
  callType: string;
  eventName?: string | null;
}

export interface TraceRootPlan {
  workspaceId?: number;
  queue: TraceQueueScope[];
  pendingRoots: PendingTraceRootScope[];
  diagnostic?: Record<string, unknown>;
}

export function createTraceRootPlan(
  db: Db,
  scheduler: TraversalScopeScheduler,
  scope: {
    repoId?: number;
    files?: Set<string>;
    symbolIds?: Set<number>;
    selectorMatched: boolean;
  },
  requestedWorkspaceId: number | undefined,
  includeAsync: boolean,
): TraceRootPlan {
  const workspaceId = resolveTraversalWorkspaceId(
    db, requestedWorkspaceId, scope.repoId,
  );
  if (workspaceId !== undefined) {
    const lifecycle = currentFactLifecycleDiagnostic(db, workspaceId);
    if (lifecycle) return {
      workspaceId, queue: [], pendingRoots: [], diagnostic: lifecycle,
    };
  }
  if (!scope.selectorMatched)
    return { workspaceId, queue: [], pendingRoots: [] };
  if (workspaceId === undefined) return {
    workspaceId, queue: [], pendingRoots: [],
    diagnostic: workspaceAmbiguityDiagnostic(db),
  };
  const pendingRoots = includeAsync
    ? rootScopes(db, workspaceId, scope) : undefined;
  if (pendingRoots)
    return { workspaceId, queue: [], pendingRoots };
  return {
    workspaceId,
    queue: initialQueue(scheduler, workspaceId, scope),
    pendingRoots: [],
  };
}

export function nextPendingRoot(
  pendingRoots: PendingTraceRootScope[],
  scheduler: TraversalScopeScheduler,
  workspaceId: number,
): TraceQueueScope | undefined {
  while (pendingRoots.length > 0) {
    const root = pendingRoots.shift();
    if (!root) return undefined;
    const context = new Map<string, ContextBinding>();
    const scheduled = scheduler.schedule({
      workspaceId, repoId: root.repoId, files: root.files,
      symbolIds: root.symbolIds, context,
    });
    if (scheduled.kind !== 'scheduled') continue;
    return { ...root, depth: 1, context, state: scheduled.state };
  }
  return undefined;
}

export function claimPendingRoot(
  pendingRoots: PendingTraceRootScope[],
  target: {
    repoId?: number;
    files: ReadonlySet<string>;
    symbolIds: ReadonlySet<number>;
  },
): boolean {
  const index = pendingRoots.findIndex((root) =>
    target.repoId === root.repoId
    && !root.unownedOnly
    && setsEqual(root.files, target.files)
    && setsEqual(root.symbolIds, target.symbolIds));
  if (index < 0) return false;
  pendingRoots.splice(index, 1);
  return true;
}

export function enqueueCausalScope(
  queue: TraceQueueScope[],
  pendingRoots: PendingTraceRootScope[],
  scope: TraceQueueScope,
): void {
  if (scope.context.size === 0 && scope.files && scope.symbolIds)
    claimPendingRoot(pendingRoots, {
      repoId: scope.repoId, files: scope.files, symbolIds: scope.symbolIds,
    });
  queue.push(scope);
}

function initialQueue(
  scheduler: TraversalScopeScheduler,
  workspaceId: number,
  scope: { repoId?: number; files?: Set<string>; symbolIds?: Set<number> },
): TraceQueueScope[] {
  const context = new Map<string, ContextBinding>();
  const scheduled = scheduler.schedule({
    workspaceId, repoId: scope.repoId, files: scope.files,
    symbolIds: scope.symbolIds, context,
  });
  return scheduled.kind === 'scheduled' ? [{
    repoId: scope.repoId, files: scope.files, symbolIds: scope.symbolIds,
    depth: 1, context, state: scheduled.state,
  }] : [];
}

function rootScopes(
  db: Db,
  workspaceId: number,
  scope: { repoId?: number; files?: Set<string>; symbolIds?: Set<number> },
): PendingTraceRootScope[] | undefined {
  if (scope.symbolIds && scope.symbolIds.size === 1) return undefined;
  const calls = scopedRootCalls(db, workspaceId, scope);
  if (!hasExactDispatch(db, calls)) return undefined;
  if (scope.symbolIds && scope.symbolIds.size > 1)
    return selectedSymbolRoots(db, workspaceId, scope.symbolIds);
  return callOwnerRoots(calls);
}

function scopedRootCalls(
  db: Db,
  workspaceId: number,
  scope: { repoId?: number; files?: Set<string>; symbolIds?: Set<number> },
): RootCallRow[] {
  return rootCalls(db, workspaceId, scope.repoId, scope.files)
    .filter((call) => !scope.symbolIds
      || (typeof call.sourceSymbolId === 'number'
        && scope.symbolIds.has(call.sourceSymbolId)));
}

function callOwnerRoots(
  calls: RootCallRow[],
): PendingTraceRootScope[] | undefined {
  const roots = new Map<string, PendingTraceRootScope>();
  for (const call of calls) {
    const [key, root] = callOwnerRoot(call);
    if (roots.has(key)) continue;
    roots.set(key, root);
  }
  return roots.size > 0 ? [...roots.values()] : undefined;
}

function callOwnerRoot(
  call: RootCallRow,
): [string, PendingTraceRootScope] {
  const symbolId = call.sourceSymbolId;
  const owned = typeof symbolId === 'number';
  const key = owned
    ? `symbol:${symbolId}` : `unowned:${call.repoId}:${call.sourceFile}`;
  return [key, {
    repoId: call.repoId,
    files: new Set([call.sourceFile]),
    symbolIds: owned ? new Set([symbolId]) : new Set(),
    unownedOnly: !owned,
    rootObservationOnly: true,
  }];
}

function selectedSymbolRoots(
  db: Db,
  workspaceId: number,
  symbolIds: Set<number>,
): PendingTraceRootScope[] {
  const ids = [...symbolIds];
  const rows = db.prepare(`SELECT s.id,s.repo_id repoId,s.source_file sourceFile
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE r.workspace_id=? AND s.id IN (${ids.map(() => '?').join(',')})
    ORDER BY r.name COLLATE BINARY,r.id,s.source_file COLLATE BINARY,
      s.start_offset,s.end_offset,s.id`).all(workspaceId, ...ids);
  return rows.flatMap((row) => typeof row.id === 'number'
    && typeof row.repoId === 'number' && typeof row.sourceFile === 'string'
    ? [{ repoId: row.repoId, files: new Set([row.sourceFile]),
      symbolIds: new Set([row.id]), unownedOnly: false,
      rootObservationOnly: false }]
    : []);
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function rootCalls(
  db: Db,
  workspaceId: number,
  repoId: number | undefined,
  files: Set<string> | undefined,
): RootCallRow[] {
  const rows = db.prepare(`SELECT c.id,c.repo_id repoId,r.name repoName,
      r.workspace_id workspaceId,r.graph_generation graphGeneration,
      c.source_symbol_id sourceSymbolId,c.source_file sourceFile,
      c.call_type callType,c.event_name_expr eventName
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE r.workspace_id=? AND (? IS NULL OR c.repo_id=?)
    ORDER BY r.name COLLATE BINARY,r.id,c.source_file COLLATE BINARY,
      c.call_site_start_offset,c.call_site_end_offset,c.source_line,c.id`).all(
    workspaceId, repoId, repoId,
  ) as unknown as RootCallRow[];
  return files ? rows.filter((row) => files.has(row.sourceFile)) : rows;
}

function hasExactDispatch(db: Db, calls: RootCallRow[]): boolean {
  const match = db.prepare(`SELECT 1 matched FROM graph_edges emitted
    WHERE emitted.workspace_id=? AND emitted.generation=?
      AND emitted.edge_type='HANDLER_EMITS_EVENT'
      AND emitted.from_kind='call' AND emitted.from_id=?
      AND EXISTS (SELECT 1 FROM graph_edges subscriber
        WHERE subscriber.workspace_id=emitted.workspace_id
          AND subscriber.generation=emitted.generation
          AND subscriber.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
          AND subscriber.from_kind='event'
          AND subscriber.from_id COLLATE BINARY=? COLLATE BINARY)
    LIMIT 1`);
  return calls.some((call) => call.callType === 'async_emit'
    && typeof call.eventName === 'string'
    && Boolean(match.get(call.workspaceId, call.graphGeneration,
      String(call.id), call.eventName)));
}

function workspaceAmbiguityDiagnostic(db: Db): Record<string, unknown> {
  const total = Number(db.prepare(`SELECT COUNT(DISTINCT w.id) count
    FROM workspaces w JOIN repositories r ON r.workspace_id=w.id`).get()?.count ?? 0);
  const workspaceIds = db.prepare(`SELECT DISTINCT w.id FROM workspaces w
    JOIN repositories r ON r.workspace_id=w.id ORDER BY w.id LIMIT 5`).all()
    .flatMap((row) => typeof row.id === 'number' ? [row.id] : []);
  return {
    severity: 'error', code: 'trace_workspace_ambiguous',
    message: total > 1
      ? 'Trace spans multiple indexed workspaces; provide a workspace identity.'
      : 'No indexed workspace could be selected for this trace.',
    workspaceCount: total, workspaceIds,
    omittedWorkspaceCount: Math.max(0, total - workspaceIds.length),
    remediation: 'Pass TraceOptions.workspaceId or select a repository in one workspace.',
  };
}
