import type { ImplementationHint } from '../types.js';

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
): ImplementationSelection {
  const evidence = asEvidence(rawEvidence);
  const scoped = hints ?? [];
  const matchingHints = scoped.filter((hint) => hintMatchesEdge(hint, evidence));
  if (matchingHints.length === 0) {
    if (legacyRepo) return selectCandidate(evidence, legacyHint(legacyRepo), 'implementation_repo_hint');
    const reason = scoped.length > 0 ? 'no_scoped_hint_matched_edge' : 'no_implementation_hint_supplied';
    return { blocksAutomatic: false, evidence: { status: 'not_matched', reason, strategy: 'scoped_implementation_hint' } };
  }
  if (matchingHints.length > 1) {
    return {
      blocksAutomatic: true,
      evidence: {
        status: 'tied',
        reason: 'multiple_scoped_hints_matched_edge',
        strategy: 'scoped_implementation_hint',
        matchedHints: matchingHints,
        candidateCount: matchingHints.length,
      },
    };
  }
  const hint = matchingHints[0];
  return hint ? selectCandidate(evidence, hint, 'scoped_implementation_hint') : { blocksAutomatic: false, evidence: { status: 'not_matched' } };
}

export function implementationHintDiagnostic(
  selection: ImplementationSelection,
  suggestions?: unknown,
): Record<string, unknown> | undefined {
  if (!selection.blocksAutomatic || selection.methodId) return undefined;
  return {
    severity: 'warning',
    code: 'implementation_hint_mismatch',
    message: 'Implementation hint did not select exactly one viable candidate',
    hintStatus: selection.evidence.status,
    candidateCount: selection.evidence.candidateCount,
    implementationHintSuggestions: Array.isArray(suggestions) && suggestions.length > 0 ? suggestions : undefined,
    implementationSelection: selection.evidence,
  };
}

export function implementationHintSuggestions(rawEvidence: Record<string, unknown>): Array<Record<string, unknown>> {
  const evidence = asEvidence(rawEvidence);
  const accepted = (evidence.candidates ?? []).filter((candidate) => candidate.accepted);
  if (accepted.length < 2) return [];
  const repos = selectableRepositories(accepted);
  return accepted
    .flatMap((candidate) => {
      const repo = candidate.handlerPackage?.name;
      if (!repo || !repos.includes(repo)) return [];
      const hint = suggestionHint(evidence, candidate, repo);
      return [{
        servicePath: hint.servicePath,
        operationPath: hint.operationPath,
        ambiguityReason: evidence.ambiguityReasons?.[0],
        candidateFamily: hint.candidateFamily,
        selectableImplementationRepositories: repos,
        implementationRepo: repo,
        hint,
        cli: `--implementation-hint ${hintString(hint)}`,
      }];
    });
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
  return value as EdgeEvidence;
}
