import { redactText } from '../utils/redaction.js';
import type {
  ImplementationHint,
  TraceOptions,
  TraceStart,
} from '../types.js';
import { compareBinary } from './traversal-scope.js';
import type {
  CompactDecisionInput,
  CompactDecisionV1,
  CompactDiagnosticDetailsV1,
  CompactDiagnosticRowV1,
  CompactEdgeObservation,
  CompactHintV1,
  CompactProjectedDiagnostic,
  CompactQueryV1,
  CompactStartV1,
  CompactStatusCountsV1,
} from './compact-contract.js';
import {
  compactMissingRemediation,
  isSafeCompactReferenceName,
  isSafeCompactSelectorSuggestion,
  projectCompactReferenceGroup,
  projectCompactMissingNames,
  type CompactMissingNameProjection,
} from './compact-decision-normalization.js';

const compactDiagnosticMessages: Readonly<Record<string, string>> = {
  schema_upgrade_required: 'The database schema must be upgraded before tracing.',
  reindex_required: 'Current analyzer facts are required before tracing.',
  trace_workspace_ambiguous: 'The trace workspace is ambiguous.',
  trace_runtime_variables_missing: 'Runtime variable names are required to resolve a branch.',
  implementation_hint_mismatch: 'The implementation hint did not select one implementation.',
  selected_handler_provenance_mismatch: 'Selected handler provenance did not match its graph target.',
  selected_handler_target_not_found: 'The selected handler target is not indexed.',
  trace_start_ambiguous: 'The trace start selector is ambiguous.',
  trace_start_not_found: 'The trace start selector did not match an indexed start.',
  trace_start_implementation_unresolved: 'The trace start implementation is unresolved.',
  event_shape_candidates_hidden:
    'Non-authoritative event-shape candidates were excluded from strict traversal.',
  event_shape_candidates_omitted:
    'Event-shape candidates exceeded the requested trace display cap.',
  external_package_calls_omitted:
    'Calls into packages without an indexed repository were omitted from trace edges.',
};
export const selectorDiagnosticCodes: ReadonlySet<string> = new Set([
  'handler_decorators_not_indexed',
  'handler_methods_not_indexed',
  'selector_repo_ambiguous',
  'selector_repo_not_found',
  'trace_start_ambiguous',
  'trace_start_implementation_unresolved',
  'trace_start_not_found',
]);

export function projectCompactDecision(
  input: CompactDecisionInput | undefined,
): CompactDecisionV1 {
  if (!input) return {};
  const out = resolutionDecision(input);
  addNameDecision(out, input);
  addDynamicDecision(out, input);
  addImplementationDecision(out, input);
  addEventDecision(out, input);
  const reasonCode = compactSafeCode(input.reasonCode);
  if (reasonCode) out.reasonCode = reasonCode;
  addRemediationDecision(out, input);
  return out;
}

function resolutionDecision(input: CompactDecisionInput): CompactDecisionV1 {
  const out: CompactDecisionV1 = {};
  const status = compactSafeCode(input.effectiveResolutionStatus);
  if (status) out.effectiveResolutionStatus = status;
  if (!persistedResolutionDiffers(input)) return out;
  const persistedStatus = compactSafeCode(input.persistedResolutionStatus);
  if (persistedStatus) out.persistedResolutionStatus = persistedStatus;
  return out;
}

function addNameDecision(out: CompactDecisionV1, input: CompactDecisionInput): void {
  const projection = projectCompactMissingNames(
    input.missingVariableNames, input.missingVariableCount,
  );
  applyMissingProjection(out, projection);
}

function addDynamicDecision(out: CompactDecisionV1, input: CompactDecisionInput): void {
  if (input.dynamicMode) out.dynamicMode = input.dynamicMode;
  if (input.candidateCount !== undefined) out.candidateCount = compactCount(input.candidateCount);
  if (input.viableCandidateCount !== undefined)
    out.viableCandidateCount = compactCount(input.viableCandidateCount);
  if (input.rejectedCandidateCount !== undefined)
    out.rejectedCandidateCount = compactCount(input.rejectedCandidateCount);
  if (input.omittedCandidateCount !== undefined)
    out.omittedCandidateCount = compactCount(input.omittedCandidateCount);
}

function addImplementationDecision(
  out: CompactDecisionV1,
  input: CompactDecisionInput,
): void {
  const strategy = compactSafeCode(input.implementationStrategy);
  if (strategy) out.implementationStrategy = strategy;
  const basis = compactSafeCode(input.selectionBasis);
  if (basis) out.selectionBasis = basis;
  if (input.implementationGuided !== undefined)
    out.implementationGuided = input.implementationGuided;
  if (input.implementationContextual !== undefined)
    out.implementationContextual = input.implementationContextual;
  if (input.tiedCandidateRepos)
    out.tiedCandidateRepos = input.tiedCandidateRepos;
}

function addEventDecision(out: CompactDecisionV1, input: CompactDecisionInput): void {
  addEventCodes(out, input);
  if (input.eventSubscriptionCount !== undefined)
    out.eventSubscriptionCount = compactCount(input.eventSubscriptionCount);
  if (input.roleSiteMatchCount !== undefined)
    out.roleSiteMatchCount = compactCount(input.roleSiteMatchCount);
}

function addEventCodes(out: CompactDecisionV1, input: CompactDecisionInput): void {
  const values: Array<[keyof CompactDecisionV1, string | undefined]> = [
    ['eventMatchStrategy', compactSafeCode(input.eventMatchStrategy)],
    ['dispatchCertainty', compactSafeCode(input.dispatchCertainty)],
    ['associationStatus', compactSafeCode(input.associationStatus)],
    ['associationBasis', compactSafeCode(input.associationBasis)],
    ['eventScope', compactSafeCode(input.eventScope)],
    ['callRole', compactSafeCode(input.callRole)],
    ['factOrigin', compactSafeCode(input.factOrigin)],
    ['bodyExpansion', compactSafeCode(input.bodyExpansion)],
  ];
  for (const [key, value] of values) {
    if (value) Object.assign(out, { [key]: value });
  }
}

function addRemediationDecision(
  out: CompactDecisionV1,
  input: CompactDecisionInput,
): void {
  const hint = decisionRemediation(input);
  if (!hint) return;
  out.remediationHint = hint;
  const total = Math.max(1, compactCount(input.remediationHintCount));
  out.omittedRemediationHintCount = Math.max(0, total - 1);
}

function decisionRemediation(input: CompactDecisionInput): string | undefined {
  if (input.remediationCode === 'provide_runtime_variables') {
    const projection = projectCompactMissingNames(
      input.missingVariableNames, input.missingVariableCount,
    );
    return compactMissingRemediation(projection, 'detailed trace edge');
  }
  return input.remediationCode
    ? compactRemediationHint(input.remediationCode) : undefined;
}

export function projectCompactDiagnostics(
  values: Array<Record<string, unknown>>,
): CompactProjectedDiagnostic[] {
  return values.map((value, index) => compactDiagnostic(value, index))
    .sort(compareCompactDiagnostic);
}

export function projectCompactStart(start: TraceStart): CompactStartV1 {
  return {
    repo: start.repo ?? null,
    servicePath: start.servicePath ?? null,
    operation: start.operation ?? null,
    operationPath: start.operationPath ?? null,
    handler: start.handler ?? null,
  };
}

export function projectCompactQuery(options: TraceOptions): CompactQueryV1 {
  const hints = (options.implementationHints ?? []).map(projectCompactHint)
    .sort((left, right) => compareBinary(
      JSON.stringify(left), JSON.stringify(right),
    ));
  return {
    depth: compactPositiveInteger(options.depth) ?? 25,
    includeAsync: Boolean(options.includeAsync),
    includeDb: Boolean(options.includeDb),
    includeExternal: Boolean(options.includeExternal),
    dynamicMode: options.dynamicMode ?? 'strict',
    maxDynamicCandidates: compactPositiveInteger(options.maxDynamicCandidates) ?? 5,
    suppliedVariableNames: compactSortedUnique(Object.keys(options.vars ?? {})),
    runtimeValuesOmitted: true,
    implementationRepo: options.implementationRepo ?? null,
    implementationHints: hints,
  };
}

function projectCompactHint(hint: ImplementationHint): CompactHintV1 {
  return {
    servicePath: hint.servicePath ?? null,
    operationPath: hint.operationPath ?? null,
    packageName: hint.packageName ?? null,
    repositoryName: hint.repositoryName ?? null,
    candidateFamily: hint.candidateFamily ?? null,
    implementationRepo: hint.implementationRepo ?? null,
  };
}

export function compactStatusCounts(
  values: CompactEdgeObservation[],
): CompactStatusCountsV1 {
  const counts: CompactStatusCountsV1 = {
    resolved: 0, terminal: 0, inferred: 0, dynamic: 0,
    ambiguous: 0, unresolved: 0, cycle: 0,
  };
  for (const value of values) counts[value.status] += 1;
  return counts;
}

export function compactCompleteness(
  counts: CompactStatusCountsV1,
  diagnostics: CompactDiagnosticRowV1[],
): 'complete' | 'partial' | 'blocked' {
  const total = compactStatusTotal(counts);
  if (total === 0 && diagnostics.some(compactBlockingDiagnostic)) return 'blocked';
  if (counts.dynamic + counts.ambiguous + counts.unresolved > 0) return 'partial';
  if (diagnostics.some((item) => item[1] === 'error' || item[1] === 'warning'))
    return 'partial';
  return 'complete';
}

export function compactStatusTotal(counts: CompactStatusCountsV1): number {
  return counts.resolved + counts.terminal + counts.inferred + counts.dynamic
    + counts.ambiguous + counts.unresolved + counts.cycle;
}

function compactBlockingDiagnostic(item: CompactDiagnosticRowV1): boolean {
  if (item[1] === 'error') return true;
  return item[2] === 'schema_upgrade_required'
    || item[2] === 'reindex_required'
    || item[2] === 'trace_workspace_ambiguous'
    || item[2].startsWith('selector_')
    || item[2].startsWith('trace_start_');
}

function compactDiagnostic(
  value: Record<string, unknown>,
  index: number,
): CompactProjectedDiagnostic {
  const code = compactSafeCode(value.code) ?? 'unknown_diagnostic';
  const details = compactDiagnosticDetails(value, code);
  const sourceMessage = typeof value.message === 'string'
    ? redactText(value.message).slice(0, 240) : undefined;
  return {
    index,
    severity: compactDiagnosticSeverity(value.severity),
    code,
    message: compactDiagnosticMessages[code]
      ?? sourceMessage
      ?? `Unknown compact diagnostic ${index}.`,
    file: compactSafeSourceFile(value.sourceFile) ?? compactSafeSourceFile(value.file),
    line: compactPositiveInteger(value.sourceLine) ?? compactPositiveInteger(value.line),
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function compactDiagnosticDetails(
  value: Record<string, unknown>,
  code: string,
): CompactDiagnosticDetailsV1 {
  const out: CompactDiagnosticDetailsV1 = {};
  const reasonCode = compactSafeCode(value.reasonCode);
  if (reasonCode) out.reasonCode = reasonCode;
  if (value.multiplicity !== undefined)
    out.multiplicity = compactCount(value.multiplicity);
  if (selectorDiagnosticCodes.has(code)) addDiagnosticSelector(out, value);
  if (code === 'reindex_required') addInvalidFactCategories(out, value);
  if (code === 'implementation_hint_mismatch')
    addImplementationHintCandidates(out, value);
  if (code === 'trace_runtime_variables_missing') addDiagnosticNames(out, value);
  addDiagnosticCounts(out, value);
  const hint = compactDiagnosticRemediation(code, out);
  if (hint) {
    out.remediationHint = hint;
    out.omittedHintCount = Math.max(
      0, compactDiagnosticHintCount(value, code, out) - 1,
    );
  }
  return out;
}

function addDiagnosticSelector(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  const selectorKind = compactSafeCode(value.selectorKind);
  if (selectorKind) out.selectorKind = selectorKind;
  const suggestions = projectCompactReferenceGroup(
    compactStringArray(value.selectorSuggestions),
    value.selectorSuggestionCount,
    isSafeCompactSelectorSuggestion,
  );
  if (suggestions) out.selectorSuggestions = suggestions;
}

function addInvalidFactCategories(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  const categories = compactRecordArray(value.invalidFactCategories)
    .flatMap((item) =>
      typeof item.category === 'string' ? [item.category] : []);
  const projection = projectCompactReferenceGroup(
    categories, value.invalidFactCategoryCount,
    (item) => compactSafeCode(item) === item,
  );
  if (projection) out.invalidFactCategories = projection;
}

function addImplementationHintCandidates(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  const repos = compactRecordArray(value.implementationHintSuggestions)
    .flatMap((item) =>
      typeof item.implementationRepo === 'string'
        ? [item.implementationRepo] : []);
  const uniqueCount = new Set(repos.map((repo) => repo.trim())).size;
  if (uniqueCount < 2) return;
  const projection = projectCompactReferenceGroup(
    repos, value.implementationHintSuggestionCount,
    isSafeCompactReferenceName,
  );
  if (projection) out.tiedCandidateRepos = projection;
}

function addDiagnosticNames(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  const projection = projectCompactMissingNames(
    compactStringArray(value.missingVariables), value.missingVariableCount,
  );
  applyMissingProjection(out, projection);
}

function applyMissingProjection(
  out: CompactDecisionV1 | CompactDiagnosticDetailsV1,
  projection: CompactMissingNameProjection,
): void {
  if (projection.names.length > 0) out.missingVariableNames = projection.names;
  if (projection.total === 0) return;
  out.missingVariableCount = projection.total;
  out.shownMissingVariableCount = projection.shown;
  out.omittedMissingVariableCount = projection.omitted;
}

function addDiagnosticCounts(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  if (value.candidateCount !== undefined)
    out.candidateCount = compactCount(value.candidateCount);
  if (value.shownCandidateCount !== undefined)
    out.shownCandidateCount = compactCount(value.shownCandidateCount);
  if (value.omittedCandidateCount !== undefined)
    out.omittedCandidateCount = compactCount(value.omittedCandidateCount);
  if (value.maxDynamicCandidates !== undefined)
    out.maxDynamicCandidates = compactCount(value.maxDynamicCandidates);
  if (value.viableCandidateCount !== undefined)
    out.viableCandidateCount = compactCount(value.viableCandidateCount);
  if (value.rejectedCandidateCount !== undefined)
    out.rejectedCandidateCount = compactCount(value.rejectedCandidateCount);
}

function compareCompactDiagnostic(
  left: CompactProjectedDiagnostic,
  right: CompactProjectedDiagnostic,
): number {
  const ranks = { error: 0, warning: 1, info: 2 } as const;
  return ranks[left.severity] - ranks[right.severity]
    || compareBinary(left.code, right.code)
    || compareBinary(left.file ?? '', right.file ?? '')
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || compareBinary(left.message, right.message)
    || left.index - right.index;
}

function persistedResolutionDiffers(input: CompactDecisionInput): boolean {
  return input.persistedResolutionStatus !== undefined
    && (input.persistedResolutionStatus !== input.effectiveResolutionStatus
      || JSON.stringify(input.persistedTarget) !== JSON.stringify(input.effectiveTarget));
}

function compactDiagnosticSeverity(value: unknown): 'error' | 'warning' | 'info' {
  return value === 'error' || value === 'warning' ? value : 'info';
}

function compactDiagnosticRemediation(
  code: string,
  details: CompactDiagnosticDetailsV1,
): string | undefined {
  if (code === 'schema_upgrade_required' || code === 'reindex_required')
    return compactRemediationHint('reindex_and_link');
  if (code === 'trace_runtime_variables_missing')
    return compactMissingRemediation({
      names: details.missingVariableNames ?? [],
      total: details.missingVariableCount ?? 0,
      shown: details.shownMissingVariableCount ?? 0,
      omitted: details.omittedMissingVariableCount ?? 0,
    }, 'detailed diagnostic');
  if (code === 'implementation_hint_mismatch')
    return compactRemediationHint('select_implementation');
  if (code === 'event_shape_candidates_hidden')
    return 'Use --dynamic-mode candidates to inspect bounded subscriber candidates.';
  if (code === 'event_shape_candidates_omitted')
    return 'Increase --max-dynamic-candidates to inspect more candidates.';
  return undefined;
}

function compactDiagnosticHintCount(
  value: Record<string, unknown>,
  code: string,
  details: CompactDiagnosticDetailsV1,
): number {
  const missing = code === 'trace_runtime_variables_missing'
    ? details.missingVariableCount ?? 0 : 0;
  return Math.max(1, missing, compactArrayLength(value.suggestions),
    compactArrayLength(value.implementationHintSuggestions),
    compactArrayLength(value.copyableExamples), compactCount(value.suggestionCount),
    compactCount(value.implementationHintSuggestionCount),
    compactCount(value.copyableExampleCount));
}

function compactRemediationHint(code: string): string | undefined {
  if (code === 'provide_runtime_variables') return 'Provide the missing variable names listed in details.';
  if (code === 'select_implementation')
    return 'Use --implementation-hint with service, operation, package, repository, family, and repo keys; repo is required.';
  if (code === 'reindex_and_link') return 'Force reindex, then force relink the workspace.';
  if (code === 'inspect_detailed_edge') return 'Inspect the correlated detailed trace edge.';
  return undefined;
}

export function compactSafeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value)
    ? value : undefined;
}

export function projectCompactDecisionTarget(
  kindValue: string,
  id: string,
): string | undefined {
  const kind = compactSafeCode(kindValue);
  if (!kind || id.length === 0 || id.length > 240 || /[\r\n]/.test(id)) return undefined;
  if (/^[a-z]+:\/\//i.test(id)
    || /\b(?:bearer|token|secret|password|credential|authorization)\b/i.test(id))
    return undefined;
  const redacted = redactText(id);
  return redacted === id ? `${kind}:${redacted}` : undefined;
}

function compactSafeSourceFile(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/^[a-z]+:\/\//i.test(value) && !/[\r\n]/.test(value) ? value : undefined;
}

function compactCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : 0;
}

function compactPositiveInteger(value: unknown): number | undefined {
  const normalized = compactCount(value);
  return normalized > 0 ? normalized : undefined;
}

function compactStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
}

function compactRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function compactArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function compactSortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareBinary);
}
