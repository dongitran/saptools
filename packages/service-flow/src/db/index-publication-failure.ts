import type { Db } from './connection.js';

export type PreparedRepositoryFactKind =
  | 'outbound_call'
  | 'service_binding'
  | 'symbol_call';

export type PreparedSnapshotFailureCode =
  | 'binding_lexical_proof_invalid'
  | 'binding_owner_mismatch'
  | 'binding_reference_mismatch'
  | 'binding_reference_missing'
  | 'binding_site_missing'
  | 'duplicate_service_binding_site'
  | 'outbound_owner_mismatch'
  | 'package_import_provenance_missing'
  | 'symbol_call_owner_mismatch';

export interface PreparedSnapshotFailureSite {
  factKind: PreparedRepositoryFactKind;
  sourceFile?: string;
  sourceLine?: number;
  callSiteStartOffset?: number;
  callSiteEndOffset?: number;
}

export interface PreparedFactInsertionOptions {
  containPreparedFailures?: boolean;
}

export class PreparedRepositorySnapshotError extends Error {
  readonly failureCode: PreparedSnapshotFailureCode;
  readonly site: PreparedSnapshotFailureSite;

  constructor(
    failureCode: PreparedSnapshotFailureCode,
    site: PreparedSnapshotFailureSite,
  ) {
    super(`invalid_prepared_repository_snapshot:${failureCode}`);
    this.name = 'PreparedRepositorySnapshotError';
    this.failureCode = failureCode;
    this.site = site;
  }
}

interface PreparedCallSite {
  sourceFile: string;
  sourceLine: number;
  callSiteStartOffset?: number;
  callSiteEndOffset?: number;
}

export function preparedCallSnapshotError(
  failureCode: PreparedSnapshotFailureCode,
  factKind: 'outbound_call' | 'symbol_call',
  call: PreparedCallSite,
): PreparedRepositorySnapshotError {
  return new PreparedRepositorySnapshotError(failureCode, {
    factKind,
    sourceFile: call.sourceFile,
    sourceLine: call.sourceLine,
    callSiteStartOffset: call.callSiteStartOffset,
    callSiteEndOffset: call.callSiteEndOffset,
  });
}

export function isPreparedRepositorySnapshotError(
  error: unknown,
): error is PreparedRepositorySnapshotError {
  return error instanceof PreparedRepositorySnapshotError;
}

export function containPreparedFactFailure(
  db: Db,
  repoId: number,
  error: unknown,
  options: PreparedFactInsertionOptions,
): boolean {
  if (!options.containPreparedFailures
    || !isPreparedRepositorySnapshotError(error)) return false;
  db.prepare(`INSERT INTO diagnostics(
    repo_id,severity,code,message,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(
    repoId,
    'warning',
    error.message,
    `Prepared ${error.site.factKind} was omitted because its fail-closed publication proof failed.`,
    error.site.sourceFile,
    error.site.sourceLine,
  );
  return true;
}

export function recordPreparedSnapshotFailure(
  db: Db,
  repoId: number,
  error: PreparedRepositorySnapshotError,
): void {
  db.prepare(`UPDATE repositories SET index_status='failed',
    error_count=1 WHERE id=?`).run(repoId);
  db.prepare(`DELETE FROM diagnostics WHERE repo_id=? AND (
    code IN ('index_failed_snapshot_preserved','source_read_failed')
    OR code GLOB 'invalid_prepared_repository_snapshot:*'
  )`).run(repoId);
  db.prepare(`INSERT INTO diagnostics(
    repo_id,severity,code,message,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(
    repoId,
    'error',
    error.message,
    'Index publication failed before commit for this repository; previous facts and fingerprint were preserved. '
      + `factKind=${error.site.factKind}`,
    error.site.sourceFile,
    error.site.sourceLine,
  );
}
