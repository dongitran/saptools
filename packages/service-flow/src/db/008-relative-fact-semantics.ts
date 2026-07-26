import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';
import {
  resolveRelativeSymbolCall,
} from './006-relative-symbol-resolution.js';
import type { SymbolCallFact } from '../types.js';
import { parseRelativeImportReference } from
  '../parsers/012-package-fact-contract.js';
import type { SymbolImportReference } from
  '../parsers/002-symbol-import-bindings.js';

export interface RelativeFactCategoryCount {
  category: string;
  count: number;
}

interface PersistedRelativeCall {
  repoId: number;
  calleeId: number | null;
  status: string;
  reason: string | null;
  fact: SymbolCallFact;
}

interface PersistedRelativeRows {
  calls: PersistedRelativeCall[];
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

function all(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function memberReference(binding: SymbolImportReference): boolean {
  return binding.referenceShape !== 'identifier'
    && typeof binding.referencedMemberName === 'string'
    && binding.referencedMemberName.length > 0;
}

function directRelativeProvenance(
  evidence: Record<string, unknown>,
  binding: SymbolImportReference,
  targetName: string,
): boolean {
  if (evidence.relation !== 'relative_import') return false;
  return binding.referenceShape !== 'namespace_member'
    && targetName === binding.requestedPublicName;
}

function namespaceRelativeProvenance(
  evidence: Record<string, unknown>,
  binding: SymbolImportReference,
  targetName: string,
): boolean {
  if (evidence.relation !== 'relative_import_namespace_member') return false;
  return binding.referenceShape === 'namespace_member'
    && targetName === binding.requestedPublicName;
}

function derivedRelativeProvenance(
  evidence: Record<string, unknown>,
  binding: SymbolImportReference,
  targetName: string,
): boolean {
  if (!memberReference(binding)) return false;
  if (evidence.relation === 'class_instance_method')
    return targetName === binding.requestedPublicName
      && evidence.methodName === binding.referencedMemberName;
  if (evidence.relation !== 'relative_import_proxy_member') return false;
  return targetName === binding.referencedMemberName
    && typeof evidence.proxyVariableName === 'string';
}

function relativeProvenanceValid(
  evidence: Record<string, unknown>,
  binding: SymbolImportReference,
  targetName: string,
): boolean {
  return directRelativeProvenance(evidence, binding, targetName)
    || namespaceRelativeProvenance(evidence, binding, targetName)
    || derivedRelativeProvenance(evidence, binding, targetName);
}

function relativeRows(
  db: Db,
  workspaceId?: number,
): PersistedRelativeRows {
  const rows = db.prepare(`SELECT sc.*,r.workspace_id workspaceId
    FROM symbol_calls sc JOIN repositories r ON r.id=sc.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND (sc.import_source LIKE '.%'
        OR json_extract(sc.evidence_json,
          '$.importBinding.moduleKind')='relative')
    ORDER BY sc.id`).all(ANALYZER_VERSION, workspaceId, workspaceId);
  const parsed = rows.map(persistedRelativeCall);
  return {
    calls: parsed.flatMap((call) => call ? [call] : []),
    malformedCount: parsed.filter((call) => !call).length,
  };
}

function persistedRelativeCall(
  row: Record<string, unknown>,
): PersistedRelativeCall | undefined {
  const evidence = parseRecord(row.evidence_json);
  const targetName = evidence?.targetName;
  const binding = evidence
    ? parseRelativeImportReference(evidence.importBinding)
    : undefined;
  if (!evidence || !binding || typeof targetName !== 'string') return undefined;
  if (!all([
    typeof row.repo_id === 'number',
    typeof row.source_file === 'string',
    typeof row.source_line === 'number',
    typeof row.callee_expression === 'string',
    typeof row.call_role === 'string',
    typeof row.status === 'string',
    typeof evidence.caller === 'string',
    row.import_source === binding.rawModuleSpecifier,
    relativeProvenanceValid(evidence, binding, targetName),
  ])) return undefined;
  return persistedCallValue(row, evidence, targetName);
}

function persistedCallValue(
  row: Record<string, unknown>,
  evidence: Record<string, unknown>,
  targetName: string,
): PersistedRelativeCall {
  return {
    repoId: Number(row.repo_id),
    calleeId: nullableNumber(row.callee_symbol_id),
    status: String(row.status),
    reason: typeof row.unresolved_reason === 'string'
      ? row.unresolved_reason : null,
    fact: {
      callerQualifiedName: String(evidence.caller ?? ''),
      calleeExpression: String(row.callee_expression),
      calleeLocalName: targetName,
      importSource: String(row.import_source),
      sourceFile: String(row.source_file),
      sourceLine: Number(row.source_line),
      callSiteStartOffset: nullableNumber(row.call_site_start_offset)
        ?? undefined,
      callSiteEndOffset: nullableNumber(row.call_site_end_offset)
        ?? undefined,
      callRole: row.call_role === 'event_subscribe_handler'
        ? 'event_subscribe_handler' : 'ordinary_call',
      evidence,
    },
  };
}

function resolutionMatches(db: Db, row: PersistedRelativeCall): boolean {
  const relation = row.fact.evidence.relation;
  const expected = resolveRelativeSymbolCall(
    db, row.repoId, row.fact, relation,
  );
  if (!expected) return false;
  return all([
    row.status === expected.status,
    row.calleeId === expected.id,
    row.reason === expected.reason,
    row.fact.evidence.candidateStrategy === expected.strategy,
    row.fact.evidence.candidateCount === expected.candidateCount,
    row.fact.evidence.eligibleCandidateCount
      === expected.eligibleCandidateCount,
    row.fact.evidence.selectedCandidateCount
      === (expected.status === 'resolved' ? 1 : 0),
    row.fact.evidence.candidateSetComplete
      === expected.candidateSetComplete,
    row.fact.evidence.resolvedModulePath
      === expected.resolvedModulePath,
    row.fact.evidence.unresolvedReason === expected.reason,
  ]);
}

export function invalidRelativeFactCategories(
  db: Db,
  workspaceId?: number,
): RelativeFactCategoryCount[] {
  const rows = relativeRows(db, workspaceId);
  const invalid = rows.malformedCount + rows.calls
    .filter((row) => !resolutionMatches(db, row)).length;
  return invalid > 0
    ? [{ category: 'relative_import_resolution_proof_invalid', count: invalid }]
    : [];
}
