import type { SymbolCallFact } from '../types.js';
import { ANALYZER_VERSION } from '../version.js';
import { resolveSymbolCallTarget } from './call-fact-repository.js';
import type { Db } from './connection.js';

export interface SymbolFactCategoryCount {
  category: string;
  count: number;
}

interface PersistedSymbolCall {
  repoId: number;
  calleeId: number | null;
  status: string;
  reason: string | null;
  fact: SymbolCallFact;
}

interface PersistedSymbolRows {
  calls: PersistedSymbolCall[];
  malformedCount: number;
}

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

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function allValid(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function genericRows(db: Db, workspaceId?: number): PersistedSymbolRows {
  const rows = db.prepare(`SELECT sc.* FROM symbol_calls sc
    JOIN repositories r ON r.id=sc.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND sc.import_source IS NULL
      AND COALESCE(json_extract(sc.evidence_json,'$.relation'),'')
        NOT IN ('package_import','package_import_derived_member')
      AND COALESCE(json_extract(sc.evidence_json,
        '$.importBinding.moduleKind'),'') NOT IN ('relative','package')
    ORDER BY sc.id`).all(ANALYZER_VERSION, workspaceId, workspaceId);
  const parsed = rows.map(persistedSymbolCall);
  return {
    calls: parsed.flatMap((call) => call),
    malformedCount: parsed.filter((call) => call.length === 0).length,
  };
}

function callFieldsValid(
  row: Record<string, unknown>,
  evidence: Record<string, unknown>,
): boolean {
  return allValid([
    typeof row.repo_id === 'number',
    typeof row.source_file === 'string',
    typeof row.source_line === 'number',
    typeof row.callee_expression === 'string',
    typeof row.call_role === 'string',
    typeof row.status === 'string',
    typeof evidence.caller === 'string',
    typeof evidence.targetName === 'string',
  ]);
}

function persistedSymbolCall(
  row: Record<string, unknown>,
): PersistedSymbolCall[] {
  const evidence = parseRecord(row.evidence_json);
  if (!evidence || !callFieldsValid(row, evidence)) return [];
  return [{
    repoId: Number(row.repo_id),
    calleeId: nullableNumber(row.callee_symbol_id),
    status: String(row.status),
    reason: typeof row.unresolved_reason === 'string'
      ? row.unresolved_reason : null,
    fact: symbolCallFact(row, evidence),
  }];
}

function symbolCallFact(
  row: Record<string, unknown>,
  evidence: Record<string, unknown>,
): SymbolCallFact {
  return {
    callerQualifiedName: String(evidence.caller),
    calleeExpression: String(row.callee_expression),
    calleeLocalName: String(evidence.targetName),
    importSource: typeof row.import_source === 'string'
      ? row.import_source : undefined,
    sourceFile: String(row.source_file),
    sourceLine: Number(row.source_line),
    callSiteStartOffset: nullableNumber(row.call_site_start_offset)
      ?? undefined,
    callSiteEndOffset: nullableNumber(row.call_site_end_offset) ?? undefined,
    callRole: row.call_role === 'event_subscribe_handler'
      ? 'event_subscribe_handler' : 'ordinary_call',
    evidence,
  };
}

function resolutionMatches(db: Db, row: PersistedSymbolCall): boolean {
  const expected = resolveSymbolCallTarget(db, row.repoId, row.fact);
  const evidence = row.fact.evidence;
  return allValid([
    row.status === expected.status,
    row.calleeId === expected.id,
    row.reason === expected.reason,
    evidence.candidateStrategy === expected.strategy,
    evidence.candidateCount === expected.candidateCount,
    evidence.eligibleCandidateCount === expected.eligibleCandidateCount,
    evidence.selectedCandidateCount
      === (expected.status === 'resolved' ? 1 : 0),
    evidence.candidateSetComplete === expected.candidateSetComplete,
    evidence.resolvedModulePath === expected.resolvedModulePath,
    evidence.unresolvedReason === expected.reason,
  ]);
}

export function invalidSymbolFactCategories(
  db: Db,
  workspaceId?: number,
): SymbolFactCategoryCount[] {
  const rows = genericRows(db, workspaceId);
  const invalid = rows.malformedCount + rows.calls
    .filter((row) => !resolutionMatches(db, row)).length;
  return invalid > 0
    ? [{ category: 'symbol_call_resolution_proof_invalid', count: invalid }]
    : [];
}
