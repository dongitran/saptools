import type { Db } from '../db/connection.js';
import {
  parsePackageImportReference,
  parsePackagePublicSurfaceFact,
} from '../parsers/package-fact-contract.js';
import type {
  PackagePublicSurfaceFact,
} from '../parsers/package-public-surface.js';
import type {
  SymbolImportReference,
} from '../parsers/symbol-import-bindings.js';

export interface PackageEventConstantLinkSummary {
  resolved: number;
  ambiguous: number;
  unresolved: number;
}

interface EventConstantCall {
  id: number;
  binding: SymbolImportReference;
  evidence: Record<string, unknown>;
}

interface PackageRepository {
  id: number;
  surface: PackagePublicSurfaceFact;
}

export interface PackageEventConstantResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  reason?: string;
  value?: string;
  sourceFile?: string;
  sourceLine?: number;
  targetRepoId?: number;
  modulePath?: string;
  candidateCount: number;
  eligibleCandidateCount: number;
  complete: boolean;
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

function callRows(db: Db, workspaceId: number): EventConstantCall[] {
  const rows = db.prepare(`SELECT c.id,c.evidence_json evidenceJson
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    WHERE r.workspace_id=?
      AND c.call_type IN ('async_emit','async_subscribe')
      AND json_extract(c.evidence_json,
        '$.eventNameConstantImportBinding.moduleKind')='package'
    ORDER BY c.id`).all(workspaceId);
  return rows.flatMap((row) => {
    const evidence = jsonRecord(row.evidenceJson);
    const binding = parsePackageImportReference(
      evidence?.eventNameConstantImportBinding,
    );
    return typeof row.id === 'number' && evidence && binding
      ? [{ id: row.id, evidence, binding }] : [];
  });
}

function parseSurface(
  value: unknown,
  packageName: string,
): PackagePublicSurfaceFact | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parsePackagePublicSurfaceFact(
      JSON.parse(value) as unknown, packageName,
    );
  } catch {
    return undefined;
  }
}

function repositories(
  db: Db,
  workspaceId: number,
  packageName: string,
): PackageRepository[] {
  return db.prepare(`SELECT id,package_public_surface_json surfaceJson
    FROM repositories WHERE workspace_id=? AND package_name=?
    ORDER BY id`).all(workspaceId, packageName).flatMap((row) => {
    const surface = parseSurface(row.surfaceJson, packageName);
    return typeof row.id === 'number' && surface
      ? [{ id: row.id, surface }] : [];
  });
}

function failure(
  reason: string,
  fields: Partial<PackageEventConstantResolution> = {},
): PackageEventConstantResolution {
  return {
    status: reason === 'event_name_constant_container_ambiguous'
      ? 'ambiguous' : 'unresolved',
    reason,
    candidateCount: 0,
    eligibleCandidateCount: 0,
    complete: true,
    ...fields,
  };
}

function entryModule(
  repository: PackageRepository,
  binding: SymbolImportReference,
): string | PackageEventConstantResolution {
  const surface = repository.surface;
  if (surface.status !== 'complete' || surface.omitted > 0) return failure(
    'event_name_constant_container_ambiguous', { complete: false },
  );
  const matches = surface.entries.filter((entry) =>
    entry.entry === binding.requestedModuleSubpath);
  return matches.length === 1 && matches[0]
    ? matches[0].modulePath
    : failure('event_name_constant_container_ambiguous', {
        complete: matches.length === 0 && surface.omitted === 0,
      });
}

function moduleFile(sourceFile: string): string {
  return sourceFile.replace(/\.(?:d\.)?(?:ts|js)$/, '');
}

function constantRows(
  db: Db,
  repoId: number,
  modulePath: string,
  publicName: string,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id,source_file sourceFile,
    source_line sourceLine,value,exported,stable,
    resolution_status resolutionStatus,unresolved_reason unresolvedReason
    FROM generated_constants
    WHERE repo_id=? AND name=?
    ORDER BY source_file COLLATE BINARY,declaration_start_offset,id`).all(
    repoId, publicName,
  ).filter((row) =>
    typeof row.sourceFile === 'string'
    && moduleFile(row.sourceFile) === modulePath);
}

function resolveRows(
  rows: Array<Record<string, unknown>>,
  repoId: number,
  modulePath: string,
): PackageEventConstantResolution {
  const fields = {
    targetRepoId: repoId,
    modulePath,
    candidateCount: rows.length,
    complete: true,
  };
  if (rows.length !== 1 || !rows[0]) return failure(
    'event_name_constant_container_ambiguous',
    fields,
  );
  const row = rows[0];
  if (Number(row.exported) !== 1) return failure(
    'event_name_constant_container_not_exported', fields,
  );
  if (Number(row.stable) !== 1) return failure(
    constantRefusalReason(row), fields,
  );
  if (row.resolutionStatus !== 'resolved'
    || typeof row.value !== 'string') return failure(
    constantRefusalReason(row),
    fields,
  );
  if (row.value.length === 0) return failure(
    'event_name_constant_value_empty', fields,
  );
  return {
    ...fields,
    status: 'resolved',
    value: row.value,
    sourceFile: String(row.sourceFile),
    sourceLine: Number(row.sourceLine),
    eligibleCandidateCount: 1,
  };
}

function constantRefusalReason(row: Record<string, unknown>): string {
  const reason = String(row.unresolvedReason ?? '');
  if ([
    'event_name_constant_container_mutable',
    'event_name_constant_container_unsafe_reference',
    'event_name_constant_container_unsupported_shape',
    'event_name_constant_member_not_string',
  ].includes(reason)) return reason;
  return Number(row.stable) === 1
    ? 'event_name_constant_member_not_string'
    : 'event_name_constant_container_unsafe_reference';
}

function resolveCall(
  db: Db,
  workspaceId: number,
  call: EventConstantCall,
): PackageEventConstantResolution {
  const packageName = call.binding.requestedPackageName ?? '';
  const matches = repositories(db, workspaceId, packageName);
  if (matches.length !== 1 || !matches[0]) return failure(
    'event_name_constant_container_ambiguous',
    { candidateCount: matches.length, complete: matches.length === 0 },
  );
  const module = entryModule(matches[0], call.binding);
  if (typeof module !== 'string') return {
    ...module, targetRepoId: matches[0].id,
  };
  return resolveRows(
    constantRows(
      db, matches[0].id, module, call.binding.requestedPublicName,
    ),
    matches[0].id,
    module,
  );
}

export function expectedPackageEventConstantResolution(
  db: Db,
  workspaceId: number,
  binding: SymbolImportReference,
): PackageEventConstantResolution {
  return resolveCall(db, workspaceId, {
    id: 0,
    binding,
    evidence: {},
  });
}

function resolutionEvidence(
  call: EventConstantCall,
  resolution: PackageEventConstantResolution,
): string {
  const evidence = { ...call.evidence };
  delete evidence.eventNameUnresolvedReason;
  delete evidence.eventNameStatus;
  delete evidence.eventNameSourceKind;
  delete evidence.eventNamePlaceholderKeys;
  if (resolution.status !== 'resolved')
    evidence.eventNameUnresolvedReason = resolution.reason;
  return JSON.stringify({
    ...evidence,
    ...(resolution.status === 'resolved' ? {
      eventNameConstant: {
        sourceKind: 'package_static_string',
        sourceFile: resolution.sourceFile,
        sourceLine: resolution.sourceLine,
      },
    } : {}),
    eventNamePackageConstantResolution: {
      status: resolution.status,
      reason: resolution.reason,
      candidateCount: resolution.candidateCount,
      eligibleCandidateCount: resolution.eligibleCandidateCount,
      selectedCandidateCount: resolution.status === 'resolved' ? 1 : 0,
      candidateSetComplete: resolution.complete,
      requestedPackageName: call.binding.requestedPackageName,
      requestedModuleSubpath: call.binding.requestedModuleSubpath,
      requestedPublicName: call.binding.requestedPublicName,
      resolvedModulePath: resolution.modulePath,
      targetRepositoryId: resolution.targetRepoId,
    },
  });
}

export function linkPackageEventConstants(
  db: Db,
  workspaceId: number,
): PackageEventConstantLinkSummary {
  const summary = { resolved: 0, ambiguous: 0, unresolved: 0 };
  const update = db.prepare(`UPDATE outbound_calls SET event_name_expr=?,
    unresolved_reason=?,evidence_json=? WHERE id=?`);
  for (const call of callRows(db, workspaceId)) {
    const resolution = resolveCall(db, workspaceId, call);
    const reason = resolution.reason ?? null;
    const sourceExpression = call.evidence.eventNameConstantSourceExpression;
    update.run(
      resolution.value ?? String(sourceExpression ?? ''),
      reason,
      resolutionEvidence(call, resolution),
      call.id,
    );
    summary[resolution.status] += 1;
  }
  return summary;
}
