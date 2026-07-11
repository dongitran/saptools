import type { Db } from '../db/connection.js';
import { extractPlaceholders } from '../linker/dynamic-edge-resolver.js';
import type { OperationTarget } from '../linker/service-resolver.js';
import type { DynamicMode } from '../types.js';
import { uniqueIdentityDerivations } from './001-dynamic-identity.js';
import {
  dynamicReferenceProvenance,
  dynamicReferenceRows,
  type DynamicReferenceRow,
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
}

export function analyzeDynamicTargetCandidates(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
  mode: DynamicMode,
  maxCandidates: number,
): DynamicTargetAnalysis | undefined {
  const inputs = analysisInputs(evidence);
  if (inputs.required.length === 0) return undefined;
  const targets = candidateTargets(db, evidence, workspaceId);
  const references = dynamicReferenceRows(
    db, workspaceId, inputs.callerRepoId, inputs.callerRepo,
  );
  const candidates = buildCandidates(db, targets, references, inputs);
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
    suggestedVarSets: suggestedVarSets(viable, inputs.order, maxCandidates),
    inference,
  };
}

function analysisInputs(evidence: Record<string, unknown>): AnalysisInputs {
  const original = templatesFromEvidence(evidence, 'original');
  const effective = templatesFromEvidence(evidence, 'effective');
  const requiredSources = placeholderSources(original);
  const required = Object.keys(requiredSources);
  const supplied = stringRecord(evidence.suppliedRuntimeVariables);
  return {
    original,
    effective,
    required,
    requiredSources,
    supplied,
    order: variableOrder(original, required),
    callerRepo: stringValue(evidence.repo),
    callerRepoId: numberValue(evidence.repoId),
  };
}

function candidateTargets(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
): OperationTarget[] {
  const embedded = rowsFromEvidence(evidence.candidates);
  if (embedded.length > 0) return embedded;
  const operationPath = effectiveSignal(evidence, 'operationPath');
  if (!operationPath || extractPlaceholders(operationPath).length > 0) return [];
  return queryOperationTargets(db, operationPath, workspaceId);
}

function rowsFromEvidence(value: unknown): OperationTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OperationTarget[] => {
    const row = record(item);
    const operationId = numberValue(row.operationId);
    const repoName = stringValue(row.repoName);
    const servicePath = stringValue(row.servicePath);
    const operationPath = stringValue(row.operationPath);
    const operationName = stringValue(row.operationName) ?? operationPath?.replace(/^\//, '');
    if (operationId === undefined || !repoName || !servicePath || !operationPath || !operationName) return [];
    return [{
      operationId,
      repoId: numberValue(row.repoId),
      repoName,
      packageName: stringValue(row.packageName),
      serviceName: stringValue(row.serviceName) ?? '',
      qualifiedName: stringValue(row.qualifiedName) ?? '',
      servicePath,
      operationPath,
      operationName,
      sourceFile: stringValue(row.sourceFile) ?? '',
      sourceLine: numberValue(row.sourceLine) ?? 0,
      score: numberValue(row.score) ?? 0,
      reasons: stringArray(row.reasons),
    }];
  });
}

function queryOperationTargets(
  db: Db,
  operationPath: string,
  workspaceId: number | undefined,
): OperationTarget[] {
  const simple = operationPath.replace(/^\//, '').split('.').at(-1) ?? operationPath;
  const rows = db.prepare(
    `SELECT o.id operationId,r.id repoId,r.name repoName,r.package_name packageName,
      s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,
      o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,
      o.source_line sourceLine FROM cds_operations o
     JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
       AND (o.operation_path IN (?,?) OR o.operation_name=?)
     ORDER BY r.name,s.service_path,o.operation_name,o.id`,
  ).all(workspaceId, workspaceId, operationPath, `/${simple}`, simple);
  return rows.flatMap(operationTargetFromRow);
}

function operationTargetFromRow(row: Record<string, unknown>): OperationTarget[] {
  const operationId = numberValue(row.operationId);
  const repoName = stringValue(row.repoName);
  const servicePath = stringValue(row.servicePath);
  const operationPath = stringValue(row.operationPath);
  const operationName = stringValue(row.operationName);
  if (operationId === undefined || !repoName || !servicePath || !operationPath || !operationName) return [];
  return [{
    operationId,
    repoId: numberValue(row.repoId),
    repoName,
    packageName: stringValue(row.packageName),
    serviceName: stringValue(row.serviceName) ?? '',
    qualifiedName: stringValue(row.qualifiedName) ?? '',
    servicePath,
    operationPath,
    operationName,
    sourceFile: stringValue(row.sourceFile) ?? '',
    sourceLine: numberValue(row.sourceLine) ?? 0,
    score: 0.2,
    reasons: ['operation_path_match'],
  }];
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
      reference.servicePath === target.servicePath);
    applyReferenceSignal(state, inputs, matchingReferences, 'alias');
    applyReferenceSignal(state, inputs, matchingReferences, 'destination');
    if (hasResolvedImplementation(db, target.operationId))
      addScore(state, 0.1, 'implementation_edge_resolved');
    return state;
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
  if (effective && !matchTemplate(effective, concrete)) {
    reject(state, `${signalCode(kind)}_contradicts_runtime_substitution`);
    return;
  }
  if (!effective) return;
  const suppliedKeys = extractPlaceholders(original)
    .filter((key) => inputs.supplied[key] !== undefined);
  state.explicitSignalStrength += suppliedKeys.length;
  const matched = matchTemplate(original, concrete) ?? {};
  for (const [key, value] of Object.entries(matched)) {
    addDerivation(state, key, value, {
      sourceKind: `${signalCode(kind)}_template`,
      value,
      rule: 'exact_template_match',
      template: original,
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
    const matched = matchTemplate(original, concrete);
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
  const derivationProvenance = Object.fromEntries(
    Object.entries(candidate.derivationProvenance)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, rows.slice(0, limit)]),
  );
  const conflicts = candidate.conflicts.slice(0, limit).map((conflict) => ({
    ...conflict,
    sources: conflict.sources.slice(0, limit),
  }));
  return { ...candidate, derivationProvenance, conflicts };
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
): Array<{ variables: Record<string, string>; cli: string }> {
  const seen = new Set<string>();
  const rows: Array<{ variables: Record<string, string>; cli: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.cli || candidate.missingVariables.length > 0) continue;
    if (seen.has(candidate.cli)) continue;
    seen.add(candidate.cli);
    rows.push({ variables: orderedVariables(candidate.completeVariables, order), cli: candidate.cli });
    if (rows.length >= limit) break;
  }
  return rows;
}

function hasResolvedImplementation(db: Db, operationId: number): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status='resolved' AND from_kind='operation' AND from_id=? LIMIT 1",
  ).get(String(operationId)));
}

function templatesFromEvidence(
  evidence: Record<string, unknown>,
  phase: 'original' | 'effective',
): Templates {
  return {
    servicePath: substitutionSignal(evidence, 'servicePath', phase),
    operationPath: substitutionSignal(evidence, 'operationPath', phase),
    alias: substitutionSignal(evidence,
      evidence.serviceAliasExpr !== undefined ? 'serviceAliasExpr' : 'serviceAlias', phase),
    destination: substitutionSignal(evidence, 'destination', phase),
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

function effectiveSignal(evidence: Record<string, unknown>, key: string): string | undefined {
  return substitutionSignal(evidence, key, 'effective');
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

function matchTemplate(
  template: string | undefined,
  concrete: string | undefined,
): Record<string, string> | undefined {
  if (!template || !concrete) return undefined;
  const keys = extractPlaceholders(template);
  if (keys.length === 0) return template === concrete ? {} : undefined;
  const match = new RegExp(`^${templateToPattern(template)}$`).exec(concrete);
  if (!match) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = match[index + 1];
    if (!key || value === undefined) return undefined;
    if (values[key] !== undefined && values[key] !== value) return undefined;
    values[key] = value;
  }
  return values;
}

function templateToPattern(template: string): string {
  let pattern = '';
  let lastIndex = 0;
  for (const match of template.matchAll(/\$\{([^}]*)\}/g)) {
    pattern += escapeRegex(template.slice(lastIndex, match.index));
    pattern += '([^/]+?)';
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  return `${pattern}${escapeRegex(template.slice(lastIndex))}`;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
