import type { Db } from '../db/connection.js';
import {
  type ContextBinding,
} from './contextual-runtime-state.js';
import {
  type TraversalScheduleDecision,
  type TraversalScopeScheduler,
  type TraversalScopeState,
} from './traversal-scope.js';
import { contextForSymbolCall } from './trace-context.js';

export interface LocalCallExpansion {
  repoId: number;
  files: Set<string>;
  symbols: Set<number>;
  context: Map<string, ContextBinding>;
  scheduling: TraversalScheduleDecision;
}

export function planLocalCallExpansion(
  db: Db,
  scheduler: TraversalScopeScheduler,
  workspaceId: number | undefined,
  parent: TraversalScopeState,
  row: Record<string, unknown>,
  bindings: Map<string, ContextBinding>,
  symbolId: number,
): LocalCallExpansion {
  const symbols = new Set([symbolId]);
  const files = new Set([String(row.calleeFile)]);
  const repoId = Number(row.calleeRepoId);
  const context = contextForSymbolCall(db, row, bindings);
  const scheduling = scheduler.schedule({
    workspaceId, repoId, files, symbolIds: symbols, context,
  }, parent);
  return { repoId, files, symbols, context, scheduling };
}
