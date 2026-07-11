import type { Db } from '../db/connection.js';

export function loadTraceDiagnostics(
  db: Db,
  repoId: number | undefined,
  includeWorkspaceDiagnostics: boolean,
  workspaceId?: number,
): Array<Record<string, unknown>> {
  if (repoId === undefined && !includeWorkspaceDiagnostics) return [];
  return db.prepare(`SELECT d.repo_id repoId,d.severity,d.code,d.message,
      d.source_file sourceFile,d.source_line sourceLine
    FROM diagnostics d LEFT JOIN repositories r ON r.id=d.repo_id
    WHERE (? IS NULL OR d.repo_id=?)
      AND (? IS NULL OR d.repo_id IS NULL OR r.workspace_id=?)
    ORDER BY severity,code,COALESCE(source_file,''),
      COALESCE(source_line,0),d.id`).all(
        repoId, repoId, workspaceId, workspaceId,
      ) as Array<
        Record<string, unknown>
      >;
}

export function prependTraceDiagnostic(
  diagnostics: Array<Record<string, unknown>>,
  diagnostic: Record<string, unknown>,
): void {
  const duplicate = diagnostics.findIndex((item) =>
    sameDiagnosticLocation(item, diagnostic));
  if (duplicate >= 0) diagnostics.splice(duplicate, 1);
  diagnostics.unshift(diagnostic);
}

function sameDiagnosticLocation(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (left.code !== right.code) return false;
  const leftFile = stringValue(left.sourceFile);
  const rightFile = stringValue(right.sourceFile);
  if (leftFile || rightFile)
    return leftFile === rightFile
      && numericValue(left.sourceLine) === numericValue(right.sourceLine);
  return String(left.message ?? '') === String(right.message ?? '');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
