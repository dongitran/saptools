import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';
import {
  EVENT_ENVIRONMENT_KEY_ALLOWLIST,
  parseEnvironmentDeclarationsFact,
} from '../parsers/environment-declarations.js';
import type {
  EventEnvironmentReference,
} from '../parsers/event-environment-reference.js';
import { parseEventSkeletonFact } from '../utils/event-skeleton.js';
import { parsePackageImportReference } from
  '../parsers/package-fact-contract.js';
import {
  expectedPackageEventConstantResolution,
  type PackageEventConstantResolution,
} from '../linker/package-event-constant-resolver.js';

export interface EventFactSemanticCategoryCount {
  category: string;
  count: number;
}

interface EventFactRow extends Record<string, unknown> {
  workspaceId?: number;
  eventName?: string;
  skeletonSignature?: string | null;
  skeletonJson?: string | null;
  unresolvedReason?: string | null;
  evidenceJson?: string;
}

const receiverReasons = new Set([
  'event_receiver_unproven_binding',
  'event_receiver_unproven_propagation',
  'event_receiver_not_cap_client',
]);
const constantReasons = new Set([
  'event_name_constant_container_ambiguous',
  'event_name_constant_member_not_string',
  'event_name_constant_container_mutable',
  'event_name_constant_container_not_exported',
  'event_name_constant_resolution_pending',
]);
const environmentKeys = new Set<string>(EVENT_ENVIRONMENT_KEY_ALLOWLIST);

function category(
  name: string,
  count: number,
): EventFactSemanticCategoryCount[] {
  return count > 0 ? [{ category: name, count }] : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function currentEventRows(
  db: Db,
  workspaceId?: number,
): EventFactRow[] {
  return db.prepare(`SELECT fact.event_name_expr eventName,
    r.workspace_id workspaceId,
    fact.event_skeleton_signature skeletonSignature,
    fact.event_skeleton_json skeletonJson,
    fact.unresolved_reason unresolvedReason,
    fact.evidence_json evidenceJson
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND fact.call_type IN ('async_emit','async_subscribe')`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  ) as EventFactRow[];
}

function integerField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const item = value[key];
  return Number.isInteger(item) && Number(item) >= 0
    ? Number(item) : undefined;
}

function packagePendingValid(
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const source = evidence.eventNameConstantSourceExpression;
  return evidence.eventNameUnresolvedReason
      === 'event_name_constant_resolution_pending'
    && evidence.eventNamePackageConstantResolution === undefined
    && typeof source === 'string' && source.length > 0
    && row.eventName === source;
}

function resolutionFieldsValid(
  value: Record<string, unknown>,
  expected: PackageEventConstantResolution,
): boolean {
  return value.status === expected.status
    && value.reason === expected.reason
    && integerField(value, 'candidateCount') === expected.candidateCount
    && integerField(value, 'eligibleCandidateCount')
      === expected.eligibleCandidateCount
    && integerField(value, 'selectedCandidateCount')
      === (expected.status === 'resolved' ? 1 : 0)
    && value.candidateSetComplete === expected.complete
    && value.resolvedModulePath === expected.modulePath
    && value.targetRepositoryId === expected.targetRepoId;
}

function packageTerminalValid(
  db: Db,
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const binding = parsePackageImportReference(
    evidence.eventNameConstantImportBinding,
  );
  const workspaceId = row.workspaceId;
  const resolution = record(evidence.eventNamePackageConstantResolution);
  if (!binding || typeof workspaceId !== 'number' || !resolution)
    return false;
  const expected = expectedPackageEventConstantResolution(
    db, workspaceId, binding,
  );
  const source = evidence.eventNameConstantSourceExpression;
  const expectedName = expected.value ?? source;
  const expectedReason = expected.status === 'resolved'
    ? undefined : expected.reason;
  if (row.eventName !== expectedName
    || evidence.eventNameUnresolvedReason !== expectedReason
    || !resolutionFieldsValid(resolution, expected)) return false;
  if (expected.status !== 'resolved') return true;
  const constant = record(evidence.eventNameConstant);
  return constant?.sourceKind === 'package_static_string'
    && constant.sourceFile === expected.sourceFile
    && constant.sourceLine === expected.sourceLine;
}

function packageConstantValid(
  db: Db,
  row: EventFactRow,
  evidence: Record<string, unknown>,
  phase: 'pre_package' | 'terminal',
): boolean {
  if (evidence.eventNameConstantImportBinding === undefined) return true;
  const binding = parsePackageImportReference(
    evidence.eventNameConstantImportBinding,
  );
  const source = evidence.eventNameConstantSourceExpression;
  if (!binding || typeof source !== 'string' || source.length === 0)
    return false;
  if (packagePendingValid(row, evidence))
    return phase === 'pre_package';
  return packageTerminalValid(db, row, evidence);
}

function receiverEvidenceValid(
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const classification = evidence.receiverClassification;
  const proof = evidence.receiverProof;
  if (!['cap_evidence', 'name_fallback', 'unproven'].includes(
    String(classification),
  ) || typeof proof !== 'string' || proof.length === 0
    || !Array.isArray(evidence.consideredBindingSites)
    || evidence.consideredBindingSites.length > 8) return false;
  if (classification === 'name_fallback')
    return proof === 'compatibility_name_fallback';
  if (classification !== 'unproven') return true;
  return typeof row.unresolvedReason === 'string'
    && receiverReasons.has(row.unresolvedReason);
}

function environmentBindingValid(
  binding: EventEnvironmentReference,
  sourceKeys: readonly string[],
): boolean {
  if (!['resolved', 'refused'].includes(binding.status)
    || !sourceKeys.includes(binding.sourceKey)
    || !Array.isArray(binding.transforms)
    || !binding.transforms.every((item) =>
      item === 'toUpperCase' || item === 'toLowerCase')) return false;
  if (binding.status === 'refused')
    return typeof binding.reason === 'string' && binding.reason.length > 0;
  return typeof binding.environmentKey === 'string'
    && environmentKeys.has(binding.environmentKey)
    && typeof binding.sourceFile === 'string' && binding.sourceFile.length > 0
    && Number.isInteger(binding.startOffset)
    && Number(binding.startOffset) >= 0
    && Number.isInteger(binding.endOffset)
    && Number(binding.endOffset) > Number(binding.startOffset);
}

function skeletonValid(
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const reason = evidence.eventNameUnresolvedReason;
  if (reason !== 'dynamic_event_name_identifier')
    return row.skeletonSignature == null && row.skeletonJson == null;
  const skeleton = parseEventSkeletonFact(row.skeletonJson);
  if (!skeleton || skeleton.status !== 'complete'
    || row.skeletonSignature !== skeleton.signature
    || !skeleton.environmentBindings.every((binding) =>
      environmentBindingValid(binding, skeleton.sourceKeys))) return false;
  const keys = evidence.eventNamePlaceholderKeys;
  return Array.isArray(keys)
    && JSON.stringify(keys) === JSON.stringify(skeleton.sourceKeys);
}

function eventReasonValid(
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const eventReason = evidence.eventNameUnresolvedReason;
  if (receiverReasons.has(String(row.unresolvedReason)))
    return eventReason === undefined
      || eventReason === 'dynamic_event_name_identifier'
      || eventReason === 'dynamic_event_name_unsupported_expression'
      || constantReasons.has(String(eventReason));
  if (eventReason === undefined) return row.unresolvedReason == null;
  if (eventReason === 'dynamic_event_name_identifier'
    || eventReason === 'dynamic_event_name_unsupported_expression'
    || constantReasons.has(String(eventReason)))
    return row.unresolvedReason === eventReason;
  return false;
}

function invalidEventRows(
  db: Db,
  workspaceId?: number,
  phase: 'pre_package' | 'terminal' = 'pre_package',
): number {
  return currentEventRows(db, workspaceId).filter((row) => {
    if (typeof row.eventName !== 'string' || row.eventName.length === 0)
      return false;
    const evidence = jsonRecord(row.evidenceJson);
    return !evidence
      || !receiverEvidenceValid(row, evidence)
      || !eventReasonValid(row, evidence)
      || !packageConstantValid(db, row, evidence, phase)
      || !skeletonValid(row, evidence);
  }).length;
}

function invalidEnvironmentRepositories(
  db: Db,
  workspaceId?: number,
): number {
  const rows = db.prepare(`SELECT environment_declarations_json value
    FROM repositories WHERE fact_analyzer_version=?
      AND (? IS NULL OR workspace_id=?)`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.filter((row) =>
    !parseEnvironmentDeclarationsFact(row.value)).length;
}

function generatedConstantInvalid(row: Record<string, unknown>): boolean {
  const kind = String(row.constantKind);
  const container = row.containerName;
  const member = row.memberName;
  const name = row.name;
  const memberShape = kind === 'const_identifier'
    ? container == null && member == null
    : typeof container === 'string' && container.length > 0
      && typeof member === 'string' && member.length > 0
      && name === `${container}.${member}`;
  const resolved = row.resolutionStatus === 'resolved';
  const refused = row.resolutionStatus === 'refused';
  return !['const_identifier', 'enum_member', 'const_object_property']
    .includes(kind)
    || typeof name !== 'string' || name.length === 0
    || (!resolved && !refused)
    || (resolved && (typeof row.value !== 'string'
      || row.value.length === 0 || row.unresolvedReason != null))
    || (refused && (row.value != null
      || !constantReasons.has(String(row.unresolvedReason))))
    || typeof row.sourceFile !== 'string' || row.sourceFile.length === 0
    || !Number.isInteger(row.sourceLine) || Number(row.sourceLine) < 1
    || ![0, 1].includes(Number(row.exported))
    || ![0, 1].includes(Number(row.stable))
    || !validConstantOffsets(row) || !memberShape;
}

function validConstantOffsets(row: Record<string, unknown>): boolean {
  const start = row.declarationStartOffset;
  const end = row.declarationEndOffset;
  const valueStart = row.valueStartOffset;
  const valueEnd = row.valueEndOffset;
  return Number.isInteger(start) && Number(start) >= 0
    && Number.isInteger(end) && Number(end) > Number(start)
    && Number.isInteger(valueStart) && Number(valueStart) >= Number(start)
    && Number.isInteger(valueEnd) && Number(valueEnd) > Number(valueStart)
    && Number(valueEnd) <= Number(end);
}

function invalidGeneratedConstants(
  db: Db,
  workspaceId?: number,
): number {
  const rows = db.prepare(`SELECT fact.source_file sourceFile,
    fact.source_line sourceLine,fact.name,fact.container_name containerName,
    fact.member_name memberName,fact.value,
    fact.constant_kind constantKind,fact.exported,fact.stable,
    fact.resolution_status resolutionStatus,
    fact.unresolved_reason unresolvedReason,
    fact.declaration_start_offset declarationStartOffset,
    fact.declaration_end_offset declarationEndOffset,
    fact.value_start_offset valueStartOffset,
    fact.value_end_offset valueEndOffset
    FROM generated_constants fact
    JOIN repositories r ON r.id=fact.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.filter(generatedConstantInvalid).length;
}

export function invalidEventFactCategories(
  db: Db,
  workspaceId?: number,
  phase: 'pre_package' | 'terminal' = 'pre_package',
): EventFactSemanticCategoryCount[] {
  return [
    ...category('event_fact_semantics_invalid',
      invalidEventRows(db, workspaceId, phase)),
    ...category('repository_environment_declarations_invalid',
      invalidEnvironmentRepositories(db, workspaceId)),
    ...category('generated_constant_fact_invalid',
      invalidGeneratedConstants(db, workspaceId)),
  ];
}
