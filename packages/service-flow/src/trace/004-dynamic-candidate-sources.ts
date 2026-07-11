import type { Db } from '../db/connection.js';
import {
  extractPlaceholders,
  matchRuntimeTemplate,
} from '../linker/dynamic-edge-resolver.js';
import type { OperationTarget } from '../linker/service-resolver.js';

export function dynamicCandidateTargets(
  db: Db,
  effectiveOperationPath: string | undefined,
  originalOperationPath: string | undefined,
  embedded: unknown,
  workspaceId: number | undefined,
  requireCanonical: boolean,
): OperationTarget[] {
  const canonical = queryOperationTargets(
    db, effectiveOperationPath, originalOperationPath, workspaceId,
  );
  if (canonical.length > 0 || requireCanonical) return canonical;
  return targetsFromEvidence(embedded);
}

function targetsFromEvidence(value: unknown): OperationTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OperationTarget[] => {
    const row = record(item);
    const operationId = numberValue(row.operationId);
    const repoName = stringValue(row.repoName);
    const servicePath = stringValue(row.servicePath);
    const operationPath = stringValue(row.operationPath);
    const operationName = stringValue(row.operationName) ?? operationPath?.replace(/^\//, '');
    if (operationId === undefined || !repoName || !servicePath || !operationPath || !operationName)
      return [];
    return [{
      operationId,
      repoId: numberValue(row.repoId),
      repoName,
      packageName: stringValue(row.packageName),
      serviceName: stringValue(row.serviceName) ?? '',
      qualifiedName: stringValue(row.qualifiedName) ?? '',
      servicePath,
      operationPath,
      operationName,
      sourceFile: stringValue(row.sourceFile) ?? '',
      sourceLine: numberValue(row.sourceLine) ?? 0,
      score: numberValue(row.score) ?? 0,
      reasons: stringArray(row.reasons),
    }];
  });
}

function queryOperationTargets(
  db: Db,
  effectiveOperationPath: string | undefined,
  originalOperationPath: string | undefined,
  workspaceId: number | undefined,
): OperationTarget[] {
  const operationPath = effectiveOperationPath ?? originalOperationPath;
  if (!operationPath) return [];
  if (extractPlaceholders(operationPath).length > 0)
    return templateOperationTargets(db, operationPath, workspaceId);
  return exactOperationTargets(db, operationPath, workspaceId);
}

function exactOperationTargets(
  db: Db,
  operationPath: string,
  workspaceId: number | undefined,
): OperationTarget[] {
  const simple = operationPath.replace(/^\//, '').split('.').at(-1) ?? operationPath;
  const rows = recordRows(db.prepare(
    `SELECT o.id operationId,r.id repoId,r.name repoName,r.package_name packageName,
      s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,
      o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,
      o.source_line sourceLine FROM cds_operations o
     JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
       AND (o.operation_path IN (?,?) OR o.operation_name=?)
     ORDER BY r.name,s.service_path,o.operation_name,o.id`,
  ).all(workspaceId, workspaceId, operationPath, `/${simple}`, simple));
  return rows.flatMap(targetFromRow);
}

function templateOperationTargets(
  db: Db,
  operationTemplate: string,
  workspaceId: number | undefined,
): OperationTarget[] {
  const rows = recordRows(db.prepare(
    `SELECT o.id operationId,r.id repoId,r.name repoName,r.package_name packageName,
      s.service_name serviceName,s.qualified_name qualifiedName,s.service_path servicePath,
      o.operation_path operationPath,o.operation_name operationName,o.source_file sourceFile,
      o.source_line sourceLine FROM cds_operations o
     JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id
     WHERE (? IS NULL OR r.workspace_id=?)
     ORDER BY r.name,s.service_path,o.operation_name,o.id`,
  ).all(workspaceId, workspaceId));
  return rows.flatMap((row) => {
    const operationPath = stringValue(row.operationPath);
    return matchRuntimeTemplate(operationTemplate, operationPath)
      ? targetFromRow(row)
      : [];
  });
}

function targetFromRow(row: Record<string, unknown>): OperationTarget[] {
  const operationId = numberValue(row.operationId);
  const repoName = stringValue(row.repoName);
  const servicePath = stringValue(row.servicePath);
  const operationPath = stringValue(row.operationPath);
  const operationName = stringValue(row.operationName);
  if (operationId === undefined || !repoName || !servicePath || !operationPath || !operationName)
    return [];
  return [{
    operationId,
    repoId: numberValue(row.repoId),
    repoName,
    packageName: stringValue(row.packageName),
    serviceName: stringValue(row.serviceName) ?? '',
    qualifiedName: stringValue(row.qualifiedName) ?? '',
    servicePath,
    operationPath,
    operationName,
    sourceFile: stringValue(row.sourceFile) ?? '',
    sourceLine: numberValue(row.sourceLine) ?? 0,
    score: 0.2,
    reasons: ['operation_path_match'],
  }];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
