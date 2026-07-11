export const DEFAULT_EVIDENCE_CANDIDATE_LIMIT = 5;

export interface BoundedProjection<T> {
  totalCount: number;
  shownCount: number;
  omittedCount: number;
  items: T[];
}

export function projectBounded<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  limit = DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
): BoundedProjection<T> {
  const normalizedLimit = positiveLimit(limit);
  const sorted = [...values].sort(compare);
  const items = sorted.slice(0, normalizedLimit);
  return {
    totalCount: sorted.length,
    shownCount: items.length,
    omittedCount: Math.max(0, sorted.length - items.length),
    items,
  };
}

export function positiveLimit(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : DEFAULT_EVIDENCE_CANDIDATE_LIMIT;
}

const candidateLikeCollections = new Set([
  'candidates',
  'candidateScores',
  'candidateFamilies',
  'candidateEvidence',
  'candidatePaths',
  'candidateRawPaths',
  'candidateNormalizedOperationPaths',
  'normalizedCandidateOperations',
  'candidateLiterals',
  'bindingCandidates',
  'bindingAlternatives',
  'implementationHintSuggestions',
  'selectableImplementationRepositories',
  'matchedHints',
  'candidateSuggestions',
  'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions',
  'rejectedCandidates',
  'suggestedVarSets',
  'copyableExamples',
  'selectorSuggestions',
  'serviceSuggestions',
  'repositories',
  'examples',
  'expandedExamples',
  'registrations',
]);

/**
 * Parser facts are retained in their tables; graph evidence only carries a
 * deterministic explanation. This prevents nested parser alternatives from
 * bypassing the graph evidence cap while leaving canonical facts queryable.
 */
export function boundCandidateLikeEvidence(
  evidence: Record<string, unknown>,
  limit = DEFAULT_EVIDENCE_CANDIDATE_LIMIT,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!Array.isArray(value) || !candidateLikeCollections.has(key)) {
      output[key] = boundNestedEvidence(value, limit);
      continue;
    }
    const projection = projectBounded(value, compareEvidenceValue, limit);
    output[key] = projection.items.map((item) => boundNestedEvidence(item, limit));
    addCollectionCounts(output, evidence, key, projection);
  }
  return output;
}

function boundNestedEvidence(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) return value.map((item) => boundNestedEvidence(item, limit));
  if (!isEvidenceRecord(value)) return value;
  return boundCandidateLikeEvidence(value, limit);
}

function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addCollectionCounts(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  projection: BoundedProjection<unknown>,
): void {
  const stem = collectionStem(key);
  const countName = `${stem}Count`;
  const shownName = `shown${upperFirst(stem)}Count`;
  const omittedName = `omitted${upperFirst(stem)}Count`;
  const total = Math.max(numericValue(input[countName]), projection.totalCount);
  output[countName] = total;
  output[shownName] = projection.shownCount;
  output[omittedName] = Math.max(0, total - projection.shownCount);
}

function collectionStem(key: string): string {
  const stems: Record<string, string> = {
    candidates: 'candidate',
    candidateScores: 'candidateScore',
    candidateFamilies: 'candidateFamily',
    candidateEvidence: 'candidateEvidence',
    candidatePaths: 'candidatePath',
    candidateRawPaths: 'candidateRawPath',
    candidateNormalizedOperationPaths: 'candidateNormalizedOperationPath',
    normalizedCandidateOperations: 'normalizedCandidateOperation',
    candidateLiterals: 'candidateLiteral',
    bindingCandidates: 'bindingCandidate',
    bindingAlternatives: 'bindingAlternative',
    implementationHintSuggestions: 'implementationHintSuggestion',
    selectableImplementationRepositories: 'selectableImplementationRepository',
    matchedHints: 'matchedHint',
    candidateSuggestions: 'candidateSuggestion',
    dynamicTargetCandidates: 'dynamicTargetCandidate',
    dynamicTargetCandidateSuggestions: 'dynamicTargetCandidateSuggestion',
    rejectedCandidates: 'rejectedCandidate',
    suggestedVarSets: 'suggestedVarSet',
    copyableExamples: 'copyableExample',
    selectorSuggestions: 'selectorSuggestion',
    serviceSuggestions: 'serviceSuggestion',
    repositories: 'repository',
    examples: 'example',
    expandedExamples: 'expandedExample',
    registrations: 'registration',
  };
  return stems[key] ?? 'candidate';
}

function compareEvidenceValue(left: unknown, right: unknown): number {
  return stableProjectionValue(left).localeCompare(stableProjectionValue(right));
}

export function stableProjectionValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableProjectionValue).join(',')}]`;
  if (isEvidenceRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableProjectionValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? '';
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function upperFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}
