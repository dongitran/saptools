import type { Db } from '../db/connection.js';
import type { DynamicVariableProvenance } from './000-dynamic-target-types.js';

export interface DynamicReferenceRow {
  alias?: string;
  destination?: string;
  servicePath?: string;
  sourceKind: 'service_binding' | 'cds_require';
  repoName: string;
  sourceFile?: string;
  sourceLine?: number;
}

export function dynamicReferenceRows(
  db: Db,
  workspaceId: number | undefined,
  callerRepoId: number | undefined,
  callerRepo: string | undefined,
): DynamicReferenceRow[] {
  if (callerRepoId === undefined && callerRepo === undefined) return [];
  const rows = db.prepare(
    `SELECT COALESCE(b.alias,b.alias_expr) alias,b.destination_expr destination,
      b.service_path_expr servicePath,'service_binding' sourceKind,r.name repoName,
      b.source_file sourceFile,b.source_line sourceLine,0 sourcePriority
     FROM service_bindings b JOIN repositories r ON r.id=b.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
       AND ((? IS NOT NULL AND r.id=?) OR (? IS NULL AND r.name=?))
     UNION ALL
     SELECT req.alias,req.destination,req.service_path,'cds_require',r.name,
      'package.json',1,1 FROM cds_requires req JOIN repositories r ON r.id=req.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
       AND ((? IS NOT NULL AND r.id=?) OR (? IS NULL AND r.name=?))
     ORDER BY sourcePriority,repoName,sourceFile,sourceLine`,
  ).all(
    workspaceId, workspaceId,
    callerRepoId, callerRepoId, callerRepoId, callerRepo,
    workspaceId, workspaceId,
    callerRepoId, callerRepoId, callerRepoId, callerRepo,
  );
  return rows.flatMap(referenceFromRow);
}

export function dynamicReferenceProvenance(
  reference: DynamicReferenceRow,
  kind: 'alias' | 'destination',
  template: string,
  value: string,
): DynamicVariableProvenance {
  return {
    sourceKind: `${reference.sourceKind}.${kind}`,
    value,
    rule: 'exact_indexed_reference_template_match',
    template,
    sourceRepo: reference.repoName,
    sourceFile: reference.sourceFile,
    sourceLine: reference.sourceLine,
  };
}

function referenceFromRow(row: Record<string, unknown>): DynamicReferenceRow[] {
  const sourceKind = row.sourceKind;
  const repoName = stringValue(row.repoName);
  if ((sourceKind !== 'service_binding' && sourceKind !== 'cds_require')
    || !repoName) return [];
  return [{
    alias: stringValue(row.alias),
    destination: stringValue(row.destination),
    servicePath: stringValue(row.servicePath),
    sourceKind,
    repoName,
    sourceFile: stringValue(row.sourceFile),
    sourceLine: numberValue(row.sourceLine),
  }];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
