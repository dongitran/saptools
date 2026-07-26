import type {
  CompactDecisionTargetInput,
  CompactDecisionV1,
  CompactEdgeObservation,
} from './014-compact-contract.js';
import { projectCompactDecision } from './020-compact-field-projection.js';
import { normalizeCompactDecisionEquivalence } from
  './021-compact-decision-normalization.js';

export interface CompactDecisionNode {
  key?: string;
  decisionTarget?: string;
  projectedIdentity?: boolean;
}

function resolvedNode(
  value: CompactDecisionTargetInput | undefined,
  resolve: (input: CompactDecisionTargetInput) => CompactDecisionNode,
): CompactDecisionNode | undefined {
  return value ? resolve(value) : undefined;
}

function applyEffectiveTarget(
  decision: CompactDecisionV1,
  effective: CompactDecisionNode | undefined,
): void {
  if (effective?.decisionTarget)
    decision.effectiveTarget = effective.decisionTarget;
}

function applyPersistedTarget(
  decision: CompactDecisionV1,
  persisted: CompactDecisionNode | undefined,
  status: string | undefined,
): void {
  if (persisted?.decisionTarget && status)
    decision.persistedTarget = persisted.decisionTarget;
}

function sameCanonicalNode(
  left: CompactDecisionNode | undefined,
  right: CompactDecisionNode,
): boolean {
  if (left?.key === undefined) return false;
  return left.projectedIdentity === true
    ? left.key === right.decisionTarget
    : left.key === right.key;
}

function persistedCanonical(
  persisted: CompactDecisionNode | undefined,
  effective: CompactDecisionNode | undefined,
  target: CompactDecisionNode,
): boolean {
  if (!sameCanonicalNode(persisted, target)) return false;
  return effective?.key === undefined || sameCanonicalNode(effective, target);
}

export function projectObservationDecision(
  input: CompactEdgeObservation,
  target: CompactDecisionNode,
  resolve: (value: CompactDecisionTargetInput) => CompactDecisionNode,
): CompactDecisionV1 {
  const decision = projectCompactDecision(input.decision);
  const source = input.decision;
  const effective = resolvedNode(source?.effectiveTarget, resolve);
  const persisted = resolvedNode(source?.persistedTarget, resolve);
  applyEffectiveTarget(decision, effective);
  applyPersistedTarget(
    decision, persisted, source?.persistedResolutionStatus,
  );
  normalizeCompactDecisionEquivalence(
    decision,
    input.status,
    target.decisionTarget,
    sameCanonicalNode(effective, target),
    persistedCanonical(persisted, effective, target),
    source?.persistedResolutionStatus,
  );
  return decision;
}
