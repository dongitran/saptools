import type { Db } from '../db/connection.js';
import { schemaLifecycleDiagnostic } from '../db/fact-lifecycle.js';
import type {
  TraceEdge,
  TraceOptions,
  TraceResult,
  TraceStart,
} from '../types.js';
import {
  runtimeNoCandidateDiagnostics,
  runtimeVariableDiagnostic,
} from './evidence.js';
import {
  loadTraceDiagnostics,
  prependTraceDiagnostic,
} from './trace-diagnostics.js';
import { TraversalScopeScheduler } from './traversal-scope.js';
import { createTraceRootPlan } from './trace-root-scopes.js';
import type { CompactTraceObserver } from './compact-contract.js';
import { TraceEdgeRecorder } from './trace-edge-recorder.js';
import type { ImplementationHintOptions } from './trace-implementation-scope.js';
import {
  resolveTraceStartScope,
  type TraceStartScope,
} from './trace-start-scope.js';
import {
  executeTraceScopes,
  type TraceExecutionRuntime,
} from './trace-scope-execution.js';
import { recordTraceStartImplementation } from './trace-start-implementation.js';
import { selectorNotFoundDiagnostic } from './selectors.js';
import { closeTraceEdgeTargets } from './trace-node-closure.js';

const compactObserverKey = Symbol('service-flow.compact-trace-observer');

type ObservedTraceOptions = TraceOptions & {
  [compactObserverKey]?: CompactTraceObserver;
};

function compactObserver(options: TraceOptions): CompactTraceObserver | undefined {
  const observed: ObservedTraceOptions = options;
  return observed[compactObserverKey];
}

function positiveDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
}

function hasSelector(start: TraceStart): boolean {
  return Boolean(start.repo || start.handler || start.operation
    || start.operationPath || start.servicePath);
}

function staleRows(
  db: Db,
  repoId: number | undefined,
  workspaceId: number | undefined,
  includeAll: boolean,
): Array<{ name?: string; reason?: string }> {
  if (repoId === undefined && !includeAll) return [];
  return db.prepare(`SELECT name,graph_stale_reason reason FROM repositories
    WHERE graph_stale_reason IS NOT NULL AND (? IS NULL OR id=?)
      AND (? IS NULL OR workspace_id=?)
    ORDER BY name,id`).all(
    repoId, repoId, workspaceId, workspaceId,
  ) as Array<{ name?: string; reason?: string }>;
}

function addStaleDiagnostics(
  diagnostics: Array<Record<string, unknown>>,
  rows: Array<{ name?: string; reason?: string }>,
): void {
  for (const row of rows)
    prependTraceDiagnostic(diagnostics, {
      severity: 'warning',
      code: 'graph_stale',
      message: `Graph is stale for ${row.name ?? 'repository'}: ${row.reason ?? 'facts_changed'}. Run service-flow link.`,
    });
}

function initialDiagnostics(
  db: Db,
  start: TraceStart,
  scope: TraceStartScope,
  workspaceId: number | undefined,
): Array<Record<string, unknown>> {
  const selected = hasSelector(start);
  const repoId = scope.executionRepoId ?? scope.repo?.id;
  const diagnostics = loadTraceDiagnostics(db, repoId, !selected, workspaceId);
  addStaleDiagnostics(
    diagnostics, staleRows(db, repoId, workspaceId, !selected),
  );
  for (const diagnostic of scope.startDiagnostics ?? [])
    prependTraceDiagnostic(diagnostics, diagnostic);
  if (!scope.selectorMatched && !scope.startDiagnostics?.length)
    prependTraceDiagnostic(diagnostics, selectorNotFoundDiagnostic(start));
  return diagnostics;
}

function finalizeDiagnostics(
  diagnostics: Array<Record<string, unknown>>,
  edges: TraceEdge[],
): void {
  const runtimeDiagnostic = runtimeVariableDiagnostic(edges);
  if (runtimeDiagnostic)
    prependTraceDiagnostic(diagnostics, runtimeDiagnostic);
  for (const diagnostic of runtimeNoCandidateDiagnostics(edges))
    prependTraceDiagnostic(diagnostics, diagnostic);
}

function traceRuntime(
  db: Db,
  options: TraceOptions,
  hintOptions: ImplementationHintOptions,
  roots: ReturnType<typeof createTraceRootPlan>,
  diagnostics: Array<Record<string, unknown>>,
  edges: TraceEdge[],
  observer: CompactTraceObserver | undefined,
  scheduler: TraversalScopeScheduler,
): TraceExecutionRuntime {
  return {
    db,
    options,
    hintOptions,
    workspaceId: roots.workspaceId,
    maxDepth: positiveDepth(options.depth),
    scheduler,
    queue: roots.queue,
    pendingRoots: roots.pendingRoots,
    diagnostics,
    nodes: new Map(),
    recorder: new TraceEdgeRecorder(edges, observer),
  };
}

export function trace(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
): TraceResult {
  const observer = compactObserver(options);
  const schemaLifecycle = schemaLifecycleDiagnostic(db);
  if (schemaLifecycle)
    return { start, nodes: [], edges: [], diagnostics: [schemaLifecycle] };
  const hints: ImplementationHintOptions = {
    implementationRepo: options.implementationRepo,
    implementationHints: options.implementationHints,
  };
  const scope = resolveTraceStartScope(db, start, hints, options.workspaceId);
  const scheduler = new TraversalScopeScheduler();
  const roots = createTraceRootPlan(db, scheduler, {
    repoId: scope.executionRepoId ?? scope.repo?.id,
    files: scope.sourceFiles,
    symbolIds: scope.symbolIds,
    selectorMatched: scope.selectorMatched,
  }, options.workspaceId, Boolean(options.includeAsync));
  observer?.setWorkspaceId?.(roots.workspaceId);
  if (roots.diagnostic)
    return { start, nodes: [], edges: [], diagnostics: [roots.diagnostic] };
  const diagnostics = initialDiagnostics(db, start, scope, roots.workspaceId);
  const edges: TraceEdge[] = [];
  const runtime = traceRuntime(
    db, options, hints, roots, diagnostics, edges, observer, scheduler,
  );
  if (scope.startOperationId && scope.selectorMatched)
    recordTraceStartImplementation(runtime, scope.startOperationId);
  executeTraceScopes(runtime);
  closeTraceEdgeTargets(runtime.nodes, edges);
  finalizeDiagnostics(diagnostics, edges);
  return { start, nodes: [...runtime.nodes.values()], edges, diagnostics };
}

export function traceWithObserver(
  db: Db,
  start: TraceStart,
  options: TraceOptions,
  observer: CompactTraceObserver,
): TraceResult {
  const observed: ObservedTraceOptions = {
    ...options,
    [compactObserverKey]: observer,
  };
  return trace(db, start, observed);
}
