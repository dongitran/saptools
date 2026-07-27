import type { OutboundCallFact, SymbolCallFact } from '../types.js';
import {
  selectCallOwner,
  type OwnerCandidate,
  type OwnerSelection,
} from '../parsers/fact-identity.js';
import type { Db, Statement } from './connection.js';
import {
  resolveRelativeSymbolCall,
} from './relative-symbol-resolution.js';
import {
  resolvedBindingReferenceProofValid,
  type BindingProofCall,
  type BindingProofTarget,
} from './binding-reference-proof.js';
import {
  containPreparedFactFailure,
  preparedCallSnapshotError,
  type PreparedFactInsertionOptions,
} from './index-publication-failure.js';
import {
  hasSingleHopHelperReturn,
} from './binding-helper-provenance.js';
import {
  insertPackageProvenanceDiagnostic,
  packageImportProvenanceMissing,
} from './package-import-provenance.js';

export function insertSymbolCalls(
  db: Db,
  repoId: number,
  rows: SymbolCallFact[],
  options: PreparedFactInsertionOptions = {},
): number {
  const insertStmt = db.prepare('INSERT INTO symbol_calls(repo_id,caller_symbol_id,callee_symbol_id,callee_expression,import_source,source_file,source_line,call_site_start_offset,call_site_end_offset,call_role,status,confidence,evidence_json,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let diagnosticCount = 0;
  for (const r of rows) {
    try {
      diagnosticCount += insertSymbolCall(db, insertStmt, repoId, r);
    } catch (error) {
      if (!containPreparedFactFailure(db, repoId, error, options)) throw error;
      diagnosticCount += 1;
    }
  }
  return diagnosticCount;
}

function insertSymbolCall(
  db: Db,
  insertStmt: Statement,
  repoId: number,
  call: SymbolCallFact,
): number {
  const callerId = requiredSymbolCallOwnerId(db, repoId, call);
  const target = resolveSymbolCallTarget(db, repoId, call);
  const cardinality = resolutionCardinality(target);
  insertStmt.run(
    repoId, callerId, target.id, call.calleeExpression, call.importSource,
    call.sourceFile, call.sourceLine, call.callSiteStartOffset,
    call.callSiteEndOffset, call.callRole, target.status, 0.8,
    JSON.stringify({
      ...call.evidence,
      candidateStrategy: target.strategy,
      candidateCount: target.candidateCount,
      eligibleCandidateCount: cardinality.eligibleCandidateCount,
      selectedCandidateCount: cardinality.selectedCandidateCount,
      candidateSetComplete: cardinality.candidateSetComplete,
      unresolvedReason: target.reason,
      resolvedModulePath: target.resolvedModulePath,
    }),
    target.reason,
  );
  if (target.reason !== 'package_import_provenance_missing') return 0;
  insertPackageProvenanceDiagnostic(db, repoId, call);
  return 1;
}

interface SymbolTargetRow {
  id: number;
  kind?: string;
  sourceFile?: string | null;
  evidenceJson?: string | null;
}

interface SymbolCallResolution {
  id: number | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason: string | null;
  strategy: string;
  candidateCount: number;
  eligibleCandidateCount: number;
  candidateSetComplete: boolean;
  resolvedModulePath?: string;
}

interface PersistedOwnerCandidate extends OwnerCandidate {
  id: number;
}

function persistedCallOwners(
  db: Db,
  repoId: number,
  sourceFile: string,
  start: number | undefined,
  end: number | undefined,
): PersistedOwnerCandidate[] {
  if (start === undefined || end === undefined) return [];
  const rows = db.prepare(`SELECT id,kind,qualified_name qualifiedName,
    start_offset startOffset,end_offset endOffset FROM symbols
    WHERE repo_id=? AND source_file=? AND start_offset<=? AND end_offset>=?`)
    .all(repoId, sourceFile, start, end);
  return rows.flatMap(persistedOwnerCandidate);
}

function persistedOwnerCandidate(
  row: Record<string, unknown>,
): PersistedOwnerCandidate[] {
  if (typeof row.id !== 'number' || typeof row.kind !== 'string'
    || typeof row.qualifiedName !== 'string'
    || typeof row.startOffset !== 'number'
    || typeof row.endOffset !== 'number') return [];
  return [{
    id: row.id,
    kind: row.kind,
    qualifiedName: row.qualifiedName,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
  }];
}

function requiredSymbolCallOwnerId(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
): number {
  const candidates = persistedCallOwners(
    db, repoId, call.sourceFile,
    call.callSiteStartOffset, call.callSiteEndOffset,
  );
  const selected = selectCallOwner(
    candidates,
    call.callSiteStartOffset ?? -1,
    call.callSiteEndOffset ?? -1,
    call.callRole === 'event_subscribe_handler',
  );
  if (selected.status !== 'resolved'
    || selected.owner?.qualifiedName !== call.callerQualifiedName)
    throw preparedCallSnapshotError(
      'symbol_call_owner_mismatch', 'symbol_call', call,
    );
  return selected.owner.id;
}

function resolutionCardinality(
  target: SymbolCallResolution,
): {
  eligibleCandidateCount: number;
  selectedCandidateCount: 0 | 1;
  candidateSetComplete: boolean;
} {
  return {
    eligibleCandidateCount: target.eligibleCandidateCount,
    selectedCandidateCount: target.status === 'resolved' ? 1 : 0,
    candidateSetComplete: target.candidateSetComplete,
  };
}

function symbolTargetRows(rows: Array<Record<string, unknown>>): SymbolTargetRow[] {
  return rows.flatMap((row) => typeof row.id === 'number' ? [{
    id: row.id,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    sourceFile: typeof row.sourceFile === 'string' ? row.sourceFile : null,
    evidenceJson: typeof row.evidenceJson === 'string'
      ? row.evidenceJson : null,
  }] : []);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function executableTarget(row: SymbolTargetRow): boolean {
  if (!row.evidenceJson || !row.kind
    || !['function', 'method', 'object_method', 'callback'].includes(row.kind))
    return false;
  try {
    const evidence = record(JSON.parse(row.evidenceJson) as unknown);
    const body = record(evidence?.executableBodyEligibility);
    return body?.eligible === true && body.reason === 'body_present';
  } catch {
    return false;
  }
}

function resolvedSymbol(
  row: SymbolTargetRow,
  strategy: string,
  candidateCount: number,
  eligibleCandidateCount = 1,
): SymbolCallResolution {
  return {
    id: row.id,
    status: 'resolved',
    reason: null,
    strategy,
    candidateCount,
    eligibleCandidateCount,
    candidateSetComplete: true,
  };
}

function unresolvedSymbol(
  strategy: string,
  reason: string,
  candidateCount: number,
  eligibleCandidateCount = 0,
  candidateSetComplete = true,
): SymbolCallResolution {
  return {
    id: null,
    status: 'unresolved',
    reason,
    strategy,
    candidateCount,
    eligibleCandidateCount,
    candidateSetComplete,
  };
}

function ambiguousSymbol(
  strategy: string,
  reason: string,
  candidateCount: number,
  eligibleCandidateCount: number,
): SymbolCallResolution {
  return {
    id: null,
    status: 'ambiguous',
    reason,
    strategy,
    candidateCount,
    eligibleCandidateCount,
    candidateSetComplete: true,
  };
}

function exportedSymbolRows(db: Db, repoId: number, r: SymbolCallFact): SymbolTargetRow[] {
  return symbolTargetRows(db.prepare(`SELECT id,kind,
    source_file sourceFile,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file<>? AND exported=1
      AND (exported_name=? OR name=? OR qualified_name=?)
    ORDER BY id`).all(
    repoId, r.sourceFile,
    r.calleeLocalName, r.calleeLocalName, r.calleeLocalName,
  ));
}

const sameFileEligibleRelations = new Set([
  'indexed_local_symbol',
  'indexed_local_symbol_unproven',
  'indexed_this_method',
]);

function eligibleSymbolResolution(
  rows: SymbolTargetRow[],
  strategy: string,
  ambiguousReason: string,
): SymbolCallResolution | undefined {
  if (rows.length === 0) return undefined;
  const eligible = rows.filter(executableTarget);
  if (eligible.length === 1 && eligible[0])
    return resolvedSymbol(eligible[0], strategy, rows.length, 1);
  if (eligible.length > 1) return ambiguousSymbol(
    strategy, ambiguousReason, rows.length, eligible.length,
  );
  return unresolvedSymbol(
    strategy, 'symbol_target_has_no_executable_body', rows.length,
  );
}

function sameFileResolution(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (!sameFileEligibleRelations.has(String(relation))) return undefined;
  if (relation === 'indexed_local_symbol_unproven')
    return unresolvedSymbol(
      'exact_symbol_match', 'no_local_symbol_target', 0,
    );
  if (relation === 'indexed_local_symbol'
    && r.evidence.localTargetIdentity !== undefined)
    return exactLocalSymbolResolution(db, repoId, r);
  const rows = symbolTargetRows(db.prepare(`SELECT id,kind,
    source_file sourceFile,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file=?
      AND (name=? OR qualified_name=?) ORDER BY id`).all(
    repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName,
  ));
  return eligibleSymbolResolution(
    rows, 'same_file_exact', 'multiple_same_file_symbol_targets',
  );
}

function exactLocalSymbolResolution(
  db: Db,
  repoId: number,
  call: SymbolCallFact,
): SymbolCallResolution {
  const target = record(call.evidence.localTargetIdentity);
  if (!target
    || typeof target.sourceFile !== 'string'
    || typeof target.qualifiedName !== 'string'
    || typeof target.startOffset !== 'number'
    || typeof target.endOffset !== 'number')
    return unresolvedSymbol(
      'exact_symbol_match', 'no_local_symbol_target', 0,
    );
  const rows = symbolTargetRows(db.prepare(`SELECT id,kind,
    source_file sourceFile,evidence_json evidenceJson FROM symbols
    WHERE repo_id=? AND source_file=? AND qualified_name=?
      AND start_offset=? AND end_offset=? ORDER BY id`).all(
    repoId, target.sourceFile, target.qualifiedName,
    target.startOffset, target.endOffset,
  ));
  return eligibleSymbolResolution(
    rows, 'same_file_exact', 'multiple_same_file_symbol_targets',
  ) ?? unresolvedSymbol(
    'exact_symbol_match', 'no_local_symbol_target', 0,
  );
}

function exportedResolution(
  rows: SymbolTargetRow[],
): SymbolCallResolution | undefined {
  return eligibleSymbolResolution(
    rows, 'exported_exact', 'multiple_exported_symbol_targets',
  );
}

export function resolveSymbolCallTarget(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
): SymbolCallResolution {
  if (packageImportProvenanceMissing(r)) return unresolvedSymbol(
    'package_import_provenance_missing',
    'package_import_provenance_missing',
    0,
  );
  const relation = r.evidence.relation;
  const relative = resolveRelativeSymbolCall(db, repoId, r, relation);
  if (relative) return relative;
  const early = sameFileResolution(db, repoId, r, relation);
  if (early) return early;
  if (relation === 'package_import_derived_member') return unresolvedSymbol(
    'package_import_derived_member_unsupported',
    'package_derived_member_provenance_insufficient',
    0,
  );
  if (relation === 'package_import') return unresolvedSymbol(
    'package_import_pending',
    'package_resolution_pending',
    0,
    0,
    false,
  );
  const matched = exportedResolution(exportedSymbolRows(db, repoId, r));
  if (matched) return matched;
  return unresolvedSymbol(
    'exact_symbol_match',
    'no_local_symbol_target',
    0,
  );
}

export function insertCalls(
  db: Db,
  repoId: number,
  rows: OutboundCallFact[],
  options: PreparedFactInsertionOptions = {},
): number {
  const stmt = outboundCallInsertStatement(db);
  let diagnosticCount = 0;
  for (const row of rows) {
    try {
      insertOutboundCall(db, stmt, repoId, row);
    } catch (error) {
      if (!containPreparedFactFailure(db, repoId, error, options)) throw error;
      diagnosticCount += 1;
    }
  }
  return diagnosticCount;
}

function outboundCallInsertStatement(db: Db): Statement {
  return db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,method,operation_path_expr,query_entity,
    event_name_expr,event_skeleton_signature,event_skeleton_json,
    payload_summary,source_file,source_line,call_site_start_offset,
    call_site_end_offset,confidence,unresolved_reason,local_service_name,
    local_service_lookup,alias_chain_json,evidence_json,external_target_kind,
    external_target_id,external_target_label,external_target_dynamic,service_binding_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
}

function insertOutboundCall(
  db: Db,
  stmt: Statement,
  repoId: number,
  call: OutboundCallFact,
): void {
  const sourceSymbolId = outboundOwnerId(db, repoId, call);
  const binding = resolvePersistedBinding(db, repoId, call);
  const external = externalTargetValues(call.externalTarget);
  const evidence = {
    ...(call.evidence ?? {}),
    serviceBindingReference: binding.reference,
    serviceBindingResolution: binding.resolution,
  };
  stmt.run(
    repoId, sourceSymbolId,
    call.callType, call.method, call.operationPathExpr, call.queryEntity,
    call.eventNameExpr, call.eventSkeleton?.signature ?? null,
    call.eventSkeleton ? JSON.stringify(call.eventSkeleton) : null,
    call.payloadSummary, call.sourceFile, call.sourceLine,
    call.callSiteStartOffset, call.callSiteEndOffset, call.confidence,
    call.unresolvedReason,
    call.localServiceName, call.localServiceLookup,
    serializedAliasChain(call.aliasChain),
    JSON.stringify(evidence), external.kind, external.stableId, external.label,
    external.dynamic, binding.bindingId,
  );
}

function serializedAliasChain(
  aliasChain: OutboundCallFact['aliasChain'],
): string | null {
  return aliasChain ? JSON.stringify(aliasChain) : null;
}

function externalTargetValues(
  target: OutboundCallFact['externalTarget'],
): { kind: string | null; stableId: string | null; label: string | null;
  dynamic: number } {
  if (!target) return { kind: null, stableId: null, label: null, dynamic: 0 };
  return {
    kind: target.kind, stableId: target.stableId, label: target.label,
    dynamic: target.dynamic ? 1 : 0,
  };
}

interface PersistedBinding {
  id: number;
  symbolId?: number | null;
  variableName: string;
  sourceFile: string;
  siteStart: number;
  siteEnd: number;
  ownerResolution: string;
  ownerStartOffset: number | null;
  ownerEndOffset: number | null;
  singleHopHelperReturn: boolean;
}

function outboundOwnerId(
  db: Db,
  repoId: number,
  call: OutboundCallFact,
): number | null {
  const candidates = persistedCallOwners(
    db, repoId, call.sourceFile,
    call.callSiteStartOffset, call.callSiteEndOffset,
  );
  const selected = selectCallOwner(
    candidates,
    call.callSiteStartOffset ?? -1,
    call.callSiteEndOffset ?? -1,
    call.callType === 'async_subscribe',
  );
  const resolution = call.evidence?.sourceOwnerResolution;
  if (resolution === 'ownerless_file_scope')
    return ownerlessOutboundOwner(call, selected.status);
  return ownedOutboundOwner(call, resolution, selected);
}

function ownerlessOutboundOwner(
  call: OutboundCallFact,
  status: string,
): null {
  if (status !== 'none')
    throw preparedCallSnapshotError(
      'outbound_owner_mismatch', 'outbound_call', call,
    );
  return null;
}

function ownedOutboundOwner(
  call: OutboundCallFact,
  resolution: unknown,
  selected: OwnerSelection<PersistedOwnerCandidate>,
): number {
  if (resolution !== 'owned_exact' || selected.status !== 'resolved'
    || selected.owner?.qualifiedName !== call.sourceSymbolQualifiedName)
    throw preparedCallSnapshotError(
      'outbound_owner_mismatch', 'outbound_call', call,
    );
  const owner = selected.owner;
  if (!owner)
    throw preparedCallSnapshotError(
      'outbound_owner_mismatch', 'outbound_call', call,
    );
  return owner.id;
}

function resolvePersistedBinding(
  db: Db,
  repoId: number,
  call: OutboundCallFact,
): {
  bindingId: number | null;
  reference: NonNullable<OutboundCallFact['serviceBindingReference']>;
  resolution: Record<string, unknown>;
} {
  const reference = call.serviceBindingReference;
  if (!reference)
    throw preparedCallSnapshotError(
      'binding_reference_missing', 'outbound_call', call,
    );
  if (reference.status !== 'resolved_exact')
    return unresolvedBinding(reference);
  const candidates = exactBindingRows(db, repoId, reference);
  const selected = candidates[0];
  if (candidates.length !== 1 || !selected
    || selected.variableName !== call.serviceVariableName)
    throw preparedCallSnapshotError(
      'binding_reference_mismatch', 'outbound_call', call,
    );
  assertResolvedBindingProof(repoId, call, selected, reference);
  return {
    bindingId: selected.id,
    reference,
    resolution: {
      status: 'selected_exact',
      selectedBindingId: selected.id,
      candidateCount: 1,
    },
  };
}

function bindingProofCall(
  repoId: number,
  call: OutboundCallFact,
  bindingId: number,
): BindingProofCall {
  if (call.callSiteStartOffset === undefined
    || call.callSiteEndOffset === undefined)
    throw preparedCallSnapshotError(
      'binding_lexical_proof_invalid', 'outbound_call', call,
    );
  return {
    repoId,
    bindingId,
    variableName: call.serviceVariableName,
    sourceFile: call.sourceFile,
    startOffset: call.callSiteStartOffset,
    endOffset: call.callSiteEndOffset,
  };
}

function bindingProofTarget(
  repoId: number,
  binding: PersistedBinding,
): BindingProofTarget {
  return {
    id: binding.id,
    repoId,
    symbolId: binding.symbolId ?? null,
    variableName: binding.variableName,
    sourceFile: binding.sourceFile,
    startOffset: binding.siteStart,
    endOffset: binding.siteEnd,
    ownerResolution: binding.ownerResolution,
    ownerStartOffset: binding.ownerStartOffset,
    ownerEndOffset: binding.ownerEndOffset,
    singleHopHelperReturn: binding.singleHopHelperReturn,
  };
}

function assertResolvedBindingProof(
  repoId: number,
  call: OutboundCallFact,
  binding: PersistedBinding,
  reference: NonNullable<OutboundCallFact['serviceBindingReference']>,
): void {
  const valid = resolvedBindingReferenceProofValid(
    bindingProofCall(repoId, call, binding.id),
    reference,
    bindingProofTarget(repoId, binding),
  );
  if (!valid)
    throw preparedCallSnapshotError(
      'binding_lexical_proof_invalid', 'outbound_call', call,
    );
}

function unresolvedBinding(
  reference: NonNullable<OutboundCallFact['serviceBindingReference']>,
): {
  bindingId: null;
  reference: NonNullable<OutboundCallFact['serviceBindingReference']>;
  resolution: Record<string, unknown>;
} {
  return {
    bindingId: null,
    reference,
    resolution: {
      status: reference.status,
      candidateCount: 0,
    },
  };
}

function exactBindingRows(
  db: Db,
  repoId: number,
  reference: NonNullable<OutboundCallFact['serviceBindingReference']>,
): PersistedBinding[] {
  const rows = db.prepare(`SELECT binding.id,binding.symbol_id symbolId,
    binding.variable_name variableName,binding.source_file sourceFile,
    binding.binding_site_start_offset siteStart,
    binding.binding_site_end_offset siteEnd,
    binding.owner_resolution ownerResolution,
    binding.helper_chain_json helperChainJson,
    owner.start_offset ownerStartOffset,owner.end_offset ownerEndOffset
    FROM service_bindings binding
    LEFT JOIN symbols owner ON owner.id=binding.symbol_id
    WHERE binding.repo_id=? AND binding.source_file=?
      AND binding.variable_name=?
      AND binding.binding_site_start_offset=?
      AND binding.binding_site_end_offset=?`).all(
    repoId,
    reference.bindingSourceFile,
    reference.variableName,
    reference.bindingSiteStartOffset,
    reference.bindingSiteEndOffset,
  );
  return rows.flatMap(persistedBindingRow);
}

function persistedBindingRow(
  row: Record<string, unknown>,
): PersistedBinding[] {
  const ownerStartOffset = nullableOffset(row.ownerStartOffset);
  const ownerEndOffset = nullableOffset(row.ownerEndOffset);
  if (!persistedBindingRequiredValid(row)
    || ownerStartOffset === undefined || ownerEndOffset === undefined) return [];
  return [{
    id: row.id,
    symbolId: row.symbolId === null || typeof row.symbolId === 'number'
      ? row.symbolId : undefined,
    variableName: row.variableName,
    sourceFile: row.sourceFile,
    siteStart: row.siteStart,
    siteEnd: row.siteEnd,
    ownerResolution: row.ownerResolution,
    ownerStartOffset,
    ownerEndOffset,
    singleHopHelperReturn: hasSingleHopHelperReturn(row.helperChainJson),
  }];
}

function nullableOffset(value: unknown): number | null | undefined {
  return value === null || typeof value === 'number' ? value : undefined;
}

function persistedBindingRequiredValid(
  row: Record<string, unknown>,
): row is Record<string, unknown> & {
  id: number;
  variableName: string;
  sourceFile: string;
  siteStart: number;
  siteEnd: number;
  ownerResolution: string;
} {
  return [
    typeof row.id === 'number',
    typeof row.variableName === 'string',
    typeof row.sourceFile === 'string',
    typeof row.siteStart === 'number',
    typeof row.siteEnd === 'number',
    typeof row.ownerResolution === 'string',
  ].every(Boolean);
}
