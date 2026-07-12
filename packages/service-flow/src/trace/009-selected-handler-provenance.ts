import type { Db } from '../db/connection.js';
import {
  selectedHandlerProvenance,
  type SelectedHandlerProvenance,
  type SelectedHandlerSource,
} from '../linker/001-implementation-evidence-projection.js';

export interface HandlerMethodNode extends Record<string, unknown> {
  id: string;
  kind: 'handler_method';
  label: string;
  methodId: number;
  methodName: string;
  className: string;
  sourceFile: string;
  sourceLine: number;
  repoId: number;
  repoName: string;
  packageName?: string;
}

export interface SelectedHandlerEvidence {
  handler?: HandlerMethodNode;
  evidence: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
  unresolvedReason?: string;
}

export function handlerMethodNode(
  db: Db,
  methodId: string,
): HandlerMethodNode | undefined {
  const row = db.prepare(`SELECT hm.id methodId,hm.method_name methodName,
    hm.source_line sourceLine,hc.class_name className,hc.source_file sourceFile,
    r.name repoName,r.id repoId,r.package_name packageName
    FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories r ON r.id=hc.repo_id WHERE hm.id=?`).get(methodId) as
    | Record<string, unknown>
    | undefined;
  return handlerNodeFromRow(row);
}

export function withSelectedHandlerProvenance(
  evidence: Record<string, unknown>,
  targetId: string,
  handler: HandlerMethodNode | undefined,
): SelectedHandlerEvidence {
  if (!handler) return unavailableHandlerEvidence(evidence, targetId);
  const selected = selectedHandlerProvenance(handlerSource(handler));
  const stored = record(evidence.selectedHandler);
  const mismatchedFields = storedSelectedHandlerMismatches(
    stored, selected, targetId,
  );
  if (mismatchedFields.length === 0)
    return { handler, evidence: { ...evidence, selectedHandler: selected } };
  return {
    handler,
    evidence: {
      ...evidence,
      selectedHandler: selected,
      selectedHandlerProvenanceAudit: {
        status: 'mismatch',
        graphTargetId: targetId,
        mismatchedFields,
        persistedSelectedHandler: stored,
      },
    },
    diagnostic: {
      severity: 'warning',
      code: 'selected_handler_provenance_mismatch',
      message: 'Persisted selected handler provenance did not match the resolved graph target',
      graphTargetId: targetId,
      mismatchedFields,
      sourceFile: handler.sourceFile,
      sourceLine: handler.sourceLine,
    },
  };
}

function unavailableHandlerEvidence(
  evidence: Record<string, unknown>,
  targetId: string,
): SelectedHandlerEvidence {
  return {
    evidence: {
      ...evidence,
      selectedHandlerProvenanceAudit: {
        status: 'unavailable',
        graphTargetId: targetId,
        reason: 'handler_target_not_indexed',
      },
    },
    diagnostic: {
      severity: 'warning',
      code: 'selected_handler_target_not_found',
      message: 'Resolved implementation target is not an indexed handler method',
      graphTargetId: targetId,
    },
    unresolvedReason: 'Resolved implementation target is not an indexed handler method',
  };
}

function handlerNodeFromRow(
  row: Record<string, unknown> | undefined,
): HandlerMethodNode | undefined {
  const methodId = numberValue(row?.methodId);
  const methodName = stringValue(row?.methodName);
  const className = stringValue(row?.className);
  const sourceFile = stringValue(row?.sourceFile);
  const sourceLine = numberValue(row?.sourceLine);
  const repoId = numberValue(row?.repoId);
  const repoName = stringValue(row?.repoName);
  if (methodId === undefined || !methodName || !className || !sourceFile
    || sourceLine === undefined || repoId === undefined || !repoName)
    return undefined;
  return {
    id: `handler_method:${methodId}`,
    kind: 'handler_method',
    label: `${repoName}:${className}.${methodName}`,
    methodId,
    methodName,
    className,
    sourceFile,
    sourceLine,
    repoId,
    repoName,
    packageName: stringValue(row?.packageName),
  };
}

function handlerSource(node: HandlerMethodNode): SelectedHandlerSource {
  return {
    methodId: node.methodId,
    methodName: node.methodName,
    className: node.className,
    repositoryId: node.repoId,
    repositoryName: node.repoName,
    repositoryPackageName: node.packageName,
    sourceFile: node.sourceFile,
    sourceLine: node.sourceLine,
  };
}

function storedSelectedHandlerMismatches(
  stored: Record<string, unknown>,
  selected: SelectedHandlerProvenance,
  targetId: string,
): string[] {
  if (Object.keys(stored).length === 0) return [];
  const expectedRepository = record(stored.repository);
  const selectedRepository = selected.repository ?? {};
  return [
    mismatch('graphTargetId', stored.graphTargetId, targetId),
    mismatch('methodId', stored.methodId, selected.methodId),
    mismatch('className', stored.className, selected.className),
    mismatch('methodName', stored.methodName, selected.methodName),
    mismatch('sourceFile', stored.sourceFile, selected.sourceFile),
    mismatch('sourceLine', stored.sourceLine, selected.sourceLine),
    mismatch('repository.id', expectedRepository.id, selectedRepository.id),
    mismatch('repository.name', expectedRepository.name, selectedRepository.name),
    mismatch('repository.packageName', expectedRepository.packageName,
      selectedRepository.packageName),
  ].flatMap((field) => field ? [field] : []);
}

function mismatch(
  field: string,
  stored: unknown,
  actual: unknown,
): string | undefined {
  return stored === undefined || stored === actual ? undefined : field;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
