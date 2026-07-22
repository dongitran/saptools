import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { ContextBinding } from './008-contextual-runtime-state.js';

export interface TraversalScopeIdentity {
  workspaceId?: number;
  repoId?: number;
  files?: ReadonlySet<string>;
  symbolIds?: ReadonlySet<number>;
  context?: ReadonlyMap<string, ContextBinding>;
}

export interface TraversalScopeState {
  structuralKey: string;
  evaluationKey: string;
  ancestry: ReadonlySet<string>;
}

export type TraversalScheduleKind = 'scheduled' | 'converged' | 'cycle';

export interface TraversalScheduleDecision {
  kind: TraversalScheduleKind;
  state: TraversalScopeState;
  alreadyExpanded: boolean;
}

export function compareBinary(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

export function resolveTraversalWorkspaceId(
  db: Db,
  requestedWorkspaceId: number | undefined,
  repoId: number | undefined,
): number | undefined {
  if (requestedWorkspaceId !== undefined) return requestedWorkspaceId;
  if (repoId !== undefined) {
    const row = db.prepare(
      'SELECT workspace_id workspaceId FROM repositories WHERE id=?',
    ).get(repoId) as { workspaceId?: number } | undefined;
    return typeof row?.workspaceId === 'number' ? row.workspaceId : undefined;
  }
  const rows = db.prepare(`SELECT DISTINCT w.id workspaceId FROM workspaces w
    JOIN repositories r ON r.workspace_id=w.id ORDER BY w.id LIMIT 2`).all() as
    Array<{ workspaceId?: number }>;
  return rows.length === 1 && typeof rows[0]?.workspaceId === 'number'
    ? rows[0].workspaceId : undefined;
}

export function structuralScopeKey(
  workspaceId: number | undefined,
  repoId: number | undefined,
  files: ReadonlySet<string> | undefined,
  symbolIds: ReadonlySet<number> | undefined,
): string {
  return JSON.stringify([
    workspaceId ?? null,
    repoId ?? null,
    files ? [...files].sort(compareBinary) : null,
    symbolIds ? [...symbolIds].sort((left, right) => left - right) : null,
  ]);
}

export function canonicalContextFingerprint(
  context: ReadonlyMap<string, ContextBinding> | undefined,
): string {
  const entries = [...(context ?? new Map<string, ContextBinding>()).entries()]
    .map(([name, binding]) => `${JSON.stringify(name)}:${canonicalValue(binding)}`)
    .sort(compareBinary);
  return createHash('sha256').update(`[${entries.join(',')}]`).digest('hex');
}

export function evaluationScopeKey(
  structuralKey: string,
  context: ReadonlyMap<string, ContextBinding> | undefined,
): string {
  return JSON.stringify([structuralKey, canonicalContextFingerprint(context)]);
}

export class TraversalScopeScheduler {
  readonly #scheduled = new Set<string>();
  readonly #expanded = new Set<string>();
  readonly #structuralByEvaluation = new Map<string, string>();
  readonly #childrenByEvaluation = new Map<string, Set<string>>();

  schedule(
    identity: TraversalScopeIdentity,
    parent?: TraversalScopeState,
  ): TraversalScheduleDecision {
    const state = scopeState(identity, parent);
    this.#rememberState(state);
    if (parent) this.#rememberState(parent);
    const cycle = parent
      ? parent.ancestry.has(state.structuralKey)
        || this.#reachesStructural(state.evaluationKey, parent.structuralKey)
      : false;
    if (parent) this.#recordEdge(parent.evaluationKey, state.evaluationKey);
    if (cycle)
      return { kind: 'cycle', state, alreadyExpanded: this.#expanded.has(state.evaluationKey) };
    if (this.#scheduled.has(state.evaluationKey))
      return { kind: 'converged', state, alreadyExpanded: this.#expanded.has(state.evaluationKey) };
    this.#scheduled.add(state.evaluationKey);
    return { kind: 'scheduled', state, alreadyExpanded: false };
  }

  markExpanded(state: TraversalScopeState): boolean {
    if (this.#expanded.has(state.evaluationKey)) return false;
    this.#expanded.add(state.evaluationKey);
    return true;
  }

  #rememberState(state: TraversalScopeState): void {
    this.#structuralByEvaluation.set(state.evaluationKey, state.structuralKey);
  }

  #recordEdge(parent: string, child: string): void {
    const children = this.#childrenByEvaluation.get(parent) ?? new Set<string>();
    children.add(child);
    this.#childrenByEvaluation.set(parent, children);
  }

  #reachesStructural(start: string, targetStructuralKey: string): boolean {
    const pending = [start];
    const seen = new Set<string>();
    let cursor = 0;
    while (cursor < pending.length) {
      const current = pending[cursor];
      cursor += 1;
      if (seen.has(current)) continue;
      seen.add(current);
      if (this.#structuralByEvaluation.get(current) === targetStructuralKey)
        return true;
      pending.push(...(this.#childrenByEvaluation.get(current) ?? []));
    }
    return false;
  }
}

function scopeState(
  identity: TraversalScopeIdentity,
  parent: TraversalScopeState | undefined,
): TraversalScopeState {
  const structuralKey = structuralScopeKey(
    identity.workspaceId, identity.repoId, identity.files, identity.symbolIds,
  );
  const ancestry = new Set(parent?.ancestry ?? []);
  ancestry.add(structuralKey);
  return {
    structuralKey,
    evaluationKey: evaluationScopeKey(structuralKey, identity.context),
    ancestry,
  };
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'bigint') return `bigint:${String(value)}`;
  if (Array.isArray(value))
    return `array:[${value.map(canonicalValue).join(',')}]`;
  if (!isRecord(value)) return `unsupported:${typeof value}`;
  const entries = Object.entries(value).sort(([left], [right]) => compareBinary(left, right));
  return `object:{${entries.map(([key, child]) =>
    `${JSON.stringify(key)}:${canonicalValue(child)}`).join(',')}}`;
}

function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return 'number:NaN';
  if (value === Number.POSITIVE_INFINITY) return 'number:Infinity';
  if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity';
  if (Object.is(value, -0)) return 'number:-0';
  return `number:${String(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
