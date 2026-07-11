import type { ImplementationHint } from '../types.js';
import { projectBounded } from '../utils/000-bounded-projection.js';

interface Candidate {
  accepted?: boolean;
  methodId?: number;
  sourceFile?: string;
  handlerPackage?: { name?: string; packageName?: string };
  modelPackage?: { name?: string; packageName?: string };
  servicePath?: string;
  operationPath?: string;
}

interface EdgeEvidence {
  servicePath?: string;
  operationPath?: string;
  ambiguityReasons?: string[];
  candidateFamilies?: Array<{ packageName?: string }>;
  candidates?: Candidate[];
  modelPackage?: { name?: string; packageName?: string };
}

export interface ImplementationSelection {
  methodId?: string;
  blocksAutomatic: boolean;
  evidence: Record<string, unknown>;
}

export interface ImplementationHintSuggestionProjection {
  suggestions: Array<Record<string, unknown>>;
  suggestionCount: number;
  shownSuggestionCount: number;
  omittedSuggestionCount: number;
}

export function parseImplementationHint(value: string): ImplementationHint {
  const hint: Partial<ImplementationHint> = {};
  for (const part of value.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator === part.length - 1) throw new Error(`Invalid implementation hint field: ${part}`);
    assignHintField(hint, part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  if (!hint.implementationRepo) throw new Error('Scoped implementation hint requires an implementation repo selection');
  return { ...hint, implementationRepo: hint.implementationRepo };
}

export function selectImplementation(
  rawEvidence: Record<string, unknown>,
  hints: ImplementationHint[] | undefined,
  legacyRepo: string | undefined,
  canonicalEvidence?: Record<string, unknown>,
): ImplementationSelection {
  const evidence = asEvidence(canonicalEvidence ?? rawEvidence);
  const scoped = hints ?? [];
  const matchingHints = scoped.filter((hint) => hintMatchesEdge(hint, evidence));
  if (matchingHints.length === 0) {
    if (legacyRepo) return selectCandidate(evidence, legacyHint(legacyRepo), 'implementation_repo_hint');
    const reason = scoped.length > 0 ? 'no_scoped_hint_matched_edge' : 'no_implementation_hint_supplied';
    return { blocksAutomatic: false, evidence: { status: 'not_matched', reason, strategy: 'scoped_implementation_hint' } };
  }
  if (matchingHints.length > 1) {
    const projection = projectBounded(matchingHints, compareHints);
    return {
      blocksAutomatic: true,
      evidence: {
        status: 'tied',
        reason: 'multiple_scoped_hints_matched_edge',
        strategy: 'scoped_implementation_hint',
        matchedHints: projection.items,
        candidateCount: matchingHints.length,
        matchedHintCount: projection.totalCount,
        shownMatchedHintCount: projection.shownCount,
        omittedMatchedHintCount: projection.omittedCount,
      },
    };
  }
  const hint = matchingHints[0];
  return hint ? selectCandidate(evidence, hint, 'scoped_implementation_hint') : { blocksAutomatic: false, evidence: { status: 'not_matched' } };
}

export function implementationHintDiagnostic(
  selection: ImplementationSelection,
  suggestionEvidence?: unknown,
): Record<string, unknown> | undefined {
  if (!selection.blocksAutomatic || selection.methodId) return undefined;
  const suggestions = projectedSuggestions(suggestionEvidence);
  return {
    severity: 'warning',
    code: 'implementation_hint_mismatch',
    message: 'Implementation hint did not select exactly one viable candidate',
    hintStatus: selection.evidence.status,
    candidateCount: selection.evidence.candidateCount,
    implementationHintSuggestions: suggestions.suggestions.length > 0
      ? suggestions.suggestions
      : undefined,
    implementationHintSuggestionCount: suggestions.suggestionCount,
    shownImplementationHintSuggestionCount: suggestions.shownSuggestionCount,
    omittedImplementationHintSuggestionCount: suggestions.omittedSuggestionCount,
    implementationSelection: selection.evidence,
  };
}

export function implementationHintSuggestions(rawEvidence: Record<string, unknown>): Array<Record<string, unknown>> {
  return implementationHintSuggestionProjection(rawEvidence).suggestions;
}

export function implementationHintSuggestionProjection(
  rawEvidence: Record<string, unknown>,
): ImplementationHintSuggestionProjection {
  const evidence = asEvidence(rawEvidence);
  const accepted = (evidence.candidates ?? []).filter((candidate) => candidate.accepted);
  if (accepted.length < 2) {
    return {
      suggestions: [],
      suggestionCount: 0,
      shownSuggestionCount: 0,
      omittedSuggestionCount: 0,
    };
  }
  const repos = selectableRepositories(accepted);
  const repositoryProjection = projectBounded(
    repos, (left, right) => left.localeCompare(right),
  );
  const suggestions = accepted
    .flatMap((candidate) => {
      const repo = candidate.handlerPackage?.name;
      if (!repo || !repos.includes(repo)) return [];
      const hint = suggestionHint(evidence, candidate, repo);
      return [{
        servicePath: hint.servicePath,
        operationPath: hint.operationPath,
        ambiguityReason: evidence.ambiguityReasons?.[0],
        candidateFamily: hint.candidateFamily,
        selectableImplementationRepositories: repositoryProjection.items,
        selectableImplementationRepositoryCount: repositoryProjection.totalCount,
        shownSelectableImplementationRepositoryCount:
          repositoryProjection.shownCount,
        omittedSelectableImplementationRepositoryCount:
          repositoryProjection.omittedCount,
        implementationRepo: repo,
        hint,
        cli: `--implementation-hint ${hintString(hint)}`,
      }];
    });
  const projection = projectBounded(suggestions, compareSuggestion);
  return {
    suggestions: projection.items,
    suggestionCount: projection.totalCount,
    shownSuggestionCount: projection.shownCount,
    omittedSuggestionCount: projection.omittedCount,
  };
}

function projectedSuggestions(value: unknown): ImplementationHintSuggestionProjection {
  const evidence = objectRecord(value);
  const values = Array.isArray(value)
    ? recordSuggestions(value)
    : recordSuggestions(evidence.implementationHintSuggestions);
  const projection = projectBounded(values, compareSuggestion);
  const total = Math.max(
    numericValue(evidence.implementationHintSuggestionCount),
    projection.totalCount,
  );
  return {
    suggestions: projection.items,
    suggestionCount: total,
    shownSuggestionCount: projection.shownCount,
    omittedSuggestionCount: Math.max(0, total - projection.shownCount),
  };
}

function compareHints(left: ImplementationHint, right: ImplementationHint): number {
  return hintString(left).localeCompare(hintString(right));
}

function compareSuggestion(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return String(left.cli ?? '').localeCompare(String(right.cli ?? ''))
    || String(left.implementationRepo ?? '').localeCompare(
      String(right.implementationRepo ?? ''),
    );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordSuggestions(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function selectableRepositories(candidates: Candidate[]): string[] {
  const repos = new Set(candidates.flatMap((candidate) => candidate.handlerPackage?.name ? [candidate.handlerPackage.name] : []));
  return [...repos]
    .filter((repo) => candidates.filter((candidate) => candidateMatchesRepo(candidate, repo)).length === 1)
    .sort();
}

function assignHintField(hint: Partial<ImplementationHint>, key: string, value: string): void {
  if (key === 'service' || key === 'servicePath') hint.servicePath = value;
  else if (key === 'operation' || key === 'operationPath') hint.operationPath = value;
  else if (key === 'package' || key === 'packageName') hint.packageName = value;
  else if (key === 'repository' || key === 'repositoryName') hint.repositoryName = value;
  else if (key === 'family' || key === 'candidateFamily') hint.candidateFamily = value;
  else if (key === 'repo' || key === 'implementationRepo' || key === 'select') hint.implementationRepo = value;
  else throw new Error(`Unknown implementation hint field: ${key}`);
}

function selectCandidate(evidence: EdgeEvidence, hint: ImplementationHint, strategy: string): ImplementationSelection {
  const matches = (evidence.candidates ?? []).filter((candidate) =>
    candidate.accepted && candidateMatchesRepo(candidate, hint.implementationRepo));
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!selected || selected.methodId === undefined) {
    return {
      blocksAutomatic: true,
      evidence: {
        status: matches.length > 1 ? 'tied' : 'not_matched',
        reason: matches.length > 1 ? 'hint_matched_multiple_candidates' : 'hint_matched_zero_candidates',
        strategy,
        matchedHint: hint,
        selectedRepo: hint.implementationRepo,
        candidateCount: matches.length,
      },
    };
  }
  return {
    methodId: String(selected.methodId),
    blocksAutomatic: false,
    evidence: {
      status: 'selected',
      guided: true,
      strategy,
      matchedHint: hint,
      selectedRepo: hint.implementationRepo,
      selectedMethodId: selected.methodId,
      ambiguityReason: evidence.ambiguityReasons?.[0],
    },
  };
}

function suggestionHint(evidence: EdgeEvidence, candidate: Candidate, repo: string): ImplementationHint {
  const servicePath = evidence.servicePath ?? candidate.servicePath;
  const operationPath = evidence.operationPath ?? candidate.operationPath;
  const family = usefulCandidateFamily(evidence, candidate);
  return {
    ...(servicePath ? { servicePath } : {}),
    ...(operationPath ? { operationPath } : {}),
    ...(evidence.modelPackage?.packageName ? { packageName: evidence.modelPackage.packageName } : {}),
    ...(evidence.modelPackage?.name ? { repositoryName: evidence.modelPackage.name } : {}),
    ...(family ? { candidateFamily: family } : {}),
    implementationRepo: repo,
  };
}

function usefulCandidateFamily(evidence: EdgeEvidence, candidate: Candidate): string | undefined {
  const family = candidate.handlerPackage?.packageName;
  if (!family) return undefined;
  if ((evidence.candidateFamilies ?? []).some((item) => item.packageName === family)) return family;
  const acceptedFamilies = new Set(
    (evidence.candidates ?? [])
      .filter((item) => item.accepted)
      .flatMap((item) => item.handlerPackage?.packageName ? [item.handlerPackage.packageName] : []),
  );
  return acceptedFamilies.size > 1 ? family : undefined;
}

function hintString(hint: ImplementationHint): string {
  const fields = [
    ['service', hint.servicePath],
    ['operation', hint.operationPath],
    ['package', hint.packageName],
    ['repository', hint.repositoryName],
    ['family', hint.candidateFamily],
    ['repo', hint.implementationRepo],
  ];
  return fields.flatMap(([key, value]) => value ? [`${key}=${value}`] : []).join(',');
}

function hintMatchesEdge(hint: ImplementationHint, evidence: EdgeEvidence): boolean {
  const model = evidence.modelPackage ?? evidence.candidates?.[0]?.modelPackage;
  const familyNames = new Set([
    ...(evidence.candidateFamilies ?? []).flatMap((family) => family.packageName ? [family.packageName] : []),
    ...(evidence.candidates ?? []).flatMap((candidate) => candidate.handlerPackage?.packageName ? [candidate.handlerPackage.packageName] : []),
  ]);
  return matches(hint.servicePath, evidence.servicePath ?? evidence.candidates?.[0]?.servicePath)
    && matches(hint.operationPath, evidence.operationPath ?? evidence.candidates?.[0]?.operationPath)
    && matches(hint.packageName, model?.packageName)
    && matches(hint.repositoryName, model?.name)
    && (!hint.candidateFamily || familyNames.has(hint.candidateFamily));
}

function candidateMatchesRepo(candidate: Candidate, value: string): boolean {
  return candidate.handlerPackage?.name === value
    || candidate.handlerPackage?.packageName === value
    || candidate.sourceFile?.startsWith(value) === true;
}

function matches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function legacyHint(implementationRepo: string): ImplementationHint {
  return { implementationRepo };
}

function asEvidence(value: Record<string, unknown>): EdgeEvidence {
  return {
    servicePath: stringValue(value.servicePath),
    operationPath: stringValue(value.operationPath),
    ambiguityReasons: stringArray(value.ambiguityReasons),
    candidateFamilies: candidateFamilies(value.candidateFamilies),
    candidates: candidates(value.candidates),
    modelPackage: packageValue(value.modelPackage),
  };
}

function candidates(value: unknown): Candidate[] {
  return recordSuggestions(value).map((candidate) => ({
    accepted: candidate.accepted === true,
    methodId: numericValue(candidate.methodId) || undefined,
    sourceFile: stringValue(candidate.sourceFile),
    handlerPackage: packageValue(candidate.handlerPackage),
    modelPackage: packageValue(candidate.modelPackage),
    servicePath: stringValue(candidate.servicePath),
    operationPath: stringValue(candidate.operationPath),
  }));
}

function candidateFamilies(value: unknown): Array<{ packageName?: string }> {
  return recordSuggestions(value).map((family) => ({
    packageName: stringValue(family.packageName),
  }));
}

function packageValue(value: unknown): { name?: string; packageName?: string } | undefined {
  const candidate = objectRecord(value);
  const name = stringValue(candidate.name);
  const packageName = stringValue(candidate.packageName);
  return name || packageName ? { name, packageName } : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
