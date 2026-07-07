import type { Db } from '../db/connection.js';
import { extractPlaceholders } from '../linker/dynamic-edge-resolver.js';
import type { OperationTarget } from '../linker/service-resolver.js';
import type { DynamicMode } from '../types.js';

export interface DynamicTargetCandidate {
  candidateOperationId: number;
  repoName: string;
  packageName?: string;
  servicePath: string;
  operationPath: string;
  operationName: string;
  derivedVariables: Record<string, string>;
  derivedVariableSources: Record<string, Record<string, unknown>>;
  missingVariables: string[];
  score: number;
  reasons: string[];
  rejectedReasons: string[];
  cli?: string;
}

export interface DynamicTargetAnalysis {
  mode: DynamicMode;
  candidateCount: number;
  shownCandidateCount: number;
  omittedCandidateCount: number;
  missingVariables: string[];
  candidates: DynamicTargetCandidate[];
  shownCandidates: DynamicTargetCandidate[];
  suggestedVarSets: Array<{ variables: Record<string, string>; cli: string }>;
  inference: Record<string, unknown>;
}

interface ReferenceRow {
  alias?: string;
  destination?: string;
  servicePath?: string;
  sourceKind: string;
  repoName: string;
}

interface Templates {
  servicePath?: string;
  operationPath?: string;
  alias?: string;
  destination?: string;
}

export function analyzeDynamicTargetCandidates(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
  mode: DynamicMode,
  maxCandidates: number,
): DynamicTargetAnalysis | undefined {
  const templates = templatesFromEvidence(evidence);
  const missingVariables = allMissingVariables(evidence, templates);
  if (missingVariables.length === 0) return undefined;
  const order = variableOrder(templates, missingVariables);
  const candidates = rankedCandidates(
    db,
    candidateTargets(db, evidence, workspaceId),
    referenceRows(db, workspaceId),
    templates,
    order,
  );
  const inference = inferenceDecision(candidates);
  const shownCandidates = candidates.slice(0, maxCandidates);
  return {
    mode,
    candidateCount: candidates.length,
    shownCandidateCount: shownCandidates.length,
    omittedCandidateCount: Math.max(0, candidates.length - shownCandidates.length),
    missingVariables,
    candidates,
    shownCandidates,
    suggestedVarSets: suggestedVarSets(candidates, missingVariables, order),
    inference,
  };
}

function candidateTargets(
  db: Db,
  evidence: Record<string, unknown>,
  workspaceId: number | undefined,
): OperationTarget[] {
  const embedded = rowsFromEvidence(evidence.candidates);
  if (embedded.length > 0) return embedded;
  const operationPath = stringValue(evidence.operationPath);
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
      repoName,
      serviceName: stringValue(row.serviceName) ?? '',
      qualifiedName: stringValue(row.qualifiedName) ?? '',
      servicePath,
      operationPath,
      operationName,
      sourceFile: stringValue(row.sourceFile) ?? '',
      sourceLine: numberValue(row.sourceLine) ?? 0,
      repoId: numberValue(row.repoId),
      packageName: stringValue(row.packageName),
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
      o.source_line sourceLine
     FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
     JOIN repositories r ON r.id=s.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
       AND (o.operation_path IN (?,?) OR o.operation_name=?)
     ORDER BY r.name,s.service_path,o.operation_name`,
  ).all(workspaceId, workspaceId, operationPath, `/${simple}`, simple) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    operationId: Number(row.operationId),
    repoId: numberValue(row.repoId),
    repoName: String(row.repoName),
    packageName: stringValue(row.packageName),
    serviceName: String(row.serviceName),
    qualifiedName: String(row.qualifiedName),
    servicePath: String(row.servicePath),
    operationPath: String(row.operationPath),
    operationName: String(row.operationName),
    sourceFile: String(row.sourceFile),
    sourceLine: Number(row.sourceLine),
    score: 0.2,
    reasons: ['operation_path_match'],
  }));
}

function rankedCandidates(
  db: Db,
  candidates: OperationTarget[],
  references: ReferenceRow[],
  templates: Templates,
  order: string[],
): DynamicTargetCandidate[] {
  const ranked = candidates.map((candidate) =>
    candidateEvidence(db, candidate, references, templates, order));
  return ranked.sort((a, b) =>
    b.score - a.score
    || a.repoName.localeCompare(b.repoName)
    || a.servicePath.localeCompare(b.servicePath));
}

function candidateEvidence(
  db: Db,
  candidate: OperationTarget,
  references: ReferenceRow[],
  templates: Templates,
  order: string[],
): DynamicTargetCandidate {
  const state = emptyCandidate(candidate);
  applyDirectTemplate(state, templates.operationPath, candidate.operationPath, 'operation_path');
  applyDirectTemplate(state, templates.servicePath, candidate.servicePath, 'service_path');
  const refs = references.filter((item) => item.servicePath === candidate.servicePath);
  applyReferenceTemplate(state, templates.alias, refs, 'alias');
  applyReferenceTemplate(state, templates.destination, refs, 'destination');
  if (hasResolvedImplementation(db, candidate.operationId)) addScore(state, 0.1, 'implementation_edge_resolved');
  state.missingVariables = order.filter((key) => state.derivedVariables[key] === undefined);
  if (state.missingVariables.length === 0) addScore(state, 0.15, 'all_runtime_variables_derived');
  else state.rejectedReasons.push('missing_required_runtime_variable');
  state.score = Math.max(0, Math.min(1, state.score));
  state.cli = state.missingVariables.length === 0 ? cliFor(state.derivedVariables, order) : undefined;
  return state;
}

function emptyCandidate(candidate: OperationTarget): DynamicTargetCandidate {
  return {
    candidateOperationId: candidate.operationId,
    repoName: candidate.repoName,
    packageName: candidate.packageName ?? undefined,
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    operationName: candidate.operationName,
    derivedVariables: {},
    derivedVariableSources: {},
    missingVariables: [],
    score: Math.max(0.2, Number(candidate.score ?? 0)),
    reasons: nonEmptyStrings(candidate.reasons, ['operation_path_match']),
    rejectedReasons: [],
  };
}

function applyDirectTemplate(
  state: DynamicTargetCandidate,
  template: string | undefined,
  concrete: string,
  kind: 'operation_path' | 'service_path',
): void {
  const matched = matchTemplate(template, concrete);
  if (!template) return;
  if (!matched) {
    state.rejectedReasons.push(`${kind}_template_mismatch`);
    return;
  }
  mergeDerived(state, matched, `${kind}_template`);
  addScore(state, kind === 'service_path' ? 0.35 : 0.25, `${kind}_template_match`);
}

function applyReferenceTemplate(
  state: DynamicTargetCandidate,
  template: string | undefined,
  refs: ReferenceRow[],
  kind: 'alias' | 'destination',
): void {
  if (!template || extractPlaceholders(template).length === 0) return;
  for (const ref of refs) {
    const concrete = kind === 'alias' ? ref.alias : ref.destination;
    const matched = isConcrete(concrete) ? matchTemplate(template, concrete) : undefined;
    if (!matched) continue;
    mergeDerived(state, matched, `${ref.sourceKind}.${kind}`);
    addScore(state, 0.2, `${kind}_template_match`);
    return;
  }
  if (refs.some((ref) => isConcrete(kind === 'alias' ? ref.alias : ref.destination)))
    state.rejectedReasons.push(`${kind}_template_mismatch`);
}

function inferenceDecision(candidates: DynamicTargetCandidate[]): Record<string, unknown> {
  const complete = candidates.filter((candidate) =>
    candidate.missingVariables.length === 0
    && candidate.rejectedReasons.length === 0);
  const first = complete[0];
  const second = complete[1];
  if (!first) return { status: 'unresolved', reason: 'missing_required_runtime_variable' };
  if (first.score < 0.85) return { status: 'unresolved', reason: 'candidate_score_below_inference_threshold' };
  if (second && first.score - second.score <= 0.05) {
    for (const candidate of complete.filter((item) => first.score - item.score <= 0.05))
      candidate.rejectedReasons.push('candidate_tied_with_equal_score');
    return { status: 'ambiguous', reason: 'candidate_tied_with_equal_score' };
  }
  return {
    status: 'resolved',
    candidateOperationId: first.candidateOperationId,
    inferredVariables: first.derivedVariables,
    score: first.score,
    reasons: first.reasons,
  };
}

function suggestedVarSets(
  candidates: DynamicTargetCandidate[],
  required: string[],
  order: string[],
): Array<{ variables: Record<string, string>; cli: string }> {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (required.some((key) => candidate.derivedVariables[key] === undefined)) return [];
    const cli = cliFor(candidate.derivedVariables, order);
    if (seen.has(cli)) return [];
    seen.add(cli);
    return [{ variables: candidate.derivedVariables, cli }];
  });
}

function referenceRows(db: Db, workspaceId: number | undefined): ReferenceRow[] {
  const rows = db.prepare(
    `SELECT req.alias alias,req.destination destination,req.service_path servicePath,
      'cds_require' sourceKind,r.name repoName
     FROM cds_requires req JOIN repositories r ON r.id=req.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
     UNION ALL
     SELECT COALESCE(b.alias,b.alias_expr) alias,b.destination_expr destination,
      b.service_path_expr servicePath,'service_binding' sourceKind,r.name repoName
     FROM service_bindings b JOIN repositories r ON r.id=b.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)`,
  ).all(workspaceId, workspaceId, workspaceId, workspaceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    alias: stringValue(row.alias),
    destination: stringValue(row.destination),
    servicePath: stringValue(row.servicePath),
    sourceKind: String(row.sourceKind),
    repoName: String(row.repoName),
  }));
}

function allMissingVariables(evidence: Record<string, unknown>, templates: Templates): string[] {
  const fromSubstitutions = Object.values(record(evidence.runtimeSubstitutions))
    .flatMap((value) => stringArray(record(value).missing));
  const fromTemplates = [
    templates.servicePath,
    templates.operationPath,
    templates.alias,
    templates.destination,
  ].flatMap((value) => extractPlaceholders(value));
  return [...new Set([...fromSubstitutions, ...fromTemplates])].sort();
}

function variableOrder(templates: Templates, missingVariables: string[]): string[] {
  const ordered = [
    templates.servicePath,
    templates.operationPath,
    templates.alias,
    templates.destination,
  ].flatMap((value) => extractPlaceholders(value));
  return [...new Set([...ordered, ...missingVariables])];
}

function templatesFromEvidence(evidence: Record<string, unknown>): Templates {
  return {
    servicePath: stringValue(evidence.servicePath),
    operationPath: stringValue(evidence.operationPath),
    alias: stringValue(evidence.serviceAliasExpr ?? evidence.serviceAlias),
    destination: stringValue(evidence.destination),
  };
}

function matchTemplate(template: string | undefined, concrete: string | undefined): Record<string, string> | undefined {
  if (!template || !concrete) return undefined;
  const keys = extractPlaceholders(template);
  if (keys.length === 0) return template === concrete ? {} : undefined;
  const regex = new RegExp(`^${templateToPattern(template)}$`);
  const match = regex.exec(concrete);
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

function mergeDerived(
  state: DynamicTargetCandidate,
  values: Record<string, string>,
  sourceKind: string,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (state.derivedVariables[key] !== undefined && state.derivedVariables[key] !== value) {
      state.rejectedReasons.push('template_variable_conflict');
      continue;
    }
    state.derivedVariables[key] = value;
    state.derivedVariableSources[key] = { sourceKind, value };
  }
}

function addScore(state: DynamicTargetCandidate, amount: number, reason: string): void {
  state.score += amount;
  if (!state.reasons.includes(reason)) state.reasons.push(reason);
}

function hasResolvedImplementation(db: Db, operationId: number): boolean {
  const row = db.prepare(
    "SELECT 1 FROM graph_edges WHERE edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND status='resolved' AND from_kind='operation' AND from_id=? LIMIT 1",
  ).get(String(operationId));
  return Boolean(row);
}

function cliFor(variables: Record<string, string>, order: string[]): string {
  return order
    .filter((key) => variables[key] !== undefined)
    .map((key) => `--var ${key}=${variables[key]}`)
    .join(' ');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const values = stringArray(value).filter((item) => item.length > 0);
  return values.length > 0 ? values : fallback;
}

function isConcrete(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && extractPlaceholders(value).length === 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
