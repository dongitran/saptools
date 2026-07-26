import type { Db } from '../db/connection.js';
import type { TraceStart } from '../types.js';
import { implementationHintDiagnostic } from './implementation-hints.js';
import { hintedImplementationSelection } from './005-implementation-selection.js';
import { implementationStartDiagnostic } from './007-implementation-start-diagnostic.js';
import { parseTraceEvidence } from './017-trace-context.js';
import { shouldDeferTraceStartSelection } from './022-trace-fact-preflight.js';
import {
  handlerScope,
  implementationScope,
  type ImplementationHintOptions,
} from './025-trace-implementation-scope.js';
import {
  ambiguousStartDiagnostic,
  selectorRepoAmbiguousDiagnostic,
  selectorRepoNotFoundDiagnostic,
  sourceScopeForSelector,
} from './selectors.js';

interface RepoRef {
  id: number;
  name: string;
  packageName?: string;
  workspaceId: number;
}

interface OperationRow extends Record<string, unknown> {
  operationId?: string | number;
  repoName?: string;
  servicePath?: string;
}

interface OperationStartScope {
  files?: Set<string>;
  symbols?: Set<number>;
  repoId?: number;
  operationId?: string;
  diagnostics?: Array<Record<string, unknown>>;
}

export interface TraceStartScope {
  repo?: RepoRef;
  executionRepoId?: number;
  sourceFiles?: Set<string>;
  symbolIds?: Set<number>;
  selectorMatched: boolean;
  startOperationId?: string;
  startDiagnostics?: Array<Record<string, unknown>>;
}

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}

function operationRows(
  db: Db,
  repoId: number | undefined,
  start: TraceStart,
  workspaceId: number | undefined,
  requested: string,
): OperationRow[] {
  return db.prepare(`SELECT o.id operationId,o.operation_name operationName,
      o.operation_path operationPath,o.source_file sourceFile,
      o.source_line sourceLine,s.service_path servicePath,
      r.id repoId,r.name repoName
    FROM cds_operations o
    JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id
    WHERE (? IS NULL OR r.workspace_id=?) AND (? IS NULL OR r.id=?)
      AND (? IS NULL OR s.service_path=?)
      AND (o.operation_name=? OR o.operation_path=? OR o.operation_path=?)
    ORDER BY r.name,s.service_path,o.operation_name,o.id`).all(
    workspaceId, workspaceId, repoId, repoId,
    start.servicePath, start.servicePath, requested, requested,
    requested.startsWith('/') ? requested : `/${requested}`,
  ) as OperationRow[];
}

function operationAmbiguity(
  requested: string,
  start: TraceStart,
  rows: OperationRow[],
): Record<string, unknown> | undefined {
  const repoCount = new Set(rows.map((row) => String(row.repoName))).size;
  const services = rows.map((row) =>
    `${String(row.repoName)}:${String(row.servicePath)}`);
  if (!start.repo && repoCount > 1)
    return ambiguousStartDiagnostic(requested, rows,
      'Operation trace start matched multiple repositories; add --repo to disambiguate');
  if (!start.servicePath && new Set(services).size > 1)
    return ambiguousStartDiagnostic(requested, rows,
      'Operation trace start matched multiple services; add --service to disambiguate');
  return rows.length !== 1
    ? ambiguousStartDiagnostic(requested, rows,
      'Operation trace start matched multiple indexed operations')
    : undefined;
}

function resolvedOperationStart(
  db: Db,
  operationId: string,
  hintOptions: ImplementationHintOptions,
): OperationStartScope {
  const implementation = implementationScope(db, operationId);
  if (implementation.edge?.status === 'resolved'
    && implementation.files.size > 0) return {
    files: implementation.files,
    symbols: implementation.symbolId
      ? new Set([implementation.symbolId]) : undefined,
    repoId: implementation.repoId,
    operationId,
    diagnostics: [],
  };
  return hintedOrUnresolvedStart(
    db, operationId, implementation, hintOptions,
  );
}

function hintedOrUnresolvedStart(
  db: Db,
  operationId: string,
  implementation: ReturnType<typeof implementationScope>,
  hintOptions: ImplementationHintOptions,
): OperationStartScope {
  const hinted = hintedImplementationSelection(
    db, implementation.edge, operationId, hintOptions,
  );
  if (hinted.methodId) {
    const scope = handlerScope(db, hinted.methodId);
    if (scope?.files.size) return {
      files: scope.files,
      symbols: scope.symbolId ? new Set([scope.symbolId]) : undefined,
      repoId: scope.repoId,
      operationId,
      diagnostics: [],
    };
  }
  return unresolvedOperationStart(operationId, implementation.edge, hinted);
}

function unresolvedOperationStart(
  operationId: string,
  edge: ReturnType<typeof implementationScope>['edge'],
  hinted: ReturnType<typeof hintedImplementationSelection>,
): OperationStartScope {
  if (!edge) return {
    operationId,
    diagnostics: [{
      severity: 'warning',
      code: 'trace_start_implementation_unresolved',
      message: 'Indexed operation matched but no implementation candidate exists',
      resolutionStage: 'implementation',
      resolutionStatus: 'operation_without_implementation',
    }],
  };
  const evidence = parseTraceEvidence(edge.evidence_json);
  const hintDiagnostic = implementationHintDiagnostic(hinted, evidence);
  const diagnostic = implementationStartDiagnostic(edge, evidence);
  return {
    operationId,
    diagnostics: hintDiagnostic ? [hintDiagnostic, diagnostic] : [diagnostic],
  };
}

function operationStartScope(
  db: Db,
  repoId: number | undefined,
  start: TraceStart,
  hintOptions: ImplementationHintOptions,
  workspaceId: number | undefined,
): OperationStartScope | undefined {
  const requested = normalizeOperation(start.operationPath ?? start.operation);
  if (!requested) return undefined;
  const rows = operationRows(db, repoId, start, workspaceId, requested);
  if (rows.length === 0) return undefined;
  const diagnostic = operationAmbiguity(requested, start, rows);
  if (diagnostic) return { diagnostics: [diagnostic] };
  return resolvedOperationStart(db, String(rows[0]?.operationId), hintOptions);
}

function matchingRepos(
  db: Db,
  start: TraceStart,
  workspaceId: number | undefined,
): RepoRef[] {
  if (!start.repo) return [];
  const rows = db.prepare(`SELECT id,name,package_name packageName,
      workspace_id workspaceId
    FROM repositories
    WHERE (? IS NULL OR workspace_id=?)
      AND (name=? OR package_name=?)
    ORDER BY name COLLATE BINARY,absolute_path COLLATE BINARY,id`).all(
    workspaceId, workspaceId, start.repo, start.repo,
  );
  return rows.flatMap((row) =>
    typeof row.id === 'number' && typeof row.name === 'string'
      && typeof row.workspaceId === 'number'
      ? [{
          id: row.id,
          name: row.name,
          packageName: typeof row.packageName === 'string'
            ? row.packageName : undefined,
          workspaceId: row.workspaceId,
        }]
      : []);
}

function repoSelectionDiagnostic(
  start: TraceStart,
  repos: RepoRef[],
): TraceStartScope | undefined {
  if (start.repo && repos.length === 0) return {
    selectorMatched: false,
    startDiagnostics: [selectorRepoNotFoundDiagnostic(start.repo)],
  };
  if (start.repo && repos.length > 1) return {
    selectorMatched: false,
    startDiagnostics: [selectorRepoAmbiguousDiagnostic(start.repo, repos)],
  };
  return undefined;
}

function terminalOperationScope(
  scope: OperationStartScope | undefined,
): boolean {
  return Boolean(scope && !scope.files && (scope.diagnostics ?? []).some(
    (diagnostic) => diagnostic.resolutionStage === 'operation'
      || diagnostic.resolutionStage === 'implementation',
  ));
}

function hasTraceSelector(start: TraceStart): boolean {
  return Boolean(
    start.handler ?? start.operation ?? start.operationPath ?? start.servicePath,
  );
}

function serviceOnlyStart(start: TraceStart): boolean {
  return Boolean(start.servicePath)
    && !start.operation && !start.operationPath && !start.handler;
}

function selectedExecutionRepoId(
  source: ReturnType<typeof sourceScopeForSelector>,
  repo: RepoRef | undefined,
): number | undefined {
  return source?.repoId ?? repo?.id;
}

function startDiagnostics(
  operation: OperationStartScope | undefined,
  source: ReturnType<typeof sourceScopeForSelector>,
): Array<Record<string, unknown>> | undefined {
  const operationDiagnostics = operation?.diagnostics;
  return operationDiagnostics && operationDiagnostics.length > 0
    ? operationDiagnostics : source?.diagnostics;
}

function startSelectorMatched(
  start: TraceStart,
  operation: OperationStartScope | undefined,
  source: ReturnType<typeof sourceScopeForSelector>,
): boolean {
  if (terminalOperationScope(operation)) return false;
  if (source?.diagnostics?.length && !source.files) return false;
  if (!hasTraceSelector(start)) return true;
  return source?.files !== undefined;
}

function selectedStartScope(
  start: TraceStart,
  repo: RepoRef | undefined,
  operation: OperationStartScope | undefined,
  source: ReturnType<typeof sourceScopeForSelector>,
): TraceStartScope {
  const sourceFiles = source?.files;
  if (serviceOnlyStart(start)) return { repo, selectorMatched: false };
  return {
    repo,
    executionRepoId: selectedExecutionRepoId(source, repo),
    sourceFiles,
    symbolIds: source?.symbols,
    selectorMatched: startSelectorMatched(start, operation, source),
    startOperationId: operation?.operationId,
    startDiagnostics: startDiagnostics(operation, source),
  };
}

function deferredStartScope(
  db: Db,
  workspaceId: number | undefined,
  repo: RepoRef | undefined,
): TraceStartScope | undefined {
  if (!shouldDeferTraceStartSelection(db, workspaceId, repo?.id))
    return undefined;
  return {
    repo,
    executionRepoId: repo?.id,
    selectorMatched: true,
  };
}

function selectorSourceScope(
  db: Db,
  start: TraceStart,
  repo: RepoRef | undefined,
  operation: OperationStartScope | undefined,
  workspaceId: number | undefined,
): ReturnType<typeof sourceScopeForSelector> {
  if (operation?.files || terminalOperationScope(operation)) return operation;
  return sourceScopeForSelector(db, repo?.id, start, workspaceId);
}

export function resolveTraceStartScope(
  db: Db,
  start: TraceStart,
  hintOptions: ImplementationHintOptions,
  workspaceId: number | undefined,
): TraceStartScope {
  const repos = matchingRepos(db, start, workspaceId);
  const exactRepo = repos.length === 1 ? repos[0] : undefined;
  const deferred = deferredStartScope(db, workspaceId, exactRepo);
  if (deferred) return deferred;
  const repoDiagnostic = repoSelectionDiagnostic(start, repos);
  if (repoDiagnostic) return repoDiagnostic;
  const repo = repos[0];
  const operation = operationStartScope(
    db, repo?.id, start, hintOptions, workspaceId,
  );
  const source = selectorSourceScope(
    db, start, repo, operation, workspaceId,
  );
  return selectedStartScope(start, repo, operation, source);
}
