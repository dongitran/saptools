import type { Db } from './connection.js';
import { ANALYZER_VERSION } from '../version.js';
import {
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
  id?: number;
  repoId?: number;
  repositoryName?: string;
  workspaceId?: number;
  sourceFile?: string;
  sourceLine?: number;
  eventName?: string;
  skeletonSignature?: string | null;
  skeletonJson?: string | null;
  unresolvedReason?: string | null;
  evidenceJson?: string;
  environmentJson?: string | null;
}

export interface InvalidEventFactExample {
  category: string;
  repositoryId: number;
  repositoryName: string;
  sourceFile?: string;
  sourceLine?: number;
  factId?: number;
  failingPredicate: string;
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
  'event_name_constant_container_unsafe_reference',
  'event_name_constant_container_unsupported_shape',
  'event_name_constant_container_not_exported',
  'event_name_constant_resolution_pending',
  'event_name_constant_value_empty',
]);
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
  return db.prepare(`SELECT fact.id,fact.repo_id repoId,r.name repositoryName,
    fact.source_file sourceFile,fact.source_line sourceLine,
    fact.event_name_expr eventName,
    r.workspace_id workspaceId,
    fact.event_skeleton_signature skeletonSignature,
    fact.event_skeleton_json skeletonJson,
    fact.unresolved_reason unresolvedReason,
    fact.evidence_json evidenceJson,
    r.environment_declarations_json environmentJson
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE r.fact_analyzer_version=?
      AND (? IS NULL OR r.workspace_id=?)
      AND fact.call_type IN ('async_emit','async_subscribe')`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  ) as EventFactRow[];
}

function eventInvalidPredicate(
  db: Db,
  row: EventFactRow,
  phase: 'pre_package' | 'terminal',
): string | undefined {
  if (typeof row.eventName !== 'string' || row.eventName.length === 0)
    return 'event_name_non_empty';
  const evidence = jsonRecord(row.evidenceJson);
  if (!evidence) return 'event_evidence_valid_json_object';
  if (!receiverEvidenceValid(evidence))
    return 'event_receiver_evidence_consistent';
  if (!eventReasonValid(row, evidence))
    return 'event_name_reason_axis_consistent';
  if (!packageConstantValid(db, row, evidence, phase))
    return 'event_package_constant_resolution_consistent';
  return skeletonValid(row, evidence)
    ? undefined : 'event_skeleton_complete_and_signed';
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
  evidence: Record<string, unknown>,
): boolean {
  const classification = evidence.receiverClassification;
  const proof = evidence.receiverProof;
  if (!receiverEvidenceShapeValid(classification, proof, evidence))
    return false;
  if (classification === 'name_fallback')
    return fallbackReceiverEvidenceValid(proof, evidence);
  if (classification !== 'unproven')
    return evidence.receiverUnresolvedReason === undefined
      && evidence.receiverFallbackRefusedReason === undefined;
  return evidence.receiverFallbackRefusedReason === undefined
    && typeof evidence.receiverUnresolvedReason === 'string'
    && receiverReasons.has(evidence.receiverUnresolvedReason);
}

function receiverEvidenceShapeValid(
  classification: unknown,
  proof: unknown,
  evidence: Record<string, unknown>,
): boolean {
  const sites = evidence.consideredBindingSites;
  return ['cap_evidence', 'name_fallback', 'unproven'].includes(
    String(classification),
  ) && typeof proof === 'string' && proof.length > 0
    && Array.isArray(sites) && sites.length <= 8;
}

function fallbackReceiverEvidenceValid(
  proof: unknown,
  evidence: Record<string, unknown>,
): boolean {
  const reason = evidence.receiverFallbackRefusedReason;
  return proof === 'compatibility_name_fallback'
    && evidence.receiverUnresolvedReason === undefined
    && typeof reason === 'string' && reason.length > 0;
}

function environmentBindingValid(
  binding: EventEnvironmentReference,
  sourceKeys: readonly string[],
  allowedKeys: ReadonlySet<string>,
): boolean {
  if (!['resolved', 'refused'].includes(binding.status)
    || !sourceKeys.includes(binding.sourceKey)
    || !environmentTransformsValid(binding.transforms)) return false;
  if (binding.status === 'refused')
    return typeof binding.reason === 'string' && binding.reason.length > 0;
  return resolvedEnvironmentBindingValid(binding, allowedKeys);
}

function environmentTransformsValid(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) =>
    item === 'toUpperCase' || item === 'toLowerCase');
}

function resolvedEnvironmentBindingValid(
  binding: EventEnvironmentReference,
  allowedKeys: ReadonlySet<string>,
): boolean {
  const key = binding.environmentKey;
  const file = binding.sourceFile;
  return typeof key === 'string' && allowedKeys.has(key)
    && typeof file === 'string' && file.length > 0
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
  const environment = parseEnvironmentDeclarationsFact(row.environmentJson);
  if (!skeleton || skeleton.status !== 'complete'
    || !environment
    || row.skeletonSignature !== skeleton.signature
    || !skeleton.environmentBindings.every((binding) =>
      environmentBindingValid(
        binding, skeleton.sourceKeys, new Set(environment.allowedKeys),
      ))) return false;
  const keys = evidence.eventNamePlaceholderKeys;
  return Array.isArray(keys)
    && JSON.stringify(keys) === JSON.stringify(skeleton.sourceKeys);
}

function eventReasonValid(
  row: EventFactRow,
  evidence: Record<string, unknown>,
): boolean {
  const eventReason = evidence.eventNameUnresolvedReason;
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
  return currentEventRows(db, workspaceId).filter((row) =>
    eventInvalidPredicate(db, row, phase) !== undefined).length;
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

function generatedConstantInvalidPredicate(
  row: Record<string, unknown>,
): string | undefined {
  const kind = String(row.constantKind);
  if (!['const_identifier', 'enum_member', 'const_object_property']
    .includes(kind)) return 'generated_constant_kind_known';
  if (typeof row.name !== 'string' || row.name.length === 0)
    return 'generated_constant_name_non_empty';
  const status = generatedConstantStatusInvalid(row);
  if (status) return status;
  const source = generatedConstantSourceInvalid(row);
  if (source) return source;
  if (!validConstantOffsets(row)) return 'generated_constant_offsets_valid';
  return generatedConstantMemberShapeValid(row, kind)
    ? undefined : 'generated_constant_member_shape_valid';
}

function generatedConstantStatusInvalid(
  row: Record<string, unknown>,
): string | undefined {
  const resolved = row.resolutionStatus === 'resolved';
  const refused = row.resolutionStatus === 'refused';
  if (!resolved && !refused) return 'generated_constant_status_known';
  if (resolved && (typeof row.value !== 'string'
    || row.unresolvedReason != null))
    return 'generated_constant_resolved_value_consistent';
  return refused && (row.value != null
    || !constantReasons.has(String(row.unresolvedReason)))
    ? 'generated_constant_refusal_consistent' : undefined;
}

function generatedConstantSourceInvalid(
  row: Record<string, unknown>,
): string | undefined {
  if (typeof row.sourceFile !== 'string' || row.sourceFile.length === 0
    || !Number.isInteger(row.sourceLine) || Number(row.sourceLine) < 1)
    return 'generated_constant_source_location_valid';
  return [0, 1].includes(Number(row.exported))
    && [0, 1].includes(Number(row.stable))
    ? undefined : 'generated_constant_flags_boolean';
}

function generatedConstantMemberShapeValid(
  row: Record<string, unknown>,
  kind: string,
): boolean {
  if (kind === 'const_identifier')
    return row.containerName == null && row.memberName == null;
  const container = row.containerName;
  const member = row.memberName;
  return typeof container === 'string' && container.length > 0
    && typeof member === 'string' && member.length > 0
    && row.name === `${container}.${member}`;
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
  const rows = generatedConstantRows(db, workspaceId);
  return rows.filter((row) =>
    generatedConstantInvalidPredicate(row) !== undefined).length;
}

function generatedConstantRows(
  db: Db,
  workspaceId?: number,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT fact.id,fact.repo_id repoId,
    r.name repositoryName,fact.source_file sourceFile,
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
}

function eventFactExamples(
  db: Db,
  workspaceId: number | undefined,
  phase: 'pre_package' | 'terminal',
): InvalidEventFactExample[] {
  return currentEventRows(db, workspaceId).flatMap((row) => {
    const predicate = eventInvalidPredicate(db, row, phase);
    return predicate && typeof row.repoId === 'number'
      && typeof row.repositoryName === 'string'
      ? [{
          category: 'event_fact_semantics_invalid',
          repositoryId: row.repoId,
          repositoryName: row.repositoryName,
          sourceFile: row.sourceFile,
          sourceLine: row.sourceLine,
          factId: row.id,
          failingPredicate: predicate,
        }] : [];
  });
}

function generatedConstantExamples(
  db: Db,
  workspaceId?: number,
): InvalidEventFactExample[] {
  return generatedConstantRows(db, workspaceId).flatMap((row) => {
    const predicate = generatedConstantInvalidPredicate(row);
    return predicate && typeof row.repoId === 'number'
      && typeof row.repositoryName === 'string'
      ? [{
          category: 'generated_constant_fact_invalid',
          repositoryId: row.repoId,
          repositoryName: row.repositoryName,
          sourceFile: typeof row.sourceFile === 'string'
            ? row.sourceFile : undefined,
          sourceLine: typeof row.sourceLine === 'number'
            ? row.sourceLine : undefined,
          factId: typeof row.id === 'number' ? row.id : undefined,
          failingPredicate: predicate,
        }] : [];
  });
}

function environmentExamples(
  db: Db,
  workspaceId?: number,
): InvalidEventFactExample[] {
  const rows = db.prepare(`SELECT id repositoryId,name repositoryName,
    environment_declarations_json value FROM repositories
    WHERE fact_analyzer_version=?
      AND (? IS NULL OR workspace_id=?)
    ORDER BY name COLLATE BINARY,id`).all(
    ANALYZER_VERSION, workspaceId, workspaceId,
  );
  return rows.flatMap((row) =>
    !parseEnvironmentDeclarationsFact(row.value)
      && typeof row.repositoryId === 'number'
      && typeof row.repositoryName === 'string'
      ? [{
          category: 'repository_environment_declarations_invalid',
          repositoryId: row.repositoryId,
          repositoryName: row.repositoryName,
          failingPredicate: 'environment_declarations_fact_valid',
        }] : []);
}

function compareExample(
  left: InvalidEventFactExample,
  right: InvalidEventFactExample,
): number {
  const leftKey = `${left.repositoryName}\0${left.sourceFile ?? ''}\0${
    left.sourceLine ?? 0}\0${left.category}\0${left.factId ?? 0}`;
  const rightKey = `${right.repositoryName}\0${right.sourceFile ?? ''}\0${
    right.sourceLine ?? 0}\0${right.category}\0${right.factId ?? 0}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function invalidEventFactExamples(
  db: Db,
  workspaceId?: number,
  phase: 'pre_package' | 'terminal' = 'pre_package',
  limit = 5,
): {
  total: number;
  affectedRepositoryCount: number;
  examples: InvalidEventFactExample[];
} {
  const all = [
    ...eventFactExamples(db, workspaceId, phase),
    ...generatedConstantExamples(db, workspaceId),
    ...environmentExamples(db, workspaceId),
  ].sort(compareExample);
  return {
    total: all.length,
    affectedRepositoryCount:
      new Set(all.map((item) => item.repositoryId)).size,
    examples: all.slice(0, Math.max(0, limit)),
  };
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
