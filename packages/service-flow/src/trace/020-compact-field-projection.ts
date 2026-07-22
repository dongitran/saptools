import { redactText } from '../utils/redaction.js';
import type {
  ImplementationHint,
  TraceOptions,
  TraceStart,
} from '../types.js';
import { compareBinary } from './010-traversal-scope.js';
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
} from './014-compact-contract.js';

const compactNameLimit = 8;
const compactDiagnosticMessages: Readonly<Record<string, string>> = {
  schema_upgrade_required: 'The database schema must be upgraded before tracing.',
  reindex_required: 'Current analyzer facts are required before tracing.',
  trace_workspace_ambiguous: 'The trace workspace is ambiguous.',
  trace_runtime_variables_missing: 'Runtime variable names are required to resolve a branch.',
  implementation_hint_mismatch: 'The implementation hint did not select one implementation.',
  selected_handler_provenance_mismatch: 'Selected handler provenance did not match its graph target.',
  selected_handler_target_not_found: 'The selected handler target is not indexed.',
  trace_start_implementation_unresolved: 'The trace start implementation is unresolved.',
};

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
  const allNames = safeVariableNames(input.missingVariableNames);
  const names = allNames.slice(0, compactNameLimit);
  const total = Math.max(compactCount(input.missingVariableCount), allNames.length);
  if (names.length > 0) out.missingVariableNames = names;
  if (total === 0) return;
  out.missingVariableCount = total;
  out.shownMissingVariableCount = names.length;
  out.omittedMissingVariableCount = Math.max(0, total - names.length);
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
  if (input.implementationGuided !== undefined)
    out.implementationGuided = input.implementationGuided;
  if (input.implementationContextual !== undefined)
    out.implementationContextual = input.implementationContextual;
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
  const hint = input.remediationCode
    ? compactRemediationHint(input.remediationCode) : undefined;
  if (!hint) return;
  out.remediationHint = hint;
  const total = Math.max(1, compactCount(input.remediationHintCount));
  out.omittedRemediationHintCount = Math.max(0, total - 1);
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

export function removeEquivalentCompactPersistedDecision(
  decision: CompactDecisionV1,
): void {
  if (decision.persistedResolutionStatus !== decision.effectiveResolutionStatus) return;
  if (!decision.persistedTarget || decision.persistedTarget !== decision.effectiveTarget) return;
  delete decision.persistedResolutionStatus;
  delete decision.persistedTarget;
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
  return {
    index,
    severity: compactDiagnosticSeverity(value.severity),
    code,
    message: compactDiagnosticMessages[code] ?? `See detailed diagnostic at index ${index}.`,
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
  addDiagnosticNames(out, value);
  addDiagnosticCounts(out, value);
  const hint = compactDiagnosticRemediation(code);
  if (hint) {
    out.remediationHint = hint;
    out.omittedHintCount = Math.max(
      0, compactDiagnosticHintCount(value, code, out) - 1,
    );
  }
  return out;
}

function addDiagnosticNames(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  const allNames = safeVariableNames(compactStringArray(value.missingVariables));
  const names = allNames.slice(0, compactNameLimit);
  const total = Math.max(allNames.length, compactCount(value.missingVariableCount));
  if (names.length > 0) out.missingVariableNames = names;
  if (total === 0) return;
  out.missingVariableCount = total;
  out.shownMissingVariableCount = names.length;
  out.omittedMissingVariableCount = Math.max(0, total - names.length);
}

function addDiagnosticCounts(
  out: CompactDiagnosticDetailsV1,
  value: Record<string, unknown>,
): void {
  if (value.candidateCount !== undefined)
    out.candidateCount = compactCount(value.candidateCount);
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

function compactDiagnosticRemediation(code: string): string | undefined {
  if (code === 'schema_upgrade_required' || code === 'reindex_required')
    return compactRemediationHint('reindex_and_link');
  if (code === 'trace_runtime_variables_missing')
    return compactRemediationHint('provide_runtime_variables');
  if (code === 'implementation_hint_mismatch')
    return compactRemediationHint('select_implementation');
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
  if (code === 'select_implementation') return 'Select one implementation with a scoped implementation hint.';
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

function safeVariableNames(values: string[] | undefined): string[] {
  return compactSortedUnique((values ?? [])
    .filter((value) => /^[A-Za-z_$][\w$]*$/.test(value)));
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

function compactArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function compactSortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareBinary);
}
