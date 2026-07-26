import { compareBinary } from './traversal-scope.js';
import type {
  CompactDecisionV1,
  CompactReferenceGroupV1,
  CompactStatus,
} from './compact-contract.js';

export const COMPACT_MISSING_NAME_LIMIT = 8;
export const COMPACT_MISSING_NAME_MAX_LENGTH = 160;
export const COMPACT_REFERENCE_VALUE_LIMIT = 5;
const COMPACT_REFERENCE_VALUE_MAX_LENGTH = 240;

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
  const candidates = new Map<string, boolean>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (!normalized) continue;
    candidates.set(
      normalized,
      (candidates.get(normalized) ?? true) && isSafeCompactMissingName(value),
    );
  }
  const raw = [...candidates.keys()].sort(compareBinary);
  const safe = raw.filter((name) => candidates.get(name) === true);
  const names = safe.slice(0, COMPACT_MISSING_NAME_LIMIT);
  const total = Math.max(compactCount(authoritativeCount), raw.length);
  return {
    names, total, shown: names.length,
    omitted: Math.max(0, total - names.length),
  };
}

export function isSafeCompactMissingName(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= COMPACT_MISSING_NAME_MAX_LENGTH
    && safeMissingName.test(normalized);
}

export function projectCompactReferenceGroup(
  values: readonly string[] | undefined,
  authoritativeCount: unknown,
  isSafe: (value: string) => boolean,
): CompactReferenceGroupV1 | undefined {
  const candidates = normalizedReferenceValues(values, isSafe);
  const unique = [...candidates.keys()].sort(compareBinary);
  const safe = unique.filter((value) => candidates.get(value) === true);
  const shown = safe.slice(0, COMPACT_REFERENCE_VALUE_LIMIT);
  const total = Math.max(compactCount(authoritativeCount), unique.length);
  if (total === 0) return undefined;
  return {
    values: shown,
    total,
    shown: shown.length,
    omitted: Math.max(0, total - shown.length),
  };
}

export function isSafeCompactReferenceName(value: string): boolean {
  if (!safeReferenceText(value, 160)) return false;
  return /^[@A-Za-z0-9_$][@A-Za-z0-9_$./:-]*$/.test(value.trim());
}

export function isSafeCompactSelectorSuggestion(value: string): boolean {
  if (!safeReferenceText(value, COMPACT_REFERENCE_VALUE_MAX_LENGTH))
    return false;
  return /^(?:--(?:repo|service|operation|path|handler) [@A-Za-z0-9_$./:-]+)(?: --(?:repo|service|operation|path|handler) [@A-Za-z0-9_$./:-]+)*$/
    .test(value.trim());
}

export function normalizeCompactDecisionEquivalence(
  decision: CompactDecisionV1,
  status: CompactStatus,
  canonicalTarget: string | undefined,
  targetIdentityEqual = false,
  persistedIdentityEqual = false,
  rawPersistedStatus?: string,
): void {
  if (decision.effectiveResolutionStatus === status)
    delete decision.effectiveResolutionStatus;
  removeEquivalentPersistedDecision(
    decision, status, canonicalTarget, persistedIdentityEqual,
    rawPersistedStatus,
  );
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
  rawPersistedStatus: string | undefined,
): void {
  if (!identityEqual
    || rawPersistedStatus !== status
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

function normalizedReferenceValues(
  values: readonly string[] | undefined,
  isSafe: (value: string) => boolean,
): Map<string, boolean> {
  const unique = new Map<string, boolean>();
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value) continue;
    unique.set(value, (unique.get(value) ?? true) && isSafe(raw));
  }
  return unique;
}

function safeReferenceText(value: string, maxLength: number): boolean {
  if (hasControlCharacter(value)) return false;
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= maxLength
    && !/^[a-z]+:\/\//i.test(normalized)
    && !/(?:^|[^A-Za-z0-9])(?:authorization|bearer|credential|destination|password|secret|token)(?:$|[^A-Za-z0-9])/i
      .test(normalized);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
