import { compareBinary } from './010-traversal-scope.js';
import type {
  CompactDecisionV1,
  CompactStatus,
} from './014-compact-contract.js';

export const COMPACT_MISSING_NAME_LIMIT = 8;
export const COMPACT_MISSING_NAME_MAX_LENGTH = 160;

export interface CompactMissingNameProjection {
  readonly names: string[];
  readonly total: number;
  readonly shown: number;
  readonly omitted: number;
}

const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
const member = `(?:(?:\\.|\\?\\.)${identifier}|(?:\\[|\\?\\.\\[)(?:0|[1-9][0-9]*)\\])`;
const transform = '(?:(?:\\.|\\?\\.)(?:toLowerCase|toUpperCase|trim)\\(\\))?';
const safeMissingName = new RegExp(`^${identifier}(?:${member})*${transform}$`);

export function projectCompactMissingNames(
  values: readonly string[] | undefined,
  authoritativeCount: unknown,
): CompactMissingNameProjection {
  const raw = [...new Set((values ?? [])
    .map((value) => value.trim())
    .filter(Boolean))]
    .sort(compareBinary);
  const safe = raw.filter(isSafeCompactMissingName);
  const names = safe.slice(0, COMPACT_MISSING_NAME_LIMIT);
  const total = Math.max(compactCount(authoritativeCount), raw.length);
  return {
    names, total, shown: names.length,
    omitted: Math.max(0, total - names.length),
  };
}

export function isSafeCompactMissingName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= COMPACT_MISSING_NAME_MAX_LENGTH
    && !hasControlCharacter(normalized)
    && safeMissingName.test(normalized);
}

export function normalizeCompactDecisionEquivalence(
  decision: CompactDecisionV1,
  status: CompactStatus,
  canonicalTarget: string | undefined,
  targetIdentityEqual = false,
  persistedIdentityEqual = false,
): void {
  removeEquivalentPersistedDecision(
    decision, status, canonicalTarget, persistedIdentityEqual,
  );
  if (decision.effectiveResolutionStatus === status)
    delete decision.effectiveResolutionStatus;
  if (targetIdentityEqual && canonicalTarget !== undefined
    && decision.effectiveTarget === canonicalTarget)
    delete decision.effectiveTarget;
}

export function compactMissingRemediation(
  projection: CompactMissingNameProjection,
  artifact: 'detailed diagnostic' | 'detailed trace edge',
): string {
  if (projection.total > 0 && projection.shown === projection.total)
    return 'Provide the missing variable names listed in details.';
  if (projection.shown > 0)
    return `Provide the listed names; inspect the correlated ${artifact} for omitted names.`;
  return `Inspect the correlated ${artifact} for missing variable names.`;
}

function removeEquivalentPersistedDecision(
  decision: CompactDecisionV1,
  status: CompactStatus,
  canonicalTarget: string | undefined,
  identityEqual: boolean,
): void {
  if (!identityEqual
    || decision.persistedResolutionStatus !== status
    || (decision.effectiveResolutionStatus !== undefined
      && decision.persistedResolutionStatus
        !== decision.effectiveResolutionStatus))
    return;
  if (!decision.persistedTarget || canonicalTarget === undefined
    || decision.persistedTarget !== canonicalTarget)
    return;
  delete decision.persistedResolutionStatus;
  delete decision.persistedTarget;
}

function compactCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
