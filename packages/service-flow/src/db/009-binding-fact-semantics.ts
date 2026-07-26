import type {
  ServiceBindingReferenceReason,
} from '../types.js';
import { ANALYZER_VERSION } from '../version.js';
import type { Db } from './connection.js';
import {
  bindingReferenceCountsValid,
  resolvedBindingReferenceProofValid,
  validBindingLexicalScope,
  type BindingProofTarget,
} from './012-binding-reference-proof.js';
import {
  hasSingleHopHelperReturn,
} from './014-binding-helper-provenance.js';

export interface BindingFactCategoryCount {
  category: string;
  count: number;
}

interface BindingCall {
  repoId: number;
  sourceSymbolId: number | null;
  bindingId: number | null;
  sourceFile: string;
  startOffset: number;
  endOffset: number;
  evidence: Record<string, unknown>;
}

const unresolvedReasons = new Set<ServiceBindingReferenceReason>([
  'binding_not_found',
  'binding_declared_after_call',
  'scope_chain_limit_exceeded',
  'unsupported_reaching_assignment',
  'unsupported_var_binding',
  'binding_flow_unsupported',
]);
const ownerKinds =
  "'event_registration','callback','method','object_method','function'";
const bindingOwnerSql = `WITH eligible AS (
  SELECT binding.id binding_id,s.id symbol_id,
    DENSE_RANK() OVER (PARTITION BY binding.id ORDER BY
      s.end_offset-s.start_offset,
      CASE s.kind WHEN 'event_registration' THEN 0 WHEN 'callback' THEN 1
        WHEN 'method' THEN 2 WHEN 'object_method' THEN 3 ELSE 4 END,
      s.start_offset,s.end_offset,s.qualified_name COLLATE BINARY) owner_rank
  FROM service_bindings binding
  JOIN repositories repo ON repo.id=binding.repo_id
  JOIN symbols s ON s.repo_id=binding.repo_id
    AND s.source_file=binding.source_file
    AND s.kind IN (${ownerKinds})
    AND s.start_offset<=binding.binding_site_start_offset
    AND s.end_offset>=binding.binding_site_end_offset
  WHERE repo.fact_analyzer_version=?
    AND (? IS NULL OR repo.workspace_id=?)
), best AS (
  SELECT binding_id,COUNT(*) best_count,MAX(symbol_id) symbol_id
  FROM eligible WHERE owner_rank=1 GROUP BY binding_id
)
SELECT COUNT(*) count FROM service_bindings binding
JOIN repositories repo ON repo.id=binding.repo_id
LEFT JOIN best ON best.binding_id=binding.id
WHERE repo.fact_analyzer_version=?
  AND (? IS NULL OR repo.workspace_id=?)
  AND ((best.binding_id IS NULL AND (
    binding.symbol_id IS NOT NULL
    OR binding.owner_resolution<>'ownerless_file_scope'))
  OR (best.binding_id IS NOT NULL AND (
    best.best_count<>1 OR binding.symbol_id IS NOT best.symbol_id
    OR binding.owner_resolution<>'owned_exact')))`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function integer(value: unknown): value is number {
  return Number.isInteger(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function currentParameters(workspaceId?: number): unknown[] {
  return [ANALYZER_VERSION, workspaceId, workspaceId];
}

function category(
  name: string,
  count: number,
): BindingFactCategoryCount[] {
  return count > 0 ? [{ category: name, count }] : [];
}

function bindingTargets(
  db: Db,
  workspaceId?: number,
): Map<number, BindingProofTarget> {
  const rows = db.prepare(`SELECT binding.id,binding.repo_id repoId,
    binding.symbol_id symbolId,binding.variable_name variableName,
    binding.source_file sourceFile,
    binding.binding_site_start_offset startOffset,
    binding.binding_site_end_offset endOffset,
    binding.owner_resolution ownerResolution,
    binding.helper_chain_json helperChainJson,
    owner.start_offset ownerStartOffset,owner.end_offset ownerEndOffset
    FROM service_bindings binding
    JOIN repositories repo ON repo.id=binding.repo_id
    LEFT JOIN symbols owner ON owner.id=binding.symbol_id
    WHERE repo.fact_analyzer_version=?
      AND (? IS NULL OR repo.workspace_id=?)`).all(
    ...currentParameters(workspaceId),
  );
  return new Map(rows.flatMap(bindingTarget).map((item) => [item.id, item]));
}

function bindingTarget(
  row: Record<string, unknown>,
): BindingProofTarget[] {
  if (!bindingTargetShapeValid(row)) return [];
  return [{
    id: row.id,
    repoId: row.repoId,
    symbolId: row.symbolId,
    variableName: row.variableName,
    sourceFile: row.sourceFile,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    ownerResolution: row.ownerResolution,
    ownerStartOffset: row.ownerStartOffset,
    ownerEndOffset: row.ownerEndOffset,
    singleHopHelperReturn: hasSingleHopHelperReturn(row.helperChainJson),
  }];
}

function nullableInteger(value: unknown): boolean {
  return value === null || integer(value);
}

function bindingTargetShapeValid(
  row: Record<string, unknown>,
): row is Record<string, unknown> & {
  id: number;
  repoId: number;
  symbolId: number | null;
  variableName: string;
  sourceFile: string;
  startOffset: number;
  endOffset: number;
  ownerResolution: string;
  ownerStartOffset: number | null;
  ownerEndOffset: number | null;
} {
  return all([
    integer(row.id), integer(row.repoId),
    nonEmpty(row.variableName), nonEmpty(row.sourceFile),
    integer(row.startOffset), integer(row.endOffset),
    typeof row.ownerResolution === 'string',
    nullableInteger(row.symbolId),
    nullableInteger(row.ownerStartOffset),
    nullableInteger(row.ownerEndOffset),
  ]);
}

function bindingCalls(db: Db, workspaceId?: number): BindingCall[] {
  const rows = db.prepare(`SELECT call.repo_id repoId,
    call.source_symbol_id sourceSymbolId,
    call.service_binding_id bindingId,call.source_file sourceFile,
    call.call_site_start_offset startOffset,
    call.call_site_end_offset endOffset,call.evidence_json evidenceJson
    FROM outbound_calls call JOIN repositories repo ON repo.id=call.repo_id
    WHERE repo.fact_analyzer_version=?
      AND (? IS NULL OR repo.workspace_id=?)`).all(
    ...currentParameters(workspaceId),
  );
  return rows.flatMap(bindingCall);
}

function currentFactCount(
  db: Db,
  table: 'service_bindings' | 'outbound_calls',
  workspaceId?: number,
): number {
  const row = db.prepare(`SELECT COUNT(*) count FROM ${table} fact
    JOIN repositories repo ON repo.id=fact.repo_id
    WHERE repo.fact_analyzer_version=?
      AND (? IS NULL OR repo.workspace_id=?)`).get(
    ...currentParameters(workspaceId),
  );
  return Number(row?.count ?? 0);
}

function bindingCall(row: Record<string, unknown>): BindingCall[] {
  const evidence = parseRecord(row.evidenceJson);
  if (!integer(row.repoId) || !nonEmpty(row.sourceFile)
    || !integer(row.startOffset) || !integer(row.endOffset) || !evidence
    || !(row.sourceSymbolId === null || integer(row.sourceSymbolId))
    || !(row.bindingId === null || integer(row.bindingId))) return [];
  return [{
    repoId: row.repoId,
    sourceSymbolId: row.sourceSymbolId,
    bindingId: row.bindingId,
    sourceFile: row.sourceFile,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    evidence,
  }];
}

function rejectedFieldsAbsent(
  reference: Record<string, unknown>,
): boolean {
  return all([
    reference.bindingSourceFile === undefined,
    reference.bindingSiteStartOffset === undefined,
    reference.bindingSiteEndOffset === undefined,
    reference.resolutionStrategy === undefined,
    reference.bindingScopeIndex === undefined,
  ]);
}

function rejectedChainValid(
  reference: Record<string, unknown>,
): boolean {
  const chain = reference.lexicalScopeChain;
  if (!bindingReferenceCountsValid(reference)) return false;
  if (Array.isArray(chain) && !chain.every(validBindingLexicalScope))
    return false;
  return !Array.isArray(chain)
    || reference.scopeChainShown === chain.length;
}

function rejectedReasonValid(
  reference: Record<string, unknown>,
): boolean {
  const reason = reference.reason as ServiceBindingReferenceReason;
  const limitExceeded = reason === 'scope_chain_limit_exceeded';
  if (limitExceeded
    ? reference.scopeChainShown !== 16
      || Number(reference.scopeChainOmitted) <= 0
    : reference.scopeChainOmitted !== 0) return false;
  if (reference.status === 'ambiguous')
    return reason === 'binding_scope_ambiguous';
  return reference.status === 'unresolved' && unresolvedReasons.has(reason);
}

function rejectedShape(
  call: BindingCall,
  reference: Record<string, unknown>,
): boolean {
  return all([
    nonEmpty(reference.variableName),
    call.bindingId === null,
    rejectedFieldsAbsent(reference),
    rejectedChainValid(reference),
    rejectedReasonValid(reference),
  ]);
}

function notApplicableShape(
  call: BindingCall,
  reference: Record<string, unknown>,
): boolean {
  return all([
    call.bindingId === null,
    reference.variableName === undefined,
    reference.reason === undefined,
    rejectedFieldsAbsent(reference),
    reference.lexicalScopeChain === undefined,
    bindingReferenceCountsValid(reference),
    reference.scopeChainTotal === 0,
    reference.scopeChainShown === 0,
    reference.scopeChainOmitted === 0,
  ]);
}

function resolutionEvidenceValid(
  call: BindingCall,
  reference: Record<string, unknown>,
): boolean {
  const resolution = record(call.evidence.serviceBindingResolution);
  if (!resolution) return false;
  if (reference.status === 'resolved_exact')
    return resolution.status === 'selected_exact'
      && resolution.selectedBindingId === call.bindingId
      && resolution.candidateCount === 1;
  return resolution.status === reference.status
    && resolution.candidateCount === 0
    && resolution.selectedBindingId === undefined;
}

function referenceValid(
  call: BindingCall,
  targets: ReadonlyMap<number, BindingProofTarget>,
): boolean {
  const reference = record(call.evidence.serviceBindingReference);
  if (!reference || !resolutionEvidenceValid(call, reference)) return false;
  if (reference.status === 'not_applicable')
    return notApplicableShape(call, reference);
  if (reference.status === 'ambiguous' || reference.status === 'unresolved')
    return rejectedShape(call, reference);
  if (reference.status !== 'resolved_exact') return false;
  return resolvedBindingReferenceProofValid(
    call,
    reference,
    call.bindingId === null ? undefined : targets.get(call.bindingId),
  );
}

function invalidOwnerCount(db: Db, workspaceId?: number): number {
  const params = currentParameters(workspaceId);
  const row = db.prepare(bindingOwnerSql).get(...params, ...params);
  return Number(row?.count ?? 0);
}

export function invalidBindingFactCategories(
  db: Db,
  workspaceId?: number,
): BindingFactCategoryCount[] {
  const targets = bindingTargets(db, workspaceId);
  const calls = bindingCalls(db, workspaceId);
  const invalidReferences = calls.filter((call) =>
    !referenceValid(call, targets)).length;
  const malformedTargets = currentFactCount(
    db, 'service_bindings', workspaceId,
  ) - targets.size;
  const malformedCalls = currentFactCount(
    db, 'outbound_calls', workspaceId,
  ) - calls.length;
  return [
    ...category('service_binding_row_shape_invalid', malformedTargets),
    ...category('outbound_binding_row_shape_invalid', malformedCalls),
    ...category('service_binding_unique_owner_invalid',
      invalidOwnerCount(db, workspaceId)),
    ...category('outbound_binding_lexical_proof_invalid', invalidReferences),
  ];
}
