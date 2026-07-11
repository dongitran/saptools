import type { Db } from '../db/connection.js';
import {
  applyVariables,
  extractPlaceholders,
  matchRuntimeTemplate,
} from '../linker/dynamic-edge-resolver.js';
import { normalizeODataOperationInvocationPath } from '../linker/odata-path-normalizer.js';
import type { OperationTarget } from '../linker/service-resolver.js';
import type { DynamicMode } from '../types.js';
import { dynamicCandidateTargets } from './004-dynamic-candidate-sources.js';
import { projectBounded } from '../utils/000-bounded-projection.js';
import { uniqueIdentityDerivations } from './001-dynamic-identity.js';
import {
  dynamicReferenceProvenance,
  dynamicRoutingContext,
  type DynamicReferenceRow,
  type DynamicRoutingContext,
} from './003-dynamic-references.js';
import type {
  DynamicTargetAnalysis,
  DynamicTargetCandidate,
  DynamicTemplates,
  DynamicVariableProvenance,
} from './000-dynamic-target-types.js';
export type {
  DynamicTargetAnalysis,
  DynamicTargetCandidate,
} from './000-dynamic-target-types.js';
type Templates = DynamicTemplates;
type VariableProvenance = DynamicVariableProvenance;
interface AnalysisInputs {
  original: Templates;
  effective: Templates;
  required: string[];
  requiredSources: Record<string, string[]>;
  supplied: Record<string, string>;
  order: string[];
  callerRepo?: string;
  callerRepoId?: number;
  routing: DynamicRoutingContext;
}

export function analyzeDynamicTargetCandidates(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
  mode: DynamicMode,
  maxCandidates: number,
): DynamicTargetAnalysis | undefined {
  const inputs = analysisInputs(db, evidence, workspaceId);
  if (inputs.required.length === 0) return undefined;
  const targets = dynamicCandidateTargets(
    db,
    inputs.effective.operationPath,
    inputs.original.operationPath,
    evidence.candidates,
    workspaceId,
    inputs.routing.outboundCallId !== undefined,
  );
  const candidates = buildCandidates(db, targets, inputs.routing.references, inputs);
  applyUniqueIdentityEvidence(db, candidates, inputs);
  finalizeCandidates(candidates, inputs.order);
  const ranked = stableRank(candidates);
  const inference = inferenceDecision(ranked);
  applyModeState(ranked, mode, inference);
  const viable = ranked.filter((candidate) => candidate.viable);
  const rejected = ranked.filter((candidate) => candidate.rejected);
  const shown = viable.slice(0, maxCandidates)
    .map((candidate) => boundedCandidate(candidate, maxCandidates));
  const shownRejected = rejected.slice(0, maxCandidates)
    .map((candidate) => boundedCandidate(candidate, maxCandidates));
  const suggestionProjection = suggestedVarSets(viable, inputs.order, maxCandidates);
  return {
    mode,
    maxCandidates,
    candidateCount: ranked.length,
    viableCandidateCount: viable.length,
    rejectedCandidateCount: rejected.length,
    shownCandidateCount: shown.length,
    omittedCandidateCount: Math.max(0, viable.length - shown.length),
    shownRejectedCandidateCount: shownRejected.length,
    omittedRejectedCandidateCount: Math.max(0, rejected.length - shownRejected.length),
    missingVariables: inputs.required.filter((key) => inputs.supplied[key] === undefined),
    requiredVariables: inputs.required,
    suppliedVariables: inputs.supplied,
    appliedSuppliedVariables: requiredSuppliedVariables(inputs),
    substitutedSignals: inputs.effective,
    candidates: shown,
    shownCandidates: shown,
    rejectedCandidates: shownRejected,
    suggestedVarSets: suggestionProjection.items,
    suggestedVarSetCount: suggestionProjection.totalCount,
    shownSuggestedVarSetCount: suggestionProjection.shownCount,
    omittedSuggestedVarSetCount: suggestionProjection.omittedCount,
    inference,
    routingContext: routingEvidence(inputs.routing),
  };
}

function analysisInputs(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
): AnalysisInputs {
  const routing = dynamicRoutingContext(db, workspaceId, evidence);
  const supplied = stringRecord(evidence.suppliedRuntimeVariables);
  const original = templatesFromEvidence(evidence, routing);
  const effective = effectiveTemplates(original, supplied);
  const requiredSources = placeholderSources(original);
  const required = Object.keys(requiredSources);
  return {
    original,
    effective,
    required,
    requiredSources,
    supplied,
    order: variableOrder(original, required),
    callerRepo: routing.callerRepo ?? stringValue(evidence.repo),
    callerRepoId: routing.callerRepoId ?? numberValue(evidence.repoId),
    routing,
  };
}

function buildCandidates(
  db: Db,
  targets: OperationTarget[],
  references: DynamicReferenceRow[],
  inputs: AnalysisInputs,
): DynamicTargetCandidate[] {
  return targets.map((target) => {
    const state = emptyCandidate(target, inputs);
    applyDirectSignal(state, inputs, 'operationPath', target.operationPath, 0.25);
    applyDirectSignal(state, inputs, 'servicePath', target.servicePath, 0.35);
    const matchingReferences = references.filter((reference) =>
      referenceMatchesCandidate(reference, target.servicePath)
      && referenceMatchesSelectedAlias(reference, inputs.routing.selectedBinding));
    const referencesForSignals = fallbackReferencesForCandidate(
      state, matchingReferences, inputs.routing.fallbackUsed,
    );
    applyReferenceSignal(state, inputs, referencesForSignals, 'alias');
    applyReferenceSignal(state, inputs, referencesForSignals, 'destination');
    if (hasResolvedImplementation(db, target.operationId))
      addScore(state, 0.1, 'implementation_edge_resolved');
    return state;
  });
}

function fallbackReferencesForCandidate(
  state: DynamicTargetCandidate,
  references: DynamicReferenceRow[],
  fallbackUsed: boolean,
): DynamicReferenceRow[] {
  if (!fallbackUsed) return references;
  const unique = uniqueFallbackReferences(references);
  if (unique.length <= 1) return unique;
  addReason(state, 'fallback_reference_ambiguous');
  addInferenceBlock(state, 'fallback_reference_ambiguous');
  return [];
}

function uniqueFallbackReferences(
  references: DynamicReferenceRow[],
): DynamicReferenceRow[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const signature = [
      reference.sourceKind,
      reference.alias,
      reference.destination,
      reference.servicePath,
    ].join('\0');
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function emptyCandidate(
  target: OperationTarget,
  inputs: AnalysisInputs,
): DynamicTargetCandidate {
  return {
    candidateOperationId: target.operationId,
    repoId: target.repoId,
    repoName: target.repoName,
    packageName: target.packageName ?? undefined,
    serviceName: target.serviceName,
    qualifiedName: target.qualifiedName,
    servicePath: target.servicePath,
    operationPath: target.operationPath,
    operationName: target.operationName,
    sourceFile: target.sourceFile,
    sourceLine: target.sourceLine,
    originalTemplates: inputs.original,
    effectiveValues: inputs.effective,
    requiredVariables: inputs.required,
    requiredVariableSources: inputs.requiredSources,
    suppliedVariables: inputs.supplied,
    completeVariables: { ...inputs.supplied },
    derivedVariables: {},
    derivedVariableSources: {},
    derivationProvenance: {},
    missingVariables: [],
    conflicts: [],
    score: Math.max(0.2, Number(target.score ?? 0)),
    explicitSignalStrength: 0,
    reasons: nonEmptyStrings(target.reasons, ['operation_path_match']),
    rejectedReasons: [],
    inferenceBlockReasons: [],
    viable: true,
    rejected: false,
    selected: false,
    exploratory: false,
  };
}

function applyDirectSignal(
  state: DynamicTargetCandidate,
  inputs: AnalysisInputs,
  kind: 'servicePath' | 'operationPath',
  concrete: string,
  score: number,
): void {
  const effective = inputs.effective[kind];
  const original = inputs.original[kind];
  if (effective && !matchRuntimeTemplate(effective, concrete)) {
    reject(state, `${signalCode(kind)}_contradicts_runtime_substitution`);
    return;
  }
  if (!effective) return;
  const suppliedKeys = extractPlaceholders(original)
    .filter((key) => inputs.supplied[key] !== undefined);
  state.explicitSignalStrength += suppliedKeys.length;
  const matched = matchRuntimeTemplate(original, concrete) ?? {};
  const fromSelectedBinding = kind === 'servicePath'
    && inputs.routing.selectedBinding !== undefined;
  for (const [key, value] of Object.entries(matched)) {
    addDerivation(state, key, value, {
      sourceKind: fromSelectedBinding
        ? `selected_binding.${signalCode(kind)}_template`
        : `${signalCode(kind)}_template`,
      value,
      rule: fromSelectedBinding
        ? 'exact_selected_binding_template_match'
        : 'exact_template_match',
      template: original,
      sourceRepo: fromSelectedBinding ? inputs.routing.selectedBinding?.repoName : undefined,
      sourceFile: fromSelectedBinding ? inputs.routing.selectedBinding?.sourceFile : undefined,
      sourceLine: fromSelectedBinding ? inputs.routing.selectedBinding?.sourceLine : undefined,
      selection: fromSelectedBinding ? 'selected_binding' : 'call_evidence',
    });
  }
  addScore(state, score, `${signalCode(kind)}_template_match`);
}

function applyReferenceSignal(
  state: DynamicTargetCandidate,
  inputs: AnalysisInputs,
  references: DynamicReferenceRow[],
  kind: 'alias' | 'destination',
): void {
  const original = inputs.original[kind];
  const effective = inputs.effective[kind];
  if (!original || extractPlaceholders(original).length === 0) return;
  const values = references.flatMap((reference) => {
    const concrete = kind === 'alias' ? reference.alias : reference.destination;
    return isConcrete(concrete) ? [{ reference, concrete }] : [];
  });
  if (effective && extractPlaceholders(effective).length === 0
    && values.length > 0 && !values.some(({ concrete }) => concrete === effective)) {
    reject(state, `${kind}_contradicts_runtime_substitution`);
  }
  let matchedSignal = false;
  for (const { reference, concrete } of values) {
    const matched = matchRuntimeTemplate(original, concrete);
    if (!matched) continue;
    matchedSignal = true;
    for (const [key, value] of Object.entries(matched)) {
      addDerivation(
        state, key, value,
        dynamicReferenceProvenance(reference, kind, original, value),
      );
    }
  }
  if (matchedSignal) {
    state.explicitSignalStrength += extractPlaceholders(original)
      .filter((key) => inputs.supplied[key] !== undefined).length;
    addScore(state, 0.2, `${kind}_template_match`);
  }
}

function applyUniqueIdentityEvidence(
  db: Db,
  candidates: DynamicTargetCandidate[],
  inputs: AnalysisInputs,
): void {
  for (const derivation of uniqueIdentityDerivations(db, candidates, inputs.original)) {
    const candidate = candidates.find((item) =>
      item.candidateOperationId === derivation.operationId);
    if (!candidate) continue;
    addDerivation(candidate, derivation.key, derivation.value, derivation.provenance);
    addScore(candidate, 0.2, 'exact_identity_template_match');
  }
}

function addDerivation(
  state: DynamicTargetCandidate,
  key: string,
  value: string,
  provenance: VariableProvenance,
): void {
  const priorProvenance = state.derivationProvenance[key] ?? [];
  state.derivationProvenance[key] = uniqueProvenance([...priorProvenance, provenance]);
  const supplied = state.suppliedVariables[key];
  if (supplied !== undefined && supplied !== value) {
    addConflict(state, key, [supplied, value], 'explicit_value_conflicts_with_derived_value');
    return;
  }
  const prior = state.derivedVariables[key];
  if (prior !== undefined && prior !== value) {
    addConflict(state, key, [prior, value], 'conflicting_strong_derivations');
    return;
  }
  if (supplied === undefined) state.derivedVariables[key] = value;
  state.completeVariables[key] = supplied ?? value;
  state.derivedVariableSources[key] ??= provenance;
}

function addConflict(
  state: DynamicTargetCandidate,
  key: string,
  values: string[],
  reason: string,
): void {
  const sources = (state.derivationProvenance[key] ?? [])
    .map((item) => item.sourceKind).sort();
  state.conflicts.push({ key, values: [...new Set(values)].sort(), reason, sources });
  reject(state, reason);
}

function uniqueProvenance(rows: VariableProvenance[]): VariableProvenance[] {
  const sorted = [...rows].sort((left, right) =>
    left.sourceKind.localeCompare(right.sourceKind)
    || String(left.matchedName ?? '').localeCompare(String(right.matchedName ?? ''))
    || left.value.localeCompare(right.value));
  const seen = new Set<string>();
  return sorted.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeCandidates(candidates: DynamicTargetCandidate[], order: string[]): void {
  for (const candidate of candidates) {
    candidate.missingVariables = order.filter((key) =>
      candidate.completeVariables[key] === undefined);
    candidate.viable = candidate.rejectedReasons.length === 0;
    candidate.rejected = !candidate.viable;
    if (candidate.missingVariables.length === 0 && candidate.viable)
      addScore(candidate, 0.15, 'all_runtime_variables_derived');
    else if (candidate.missingVariables.length > 0)
      addReason(candidate, 'missing_required_runtime_variable');
    candidate.score = Math.max(0, Math.min(1, candidate.score));
    candidate.cli = candidate.missingVariables.length === 0 && candidate.viable
      ? cliFor(candidate.completeVariables, order)
      : undefined;
  }
}

function stableRank(candidates: DynamicTargetCandidate[]): DynamicTargetCandidate[] {
  return [...candidates].sort((left, right) =>
    Number(right.viable) - Number(left.viable)
    || right.score - left.score
    || right.explicitSignalStrength - left.explicitSignalStrength
    || left.repoName.localeCompare(right.repoName)
    || String(left.packageName ?? '').localeCompare(String(right.packageName ?? ''))
    || left.servicePath.localeCompare(right.servicePath)
    || left.operationPath.localeCompare(right.operationPath)
    || left.operationName.localeCompare(right.operationName)
    || left.candidateOperationId - right.candidateOperationId);
}

function inferenceDecision(candidates: DynamicTargetCandidate[]): Record<string, unknown> {
  const viable = candidates.filter((candidate) => candidate.viable);
  const first = viable[0];
  const second = viable[1];
  if (!first || first.missingVariables.length > 0)
    return { status: 'unresolved', reason: 'missing_required_runtime_variable' };
  if (first.inferenceBlockReasons.length > 0)
    return { status: 'unresolved', reason: first.inferenceBlockReasons[0] };
  if (first.score < 0.85)
    return { status: 'unresolved', reason: 'candidate_score_below_inference_threshold' };
  const scoreGap = second
    ? Number((first.score - second.score).toFixed(12))
    : undefined;
  if (second && scoreGap !== undefined && scoreGap <= 0.05) {
    const reason = scoreGap === 0
      ? 'candidate_tied_with_equal_score'
      : 'candidate_within_inference_margin';
    for (const candidate of viable.filter((item) => first.score - item.score <= 0.05))
      addInferenceBlock(candidate, reason);
    return { status: 'ambiguous', reason, scoreGap, requiredMargin: 0.05 };
  }
  return {
    status: 'resolved',
    candidateOperationId: first.candidateOperationId,
    inferredVariables: first.completeVariables,
    score: first.score,
    reasons: first.reasons,
  };
}

function boundedCandidate(
  candidate: DynamicTargetCandidate,
  limit: number,
): DynamicTargetCandidate {
  const provenanceProjections = Object.fromEntries(
    Object.entries(candidate.derivationProvenance)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, projectBounded(rows, compareProvenance, limit)]),
  );
  const derivationProvenance = Object.fromEntries(Object.entries(provenanceProjections)
    .map(([key, projection]) => [key, projection.items]));
  const derivationProvenanceCounts = Object.fromEntries(Object.entries(provenanceProjections)
    .map(([key, projection]) => [key, {
      provenanceCount: projection.totalCount,
      shownProvenanceCount: projection.shownCount,
      omittedProvenanceCount: projection.omittedCount,
    }]));
  const conflicts = projectBounded(candidate.conflicts, compareConflict, limit);
  return {
    ...candidate,
    derivationProvenance,
    derivationProvenanceCounts,
    conflicts: conflicts.items.map(boundedConflict),
    conflictCount: conflicts.totalCount,
    shownConflictCount: conflicts.shownCount,
    omittedConflictCount: conflicts.omittedCount,
  };
}

function compareProvenance(
  left: DynamicVariableProvenance,
  right: DynamicVariableProvenance,
): number {
  return left.sourceKind.localeCompare(right.sourceKind)
    || String(left.matchedName ?? '').localeCompare(String(right.matchedName ?? ''))
    || left.value.localeCompare(right.value);
}

function compareConflict(
  left: DynamicTargetCandidate['conflicts'][number],
  right: DynamicTargetCandidate['conflicts'][number],
): number {
  return left.key.localeCompare(right.key)
    || left.reason.localeCompare(right.reason)
    || left.values.join('\0').localeCompare(right.values.join('\0'));
}

function boundedConflict(
  conflict: DynamicTargetCandidate['conflicts'][number],
): DynamicTargetCandidate['conflicts'][number] & Record<string, unknown> {
  const sources = projectBounded(conflict.sources, (left, right) =>
    left.localeCompare(right));
  return {
    ...conflict,
    sources: sources.items,
    sourceCount: sources.totalCount,
    shownSourceCount: sources.shownCount,
    omittedSourceCount: sources.omittedCount,
  };
}

function applyModeState(
  candidates: DynamicTargetCandidate[],
  mode: DynamicMode,
  inference: Record<string, unknown>,
): void {
  const selectedId = mode === 'infer' && inference.status === 'resolved'
    ? numberValue(inference.candidateOperationId)
    : undefined;
  for (const candidate of candidates) {
    candidate.selected = selectedId === candidate.candidateOperationId;
    candidate.exploratory = mode === 'candidates' && candidate.viable;
  }
}

function suggestedVarSets(
  candidates: DynamicTargetCandidate[],
  order: string[],
  limit: number,
): ReturnType<typeof projectBounded<{ variables: Record<string, string>; cli: string }>> {
  const seen = new Set<string>();
  const rows: Array<{ variables: Record<string, string>; cli: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.cli || candidate.missingVariables.length > 0) continue;
    if (seen.has(candidate.cli)) continue;
    seen.add(candidate.cli);
    rows.push({ variables: orderedVariables(candidate.completeVariables, order), cli: candidate.cli });
  }
  return projectBounded(rows, (left, right) => left.cli.localeCompare(right.cli), limit);
}

function hasResolvedImplementation(db: Db, operationId: number): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status='resolved' AND from_kind='operation' AND from_id=? LIMIT 1",
  ).get(String(operationId)));
}
function templatesFromEvidence(
  evidence: Record<string, unknown>,
  routing: DynamicRoutingContext,
): Templates {
  const selected = routing.selectedBinding;
  return {
    servicePath: selected?.servicePath ?? substitutionSignal(evidence, 'servicePath', 'original'),
    operationPath: substitutionSignal(evidence, 'operationPath', 'original'),
    alias: selected?.aliasExpr ?? selected?.alias ?? substitutionSignal(evidence,
      evidence.serviceAliasExpr !== undefined ? 'serviceAliasExpr' : 'serviceAlias', 'original'),
    destination: selected?.destination ?? substitutionSignal(evidence, 'destination', 'original'),
  };
}
function effectiveTemplates(
  templates: Templates,
  supplied: Record<string, string>,
): Templates {
  const operationPath = applyVariables(templates.operationPath, supplied);
  return {
    servicePath: applyVariables(templates.servicePath, supplied),
    operationPath: normalizeODataOperationInvocationPath(operationPath)?.normalizedOperationPath
      ?? operationPath,
    alias: applyVariables(templates.alias, supplied),
    destination: applyVariables(templates.destination, supplied),
  };
}

function substitutionSignal(
  evidence: Record<string, unknown>,
  key: string,
  phase: 'original' | 'effective',
): string | undefined {
  const substitution = record(record(evidence.runtimeSubstitutions)[key]);
  return stringValue(substitution[phase]) ?? stringValue(evidence[key]);
}

function placeholderSources(templates: Templates): Record<string, string[]> {
  const sources: Record<string, string[]> = {};
  for (const [kind, template] of Object.entries(templates)) {
    if (typeof template !== 'string') continue;
    for (const key of extractPlaceholders(template))
      sources[key] = [...new Set([...(sources[key] ?? []), `${kind}:${template}`])].sort();
  }
  return Object.fromEntries(Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function variableOrder(templates: Templates, required: string[]): string[] {
  const ordered = [
    templates.servicePath,
    templates.operationPath,
    templates.alias,
    templates.destination,
  ].flatMap((value) => extractPlaceholders(value));
  return [...new Set([...ordered, ...required])];
}

function referenceMatchesCandidate(
  reference: DynamicReferenceRow,
  servicePath: string,
): boolean {
  return matchRuntimeTemplate(reference.servicePath, servicePath) !== undefined;
}

function referenceMatchesSelectedAlias(
  reference: DynamicReferenceRow,
  selected: DynamicRoutingContext['selectedBinding'],
): boolean {
  if (reference.selection !== 'selected_binding_require') return true;
  const template = selected?.aliasExpr ?? selected?.alias;
  return matchRuntimeTemplate(template, reference.alias) !== undefined;
}

function cliFor(variables: Record<string, string>, order: string[]): string {
  return order.filter((key) => variables[key] !== undefined)
    .map((key) => `--var ${shellArgument(`${key}=${variables[key]}`)}`).join(' ');
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function orderedVariables(
  variables: Record<string, string>,
  order: string[],
): Record<string, string> {
  return Object.fromEntries(order.flatMap((key) =>
    variables[key] === undefined ? [] : [[key, variables[key]]]));
}

function addScore(state: DynamicTargetCandidate, amount: number, reason: string): void {
  state.score += amount;
  addReason(state, reason);
}

function addReason(state: DynamicTargetCandidate, reason: string): void {
  if (!state.reasons.includes(reason)) state.reasons.push(reason);
}

function reject(state: DynamicTargetCandidate, reason: string): void {
  rejectReasonOnly(state, reason);
  state.viable = false;
  state.rejected = true;
}

function rejectReasonOnly(state: DynamicTargetCandidate, reason: string): void {
  if (!state.rejectedReasons.includes(reason)) state.rejectedReasons.push(reason);
}

function addInferenceBlock(state: DynamicTargetCandidate, reason: string): void {
  addReason(state, reason);
  if (!state.inferenceBlockReasons.includes(reason))
    state.inferenceBlockReasons.push(reason);
}

function requiredSuppliedVariables(inputs: AnalysisInputs): Record<string, string> {
  return Object.fromEntries(inputs.required.flatMap((key) =>
    inputs.supplied[key] === undefined ? [] : [[key, inputs.supplied[key]]]));
}

function routingEvidence(routing: DynamicRoutingContext): Record<string, unknown> {
  const binding = routing.selectedBinding;
  return {
    outboundCallId: routing.outboundCallId,
    callerRepoId: routing.callerRepoId,
    callerRepo: routing.callerRepo,
    selectedBindingId: routing.selectedBindingId,
    bindingResolutionStatus: routing.bindingResolutionStatus,
    selectedBinding: binding ? {
      bindingId: binding.bindingId,
      alias: binding.alias,
      aliasExpr: binding.aliasExpr,
      destination: binding.destination,
      destinationExpr: binding.destination,
      servicePath: binding.servicePath,
      servicePathExpr: binding.servicePath,
      sourceFile: binding.sourceFile,
      sourceLine: binding.sourceLine,
      helperChain: binding.helperChain,
    } : undefined,
    bindingAlternativeCount: routing.bindingAlternativeCount,
    shownBindingAlternativeCount: routing.shownBindingAlternativeCount,
    omittedBindingAlternativeCount: routing.omittedBindingAlternativeCount,
    bindingAlternatives: routing.bindingAlternatives,
    fallbackUsed: routing.fallbackUsed,
  };
}

function signalCode(kind: 'servicePath' | 'operationPath'): string {
  return kind === 'servicePath' ? 'service_path' : 'operation_path';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const entries = Object.entries(record(value))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const values = stringArray(value).filter((item) => item.length > 0);
  return values.length > 0 ? values : fallback;
}

function isConcrete(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && extractPlaceholders(value).length === 0;
}
