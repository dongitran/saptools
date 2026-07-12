import {
  projectBoundedInOrder,
  type BoundedProjection,
} from '../utils/000-bounded-projection.js';

type Diagnostic = Record<string, unknown>;

const boundedDoctorArrayKeys = new Set([
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
  'registrations',
  'implementationHintSuggestions',
  'selectableImplementationRepositories',
  'matchedHints',
  'candidateSuggestions',
  'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions',
  'rejectedCandidates',
  'suggestedVarSets',
  'copyableExamples',
  'examples',
  'expandedExamples',
  'selectorSuggestions',
  'serviceSuggestions',
  'repositories',
]);

export function boundDoctorDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map(boundDoctorDiagnostic);
}

function boundDoctorDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const bounded = boundDoctorValue(diagnostic);
  return isDiagnostic(bounded) ? bounded : {};
}

function boundDoctorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(boundDoctorValue);
  if (!isDiagnostic(value)) return value;
  const input = value;
  const output: Diagnostic = {};
  for (const [key, child] of Object.entries(input)) {
    if (!Array.isArray(child) || !boundedDoctorArrayKeys.has(key)) {
      output[key] = boundDoctorValue(child);
      continue;
    }
    // Doctor producers already query or assemble deterministic semantic order.
    const projection = projectBoundedInOrder(child.map(boundDoctorValue));
    output[key] = projection.items;
    addProjectionMetadata(output, input, key, projection);
  }
  return output;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addProjectionMetadata(
  output: Diagnostic,
  input: Diagnostic,
  key: string,
  projection: BoundedProjection<unknown>,
): void {
  const names = projectionNames(key);
  const total = Math.max(
    numericValue(input[names.total]),
    projection.totalCount,
    siblingCollectionCount(input, key),
  );
  output[names.total] = total;
  output[names.shown] = projection.shownCount;
  output[names.omitted] = Math.max(0, total - projection.shownCount);
}

function siblingCollectionCount(input: Diagnostic, key: string): number {
  if (key !== 'examples' || !Array.isArray(input.expandedExamples)) return 0;
  return input.expandedExamples.length;
}

function projectionNames(key: string): { total: string; shown: string; omitted: string } {
  const stem = projectionStem(key);
  return {
    total: `${stem}Count`,
    shown: `shown${upperFirst(stem)}Count`,
    omitted: `omitted${upperFirst(stem)}Count`,
  };
}

function projectionStem(key: string): string {
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
    registrations: 'registration',
    implementationHintSuggestions: 'implementationHintSuggestion',
    selectableImplementationRepositories: 'selectableImplementationRepository',
    matchedHints: 'matchedHint',
    candidateSuggestions: 'candidateSuggestion',
    dynamicTargetCandidates: 'dynamicTargetCandidate',
    dynamicTargetCandidateSuggestions: 'dynamicTargetCandidateSuggestion',
    rejectedCandidates: 'rejectedCandidate',
    suggestedVarSets: 'suggestedVarSet',
    copyableExamples: 'copyableExample',
    examples: 'example',
    expandedExamples: 'expandedExample',
    selectorSuggestions: 'selectorSuggestion',
    serviceSuggestions: 'serviceSuggestion',
  };
  return stems[key] ?? 'repository';
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function upperFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}
