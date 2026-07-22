import { posix } from 'node:path';
import type { OutboundCallFact, SymbolCallFact } from '../types.js';
import { projectBounded } from '../utils/000-bounded-projection.js';
import type { Db, Statement } from './connection.js';

export function insertSymbolCalls(db: Db, repoId: number, rows: SymbolCallFact[]): void {
  const callerStmt = db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1');
  const insertStmt = db.prepare('INSERT INTO symbol_calls(repo_id,caller_symbol_id,callee_symbol_id,callee_expression,import_source,source_file,source_line,call_site_start_offset,call_site_end_offset,call_role,status,confidence,evidence_json,unresolved_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    const caller = callerStmt.get(repoId, r.sourceFile, r.callerQualifiedName) as { id?: number } | undefined;
    const target = resolveSymbolCallTarget(db, repoId, r);
    insertStmt.run(
      repoId,
      caller?.id,
      target.id,
      r.calleeExpression,
      r.importSource,
      r.sourceFile,
      r.sourceLine,
      r.callSiteStartOffset,
      r.callSiteEndOffset,
      r.callRole,
      target.status,
      0.8,
      JSON.stringify({
        ...r.evidence,
        candidateStrategy: target.strategy,
        candidateCount: target.candidateCount,
        resolvedModulePath: target.resolvedModulePath,
      }),
      target.reason,
    );
  }
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
  resolvedModulePath?: string;
}

const stripExt = (value: string): string => value.replace(/\.(ts|tsx|js|jsx|cds)$/, '');

function symbolTargetRows(rows: Array<Record<string, unknown>>): SymbolTargetRow[] {
  return rows.flatMap((row) => typeof row.id === 'number' ? [{
    id: row.id,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    sourceFile: nullableString(row.sourceFile),
    evidenceJson: nullableString(row.evidenceJson),
  }] : []);
}

function relativeModuleTargets(callerSourceFile: string, importSource: string): Set<string> {
  const base = posix.dirname(callerSourceFile);
  const joined = stripExt(posix.normalize(posix.join(base, importSource)));
  return new Set([joined, `${joined}/index`]);
}

function moduleRows(rows: SymbolTargetRow[], r: SymbolCallFact): SymbolTargetRow[] {
  if (!r.importSource) return [];
  const targets = relativeModuleTargets(r.sourceFile, r.importSource);
  return rows.filter((row) => typeof row.sourceFile === 'string'
    && targets.has(stripExt(row.sourceFile)));
}

function resolvedSymbol(
  row: SymbolTargetRow,
  strategy: string,
  candidateCount: number,
  moduleScoped = false,
): SymbolCallResolution {
  return {
    id: row.id,
    status: 'resolved',
    reason: null,
    strategy,
    candidateCount,
    resolvedModulePath: moduleScoped && row.sourceFile
      ? stripExt(row.sourceFile)
      : undefined,
  };
}

function exportedSymbolRows(db: Db, repoId: number, r: SymbolCallFact): SymbolTargetRow[] {
  return symbolTargetRows(db.prepare('SELECT id,kind,source_file sourceFile,evidence_json evidenceJson FROM symbols WHERE repo_id=? AND source_file<>? AND exported=1 AND (exported_name=? OR name=? OR qualified_name=?) ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName, r.calleeLocalName));
}

function isRelativeImportedSymbolCall(r: SymbolCallFact): boolean {
  return Boolean(r.importSource?.startsWith('.'));
}

function sameFileResolution(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  const bareImport = relation === 'relative_import' && isRelativeImportedSymbolCall(r)
    && !String(r.calleeLocalName).includes('.');
  if (bareImport || relation === 'relative_import_namespace_member'
    || relation === 'package_import') return undefined;
  const rows = symbolTargetRows(db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND (name=? OR qualified_name=?) ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName, r.calleeLocalName));
  if (rows.length === 1 && rows[0]) return resolvedSymbol(rows[0], 'same_file_exact', 1);
  return rows.length > 1
    ? {
        id: null,
        status: 'ambiguous',
        reason: 'Multiple same-file symbol targets matched exactly',
        strategy: 'same_file_exact',
        candidateCount: rows.length,
      }
    : undefined;
}

function classInstanceResolution(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (relation !== 'class_instance_method' || !isRelativeImportedSymbolCall(r))
    return undefined;
  const rows = symbolTargetRows(db.prepare('SELECT id FROM symbols WHERE repo_id=? AND source_file<>? AND qualified_name=? ORDER BY id').all(repoId, r.sourceFile, r.calleeLocalName));
  if (rows.length === 1 && rows[0])
    return resolvedSymbol(rows[0], 'relative_import_class_instance_method', 1);
  return rows.length > 1
    ? {
        id: null,
        status: 'ambiguous',
        reason: 'Multiple relative class instance method targets matched exactly',
        strategy: 'relative_import_class_instance_method',
        candidateCount: rows.length,
      }
    : undefined;
}

function namespaceResolution(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (relation !== 'relative_import_namespace_member'
    || !isRelativeImportedSymbolCall(r)) return undefined;
  const rows = moduleRows(exportedSymbolRows(db, repoId, r), r);
  if (rows.length === 1 && rows[0])
    return resolvedSymbol(rows[0], 'relative_import_namespace_member', 1, true);
  if (rows.length > 1) return {
    id: null,
    status: 'ambiguous',
    reason: 'Multiple namespace member targets matched the imported module',
    strategy: 'relative_import_namespace_member',
    candidateCount: rows.length,
  };
  return {
    id: null,
    status: 'unresolved',
    reason: 'No namespace member target matched the imported module',
    strategy: 'relative_import_namespace_member',
    candidateCount: 0,
  };
}

function proxyResolution(
  rows: SymbolTargetRow[],
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (relation !== 'relative_import_proxy_member' || rows.length <= 1) return undefined;
  const mapped = rows.filter(isExportedObjectMapping);
  if (mapped.length > 0) {
    const concrete = rows.find((row) => row.kind !== 'object_alias') ?? mapped[0];
    return {
      id: concrete?.id ?? null,
      status: 'resolved',
      reason: null,
      strategy: 'proxy_member_exported_object_map',
      candidateCount: rows.length,
    };
  }
  const scoped = moduleRows(rows, r);
  if (scoped.length === 1 && scoped[0])
    return resolvedSymbol(scoped[0], 'relative_import_path_disambiguated', rows.length, true);
  return {
    id: null,
    status: 'ambiguous',
    reason: 'Proxy member target requires explicit factory/module/type evidence; global member name is ambiguous',
    strategy: 'proxy_member_no_global_name_fallback',
    candidateCount: rows.length,
  };
}

function isExportedObjectMapping(row: SymbolTargetRow): boolean {
  const evidence = String(row.evidenceJson ?? '');
  return evidence.includes('exported_object_shorthand')
    || evidence.includes('exported_object_literal');
}

function exportedResolution(
  rows: SymbolTargetRow[],
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (rows.length === 1 && rows[0]) return resolvedSymbol(
    rows[0],
    relation === 'relative_import_proxy_member'
      ? 'proxy_member_unique_exported_candidate'
      : 'relative_import_exported_exact',
    1,
    moduleRows(rows, r).length === 1,
  );
  if (rows.length <= 1) return undefined;
  const scoped = isRelativeImportedSymbolCall(r) ? moduleRows(rows, r) : [];
  if (scoped.length === 1 && scoped[0])
    return resolvedSymbol(scoped[0], 'relative_import_path_disambiguated', rows.length, true);
  return {
    id: null,
    status: 'ambiguous',
    reason: 'Multiple exported symbol targets matched exactly',
    strategy: 'exported_exact',
    candidateCount: rows.length,
  };
}

function accessorResolution(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
  relation: unknown,
): SymbolCallResolution | undefined {
  if (relation !== 'relative_import' || !isRelativeImportedSymbolCall(r)
    || !/^[^.]+\.[^.]+$/.test(String(r.calleeLocalName))) return undefined;
  const methodRows = symbolTargetRows(db.prepare("SELECT id,kind,source_file sourceFile FROM symbols WHERE repo_id=? AND source_file<>? AND kind='method' AND qualified_name=? ORDER BY id").all(repoId, r.sourceFile, r.calleeLocalName));
  const scoped = moduleRows(methodRows, r);
  if (scoped.length === 1 && scoped[0]) return resolvedSymbol(
    scoped[0],
    'relative_import_static_accessor_instance_method',
    1,
    true,
  );
  return scoped.length > 1
    ? {
        id: null,
        status: 'ambiguous',
        reason: 'Multiple static-accessor instance method targets matched the imported module',
        strategy: 'relative_import_static_accessor_instance_method',
        candidateCount: scoped.length,
      }
    : undefined;
}

function resolveSymbolCallTarget(
  db: Db,
  repoId: number,
  r: SymbolCallFact,
): SymbolCallResolution {
  const relation = r.evidence.relation;
  const early = sameFileResolution(db, repoId, r, relation)
    ?? classInstanceResolution(db, repoId, r, relation)
    ?? namespaceResolution(db, repoId, r, relation);
  if (early) return early;
  const rows = relation === 'package_import' ? [] : exportedSymbolRows(db, repoId, r);
  const matched = proxyResolution(rows, r, relation)
    ?? exportedResolution(rows, r, relation)
    ?? accessorResolution(db, repoId, r, relation);
  if (matched) return matched;
  if (relation === 'package_import') return {
    id: null,
    status: 'unresolved',
    reason: 'Package import target resolution requires a post-publication workspace pass',
    strategy: 'package_import_unresolved',
    candidateCount: 0,
  };
  return {
    id: null,
    status: 'unresolved',
    reason: 'No local symbol target matched exactly',
    strategy: relation === 'relative_import_proxy_member'
      ? 'proxy_member_no_global_name_fallback'
      : 'exact_symbol_match',
    candidateCount: 0,
  };
}

export function insertCalls(
  db: Db,
  repoId: number,
  rows: OutboundCallFact[],
): void {
  const stmt = outboundCallInsertStatement(db);
  for (const row of rows) insertOutboundCall(db, stmt, repoId, row);
}

function outboundCallInsertStatement(db: Db): Statement {
  return db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,method,operation_path_expr,query_entity,
    event_name_expr,payload_summary,source_file,source_line,call_site_start_offset,
    call_site_end_offset,confidence,unresolved_reason,local_service_name,
    local_service_lookup,alias_chain_json,evidence_json,external_target_kind,
    external_target_id,external_target_label,external_target_dynamic,service_binding_id
  ) VALUES(
    ?,COALESCE(
      (SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND qualified_name=? ORDER BY id LIMIT 1),
      (SELECT id FROM symbols WHERE repo_id=? AND source_file=? AND start_line<=? AND end_line>=? ORDER BY (end_line-start_line),id LIMIT 1)
    ),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
  )`);
}

function insertOutboundCall(
  db: Db,
  stmt: Statement,
  repoId: number,
  call: OutboundCallFact,
): void {
  const binding = resolvePersistedBinding(db, repoId, call);
  const external = externalTargetValues(call.externalTarget);
  const evidence = {
    ...(call.evidence ?? {}),
    serviceBindingResolution: binding.evidence,
  };
  stmt.run(
    repoId, repoId, call.sourceFile, call.sourceSymbolQualifiedName,
    repoId, call.sourceFile, call.sourceLine, call.sourceLine,
    call.callType, call.method, call.operationPathExpr, call.queryEntity,
    call.eventNameExpr, call.payloadSummary, call.sourceFile, call.sourceLine,
    call.callSiteStartOffset, call.callSiteEndOffset, call.confidence,
    call.unresolvedReason ?? binding.unresolvedReason,
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

interface BindingCandidate {
  id: number;
  symbolId?: number | null;
  variableName: string;
  alias?: string | null;
  aliasExpr?: string | null;
  destinationExpr?: string | null;
  servicePathExpr?: string | null;
  sourceFile: string;
  sourceLine: number;
  helperChainJson?: string | null;
}

function resolvePersistedBinding(
  db: Db,
  repoId: number,
  call: OutboundCallFact,
): {
  bindingId: number | null;
  unresolvedReason?: string;
  evidence: Record<string, unknown>;
} {
  if (!call.serviceVariableName)
    return { bindingId: null, evidence: { status: 'not_applicable', candidateCount: 0 } };
  const candidates = bindingCandidates(db, repoId, call);
  const prior = candidates.filter((candidate) => candidate.sourceLine <= call.sourceLine);
  const families = new Set(prior.map(bindingSignature));
  if (prior.length > 0 && families.size === 1) {
    const selected = prior.at(-1);
    return {
      bindingId: selected?.id ?? null,
      evidence: bindingEvidence('selected', prior, selected),
    };
  }
  if (prior.length > 1) {
    return {
      bindingId: null,
      unresolvedReason: 'ambiguous_service_binding_candidates',
      evidence: bindingEvidence('ambiguous', prior),
    };
  }
  if (candidates.length > 0) {
    return {
      bindingId: null,
      unresolvedReason: 'service_binding_declared_after_call',
      evidence: bindingEvidence('rejected_future_binding', candidates),
    };
  }
  return {
    bindingId: null,
    evidence: bindingEvidence('unrecoverable', []),
  };
}

function bindingCandidates(
  db: Db,
  repoId: number,
  call: OutboundCallFact,
): BindingCandidate[] {
  const ownerId = callSymbolId(db, repoId, call);
  const rows = db.prepare(`
    SELECT id,symbol_id symbolId,variable_name variableName,alias,alias_expr aliasExpr,
      destination_expr destinationExpr,service_path_expr servicePathExpr,
      source_file sourceFile,source_line sourceLine,helper_chain_json helperChainJson
    FROM service_bindings
    WHERE repo_id=? AND variable_name=? AND source_file=?
      AND (? IS NULL OR symbol_id IS NULL OR symbol_id=?)
    ORDER BY source_line,id
  `).all(
    repoId,
    call.serviceVariableName,
    call.sourceFile,
    ownerId,
    ownerId,
  ) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    if (typeof row.id !== 'number' || typeof row.variableName !== 'string'
      || typeof row.sourceFile !== 'string' || typeof row.sourceLine !== 'number')
      return [];
    return [{
      id: row.id,
      symbolId: nullableNumber(row.symbolId),
      variableName: row.variableName,
      alias: nullableString(row.alias),
      aliasExpr: nullableString(row.aliasExpr),
      destinationExpr: nullableString(row.destinationExpr),
      servicePathExpr: nullableString(row.servicePathExpr),
      sourceFile: row.sourceFile,
      sourceLine: row.sourceLine,
      helperChainJson: nullableString(row.helperChainJson),
    }];
  });
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || typeof value === 'number' ? value : undefined;
}

function callSymbolId(
  db: Db,
  repoId: number,
  call: OutboundCallFact,
): number | undefined {
  const row = db.prepare(`
    SELECT id FROM symbols
    WHERE repo_id=? AND source_file=?
      AND ((? IS NOT NULL AND qualified_name=?)
        OR (start_line<=? AND end_line>=?))
    ORDER BY CASE WHEN qualified_name=? THEN 0 ELSE 1 END,
      (end_line-start_line),id
    LIMIT 1
  `).get(
    repoId,
    call.sourceFile,
    call.sourceSymbolQualifiedName,
    call.sourceSymbolQualifiedName,
    call.sourceLine,
    call.sourceLine,
    call.sourceSymbolQualifiedName,
  );
  return typeof row?.id === 'number' ? row.id : undefined;
}

function bindingEvidence(
  status: string,
  candidates: BindingCandidate[],
  selected?: BindingCandidate,
): Record<string, unknown> {
  const projection = projectBounded(candidates, (left, right) =>
    Number(right.id === selected?.id) - Number(left.id === selected?.id)
    || left.sourceFile.localeCompare(right.sourceFile)
    || left.sourceLine - right.sourceLine
    || left.id - right.id);
  return {
    status,
    candidateCount: projection.totalCount,
    shownCandidateCount: projection.shownCount,
    omittedCandidateCount: projection.omittedCount,
    selectedBindingId: selected?.id,
    sourceOrderRule: 'binding_source_line_must_not_follow_call',
    candidates: projection.items.map((candidate) => ({
      bindingId: candidate.id,
      symbolId: candidate.symbolId,
      variableName: candidate.variableName,
      alias: candidate.alias,
      aliasExpr: candidate.aliasExpr,
      destinationExpr: candidate.destinationExpr,
      servicePathExpr: candidate.servicePathExpr,
      sourceFile: candidate.sourceFile,
      sourceLine: candidate.sourceLine,
      helperChain: parseBindingChain(candidate.helperChainJson),
    })),
  };
}

function bindingSignature(candidate: BindingCandidate): string {
  return JSON.stringify([
    candidate.alias,
    candidate.aliasExpr,
    candidate.destinationExpr,
    candidate.servicePathExpr,
  ]);
}

function parseBindingChain(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
