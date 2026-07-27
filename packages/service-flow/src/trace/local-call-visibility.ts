import type { Db } from '../db/connection.js';
import { packageModuleRequest } from
  '../parsers/symbol-import-bindings.js';
import type { TraceEdge } from '../types.js';
import { parseTraceEvidence } from './trace-context.js';

export interface LocalCallTrace {
  evidence: Record<string, unknown>;
  unresolvedReason?: string;
  edge: TraceEdge;
}

function recordOmittedExternalPackageCalls(
  diagnostics: Array<Record<string, unknown>>,
  packageNames: readonly string[],
): void {
  if (packageNames.length === 0) return;
  const code = 'external_package_calls_omitted';
  const existing = diagnostics.find((item) => item.code === code);
  if (existing) {
    existing.omittedCallCount =
      Number(existing.omittedCallCount ?? 0) + packageNames.length;
    const prior = Array.isArray(existing.packageNames)
      ? existing.packageNames.filter(
          (item): item is string => typeof item === 'string',
        ) : [];
    const distinct = [...new Set([...prior, ...packageNames])].sort();
    existing.packageNames = distinct.slice(0, 8);
    existing.packageNameExamplesTruncated =
      existing.packageNameExamplesTruncated === true || distinct.length > 8;
    return;
  }
  const distinct = [...new Set(packageNames)].sort();
  const shown = distinct.slice(0, 8);
  diagnostics.push({
    severity: 'info',
    code,
    message:
      'Calls into packages without an indexed repository were omitted from trace edges.',
    omittedCallCount: packageNames.length,
    packageNames: shown,
    packageNameExamplesTruncated: distinct.length > shown.length,
  });
}

function workspacePackages(
  db: Db,
  workspaceId: number | undefined,
): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT package_name packageName
    FROM repositories WHERE package_name IS NOT NULL
      AND (? IS NULL OR workspace_id=?)
    ORDER BY package_name COLLATE BINARY`).all(workspaceId, workspaceId);
  return new Set(rows.flatMap((row) =>
    typeof row.packageName === 'string' ? [row.packageName] : []));
}

function externalPackageName(
  row: Record<string, unknown>,
  packages: ReadonlySet<string>,
): string | undefined {
  if (typeof row.import_source !== 'string') return undefined;
  const request = packageModuleRequest(row.import_source);
  return request && !packages.has(request.packageName)
    ? request.packageName : undefined;
}

export function visibleLocalCallRows(
  db: Db,
  workspaceId: number | undefined,
  rows: Array<Record<string, unknown>>,
  diagnostics: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const packages = workspacePackages(db, workspaceId);
  const external = rows.map((row) =>
    externalPackageName(row, packages));
  const visible = rows.filter((_row, index) =>
    external[index] === undefined);
  recordOmittedExternalPackageCalls(
    diagnostics,
    external.filter((name): name is string => name !== undefined),
  );
  return visible;
}

export function localCallTrace(
  depth: number,
  row: Record<string, unknown>,
  node: Record<string, unknown> | undefined,
): LocalCallTrace {
  const evidence = {
    ...parseTraceEvidence(row.evidence_json),
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    calleeSymbolId: row.callee_symbol_id,
    calleeSymbolName: node?.symbolName,
    calleeSymbolFile: node?.sourceFile,
    resolutionStatus: row.status,
  };
  const unresolvedReason = String(row.status) === 'resolved'
    ? undefined
    : row.unresolved_reason ? String(row.unresolved_reason) : undefined;
  return {
    evidence,
    unresolvedReason,
    edge: {
      step: depth,
      type: 'local_symbol_call',
      from: String(row.callee_expression),
      to: node?.label
        ? String(node.label)
        : `${String(row.status)}:${String(row.callee_expression)}`,
      evidence,
      confidence: Number(row.confidence ?? 0.8),
      unresolvedReason,
    },
  };
}
