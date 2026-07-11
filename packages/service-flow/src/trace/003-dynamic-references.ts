import type { Db } from '../db/connection.js';
import {
  projectBounded,
  type BoundedProjection,
} from '../utils/000-bounded-projection.js';
import type { DynamicVariableProvenance } from './000-dynamic-target-types.js';

export interface DynamicReferenceRow {
  bindingId?: number;
  alias?: string;
  aliasExpr?: string;
  destination?: string;
  servicePath?: string;
  sourceKind: 'service_binding' | 'cds_require';
  selection: 'selected_binding' | 'selected_binding_require' | 'fallback';
  repoName: string;
  sourceFile?: string;
  sourceLine?: number;
  helperChain?: unknown;
}

export interface DynamicRoutingContext {
  outboundCallId?: number;
  callerRepoId?: number;
  callerRepo?: string;
  selectedBindingId?: number;
  bindingResolutionStatus: string;
  selectedBinding?: DynamicReferenceRow;
  bindingAlternatives: Array<Record<string, unknown>>;
  bindingAlternativeCount: number;
  shownBindingAlternativeCount: number;
  omittedBindingAlternativeCount: number;
  references: DynamicReferenceRow[];
  fallbackUsed: boolean;
}

interface SelectedDynamicReference extends DynamicReferenceRow {
  outboundCallId: number;
  callerRepoId: number;
}

export function dynamicRoutingContext(
  db: Db,
  workspaceId: number | undefined,
  evidence: Record<string, unknown>,
): DynamicRoutingContext {
  const selected = selectedBinding(db, workspaceId, evidence);
  const persisted = persistedBindingResolution(evidence);
  const alternatives = boundedAlternatives(
    persisted.candidates,
    persisted.candidateCount,
  );
  if (selected) {
    const requires = exactRequireReferences(db, workspaceId, selected);
    return {
      ...contextBase(selected, persisted.status, alternatives),
      selectedBinding: selected,
      references: [selected, ...requires],
      fallbackUsed: false,
    };
  }
  const callerRepoId = numberValue(evidence.repoId);
  const callerRepo = stringValue(evidence.repo);
  return {
    outboundCallId: numberValue(evidence.outboundCallId ?? evidence.callId),
    callerRepoId,
    callerRepo,
    bindingResolutionStatus: persisted.status,
    bindingAlternatives: alternatives.items,
    bindingAlternativeCount: alternatives.totalCount,
    shownBindingAlternativeCount: alternatives.shownCount,
    omittedBindingAlternativeCount: alternatives.omittedCount,
    references: fallbackReferences(db, workspaceId, callerRepoId, callerRepo),
    fallbackUsed: true,
  };
}

export function dynamicReferenceProvenance(
  reference: DynamicReferenceRow,
  kind: 'alias' | 'destination',
  template: string,
  value: string,
): DynamicVariableProvenance {
  const sourceKind = reference.selection === 'selected_binding'
    ? `selected_binding.${kind}`
    : reference.selection === 'selected_binding_require'
      ? `selected_binding_require.${kind}`
      : `${reference.sourceKind}.${kind}`;
  return {
    sourceKind,
    value,
    rule: 'exact_indexed_reference_template_match',
    template,
    sourceRepo: reference.repoName,
    sourceFile: reference.sourceFile,
    sourceLine: reference.sourceLine,
    selection: reference.selection,
    bindingId: reference.bindingId,
  };
}

function contextBase(
  selected: SelectedDynamicReference,
  status: string,
  alternatives: ReturnType<typeof boundedAlternatives>,
): Omit<DynamicRoutingContext, 'selectedBinding' | 'references' | 'fallbackUsed'> {
  return {
    outboundCallId: selected.outboundCallId,
    callerRepoId: selected.callerRepoId,
    callerRepo: selected.repoName,
    selectedBindingId: selected.bindingId,
    bindingResolutionStatus: status,
    bindingAlternatives: alternatives.items,
    bindingAlternativeCount: alternatives.totalCount,
    shownBindingAlternativeCount: alternatives.shownCount,
    omittedBindingAlternativeCount: alternatives.omittedCount,
  };
}

function selectedBinding(
  db: Db,
  workspaceId: number | undefined,
  evidence: Record<string, unknown>,
): SelectedDynamicReference | undefined {
  const callId = numberValue(evidence.outboundCallId ?? evidence.callId);
  if (callId === undefined) return undefined;
  const row = db.prepare(`SELECT c.id outboundCallId,c.repo_id callerRepoId,r.name repoName,
      b.id bindingId,b.alias,b.alias_expr aliasExpr,b.destination_expr destination,
      b.service_path_expr servicePath,b.source_file sourceFile,b.source_line sourceLine,
      b.helper_chain_json helperChainJson
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    JOIN service_bindings b ON b.id=c.service_binding_id AND b.repo_id=c.repo_id
    WHERE c.id=? AND (? IS NULL OR r.workspace_id=?)`).get(
    callId, workspaceId, workspaceId,
  );
  return selectedReferenceFromRow(row);
}

function selectedReferenceFromRow(
  row: Record<string, unknown> | undefined,
): SelectedDynamicReference | undefined {
  const outboundCallId = numberValue(row?.outboundCallId);
  const callerRepoId = numberValue(row?.callerRepoId);
  const reference = referenceFromRow(
    row, 'service_binding', 'selected_binding',
  )[0];
  return reference && outboundCallId !== undefined && callerRepoId !== undefined
    ? { ...reference, outboundCallId, callerRepoId }
    : undefined;
}

function exactRequireReferences(
  db: Db,
  workspaceId: number | undefined,
  selected: SelectedDynamicReference,
): DynamicReferenceRow[] {
  if (!(selected.aliasExpr ?? selected.alias)) return [];
  const rows = db.prepare(`SELECT req.alias,req.destination,req.service_path servicePath,
      r.name repoName,'package.json' sourceFile,1 sourceLine
    FROM cds_requires req JOIN repositories r ON r.id=req.repo_id
    WHERE req.repo_id=? AND (? IS NULL OR r.workspace_id=?)
    ORDER BY req.alias,req.id`).all(
    selected.callerRepoId, workspaceId, workspaceId,
  );
  return rows.flatMap((row) => referenceFromRow(
    row, 'cds_require', 'selected_binding_require', selected.bindingId,
  ));
}

function fallbackReferences(
  db: Db,
  workspaceId: number | undefined,
  callerRepoId: number | undefined,
  callerRepo: string | undefined,
): DynamicReferenceRow[] {
  if (callerRepoId === undefined && callerRepo === undefined) return [];
  const rows = db.prepare(`SELECT b.id bindingId,COALESCE(b.alias,b.alias_expr) alias,
      b.alias_expr aliasExpr,b.destination_expr destination,b.service_path_expr servicePath,
      'service_binding' sourceKind,r.name repoName,b.source_file sourceFile,
      b.source_line sourceLine,b.helper_chain_json helperChainJson,0 sourcePriority
    FROM service_bindings b JOIN repositories r ON r.id=b.repo_id
    WHERE (? IS NULL OR r.workspace_id=?)
      AND ((? IS NOT NULL AND r.id=?) OR (? IS NULL AND r.name=?))
    UNION ALL
    SELECT NULL,req.alias,req.alias,req.destination,req.service_path,
      'cds_require',r.name,'package.json',1,NULL,1
    FROM cds_requires req JOIN repositories r ON r.id=req.repo_id
    WHERE (? IS NULL OR r.workspace_id=?)
      AND ((? IS NOT NULL AND r.id=?) OR (? IS NULL AND r.name=?))
    ORDER BY sourcePriority,repoName,sourceFile,sourceLine`).all(
    workspaceId, workspaceId, callerRepoId, callerRepoId, callerRepoId, callerRepo,
    workspaceId, workspaceId, callerRepoId, callerRepoId, callerRepoId, callerRepo,
  );
  return rows.flatMap((row) => {
    const sourceKind = row.sourceKind;
    return sourceKind === 'service_binding' || sourceKind === 'cds_require'
      ? referenceFromRow(row, sourceKind, 'fallback')
      : [];
  });
}

function referenceFromRow(
  row: Record<string, unknown> | undefined,
  sourceKind: DynamicReferenceRow['sourceKind'],
  selection: DynamicReferenceRow['selection'],
  bindingId = numberValue(row?.bindingId),
): DynamicReferenceRow[] {
  const repoName = stringValue(row?.repoName);
  if (!repoName) return [];
  return [{
    bindingId,
    alias: stringValue(row?.alias),
    aliasExpr: stringValue(row?.aliasExpr),
    destination: stringValue(row?.destination),
    servicePath: stringValue(row?.servicePath),
    sourceKind,
    selection,
    repoName,
    sourceFile: stringValue(row?.sourceFile),
    sourceLine: numberValue(row?.sourceLine),
    helperChain: parsedJson(row?.helperChainJson),
  }];
}

function persistedBindingResolution(evidence: Record<string, unknown>): {
  status: string;
  candidates: Array<Record<string, unknown>>;
  candidateCount: number;
} {
  const outbound = record(evidence.outboundEvidence);
  const resolution = record(outbound.serviceBindingResolution);
  return {
    status: stringValue(resolution.status) ?? 'unknown',
    candidates: recordArray(resolution.candidates),
    candidateCount: numberValue(resolution.candidateCount) ?? 0,
  };
}

function boundedAlternatives(
  rows: Array<Record<string, unknown>>,
  reportedCount: number,
): BoundedProjection<Record<string, unknown>> {
  const projection = projectBounded(rows, (left, right) =>
    Number(left.bindingId ?? 0) - Number(right.bindingId ?? 0)
    || String(left.sourceFile ?? '').localeCompare(String(right.sourceFile ?? ''))
    || Number(left.sourceLine ?? 0) - Number(right.sourceLine ?? 0));
  const totalCount = Math.max(reportedCount, projection.totalCount);
  return {
    ...projection,
    totalCount,
    omittedCount: Math.max(0, totalCount - projection.shownCount),
  };
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
