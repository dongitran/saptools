import {
  projectBounded,
  type BoundedProjection,
} from '../utils/000-bounded-projection.js';

export function boundedImplementationEvidence(
  evidence: Record<string, unknown>,
  targetCandidateCount: number,
): Record<string, unknown> {
  const candidates = recordArray(evidence.candidates);
  const candidateProjection = projectBounded(candidates, compareCandidateEvidence);
  const families = recordArray(evidence.candidateFamilies);
  const familyProjection = projectBounded(families, compareFamilies);
  const hints = recordArray(evidence.implementationHintSuggestions);
  const hintProjection = projectBounded(hints, compareHints);
  const hintCount = Math.max(
    numberValue(evidence.implementationHintSuggestionCount),
    hintProjection.totalCount,
  );
  const targets = Math.max(0, targetCandidateCount);
  return {
    ...evidence,
    candidates: candidateProjection.items.map(boundedCandidateEvidence),
    candidateCount: candidateProjection.totalCount,
    shownCandidateCount: candidateProjection.shownCount,
    omittedCandidateCount: candidateProjection.omittedCount,
    candidateFamilies: familyProjection.items.map(boundedFamilyEvidence),
    candidateFamilyCount: familyProjection.totalCount,
    shownCandidateFamilyCount: familyProjection.shownCount,
    omittedCandidateFamilyCount: familyProjection.omittedCount,
    implementationHintSuggestions: hintProjection.items,
    implementationHintSuggestionCount: hintCount,
    shownImplementationHintSuggestionCount: hintProjection.shownCount,
    omittedImplementationHintSuggestionCount: Math.max(0, hintCount - hintProjection.shownCount),
    candidateTargetCount: targets,
    shownCandidateTargetCount: Math.min(targets, candidateProjection.shownCount),
    omittedCandidateTargetCount: Math.max(0, targets - candidateProjection.shownCount),
  };
}

export function boundedImplementationTargetIds(
  candidates: Array<Record<string, unknown>>,
): BoundedProjection<string> {
  const projection = projectBounded(candidates, compareTargetCandidates);
  return {
    totalCount: projection.totalCount,
    shownCount: projection.shownCount,
    omittedCount: projection.omittedCount,
    items: projection.items.map((candidate) => String(candidate.methodId ?? '')),
  };
}

function boundedCandidateEvidence(candidate: Record<string, unknown>): Record<string, unknown> {
  const registrations = recordArray(candidate.registrations);
  const projection = projectBounded(registrations, compareRegistrations);
  return {
    ...candidate,
    registrations: projection.items,
    registrationCount: projection.totalCount,
    shownRegistrationCount: projection.shownCount,
    omittedRegistrationCount: projection.omittedCount,
  };
}

function boundedFamilyEvidence(family: Record<string, unknown>): Record<string, unknown> {
  const repositories = stringArray(family.repositories);
  const projection = projectBounded(repositories, (left, right) => left.localeCompare(right));
  return {
    ...family,
    repositories: projection.items,
    repositoryCount: projection.totalCount,
    shownRepositoryCount: projection.shownCount,
    omittedRepositoryCount: projection.omittedCount,
  };
}

function compareTargetCandidates(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return Number(right.score ?? 0) - Number(left.score ?? 0)
    || String(left.className ?? '').localeCompare(String(right.className ?? ''))
    || Number(left.methodId ?? 0) - Number(right.methodId ?? 0);
}

function compareCandidateEvidence(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return Number(left.rank ?? 0) - Number(right.rank ?? 0)
    || compareTargetCandidates(left, right);
}

function compareFamilies(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.packageName ?? '').localeCompare(String(right.packageName ?? ''))
    || String(left.reason ?? '').localeCompare(String(right.reason ?? ''));
}

function compareHints(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.cli ?? '').localeCompare(String(right.cli ?? ''))
    || String(left.implementationRepo ?? '').localeCompare(String(right.implementationRepo ?? ''));
}

function compareRegistrations(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.file ?? '').localeCompare(String(right.file ?? ''))
    || Number(left.line ?? 0) - Number(right.line ?? 0)
    || Number(left.id ?? 0) - Number(right.id ?? 0);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
