import type { Db } from '../db/connection.js';
import type { TraceStart } from '../types.js';
import {
  projectBounded,
  type BoundedProjection,
} from '../utils/000-bounded-projection.js';

export interface SelectorSourceScope {
  files?: Set<string>;
  symbols?: Set<number>;
  repoId?: number;
  diagnostics?: Array<Record<string, unknown>>;
}

interface HandlerSelectorRow {
  handlerClassId?: number | null;
  repoId?: number | null;
  repoName?: string | null;
  className?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
  methodId?: number | null;
  symbolId?: number | null;
  classEvidence?: string | null;
}
export function parseVars(
  values: string[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const [key, ...rest] = value.split('=');
    if (key && rest.length > 0) out[key] = rest.join('=');
  }
  return out;
}
export function startLabel(start: TraceStart): string {
  return [
    start.repo,
    start.servicePath,
    start.operation ?? start.operationPath ?? start.handler
  ]
    .filter(Boolean)
    .join(' ');
}

export function selectorRepoNotFoundDiagnostic(
  requested: string,
): Record<string, unknown> {
  return {
    severity: 'warning',
    code: 'selector_repo_not_found',
    message: `No indexed repository matched selector: ${requested}`,
    selectorKind: 'repo',
    requestedRepository: requested,
  };
}

export function selectorRepoAmbiguousDiagnostic(
  requested: string,
  candidates: Array<{ id: number; name: string; packageName?: string }>,
): Record<string, unknown> {
  const uniqueName = (value: string): boolean => candidates
    .filter((candidate) => candidate.name === value).length === 1;
  const uniquePackage = (value: string): boolean => candidates
    .filter((candidate) => candidate.packageName === value).length === 1;
  const suggestions = candidates.flatMap((candidate) => {
    if (uniqueName(candidate.name)) return [`--repo ${candidate.name}`];
    if (candidate.packageName && uniquePackage(candidate.packageName))
      return [`--repo ${candidate.packageName}`];
    return [];
  });
  const candidateProjection = projectBounded(candidates, (left, right) =>
    left.name.localeCompare(right.name)
    || String(left.packageName ?? '').localeCompare(String(right.packageName ?? ''))
    || left.id - right.id);
  const suggestionProjection = projectBounded(
    [...new Set(suggestions)], (left, right) => left.localeCompare(right),
  );
  return {
    severity: 'warning',
    code: 'selector_repo_ambiguous',
    message: `Repository selector matched multiple indexed repositories: ${requested}`,
    selectorKind: 'repo',
    requestedRepository: requested,
    candidates: candidateProjection.items,
    candidateCount: candidateProjection.totalCount,
    shownCandidateCount: candidateProjection.shownCount,
    omittedCandidateCount: candidateProjection.omittedCount,
    selectorSuggestions: suggestionProjection.items,
    selectorSuggestionCount: suggestionProjection.totalCount,
    shownSelectorSuggestionCount: suggestionProjection.shownCount,
    omittedSelectorSuggestionCount: suggestionProjection.omittedCount,
    remediation: suggestions.length > 0
      ? 'Use one of the unique --repo selectors shown.'
      : 'Repository names and package names must be unique before this selector can be traced safely.',
  };
}

export function selectorNotFoundDiagnostic(
  start: TraceStart,
): Record<string, unknown> {
  const serviceOnly = start.servicePath && !start.operation
    && !start.operationPath && !start.handler;
  return {
    severity: 'warning',
    code: 'trace_start_not_found',
    message: serviceOnly
      ? 'Service-only trace requires --operation or --path and will not broaden to the whole workspace'
      : 'No handler source matched the requested trace start selector',
    selectorKind: start.handler ? 'handler' : start.operation || start.operationPath
      ? 'operation' : start.servicePath ? 'service' : undefined,
  };
}

export function sourceScopeForSelector(
  db: Db,
  repoId: number | undefined,
  start: TraceStart,
  workspaceId?: number,
): SelectorSourceScope | undefined {
  if (start.handler) {
    const classRows = handlerClassRows(db, repoId, start.handler, workspaceId);
    if (classRows.length > 0) return handlerClassScope(classRows, start.handler);
    const methodRows = handlerMethodRows(db, repoId, start.handler, workspaceId);
    if (methodRows.length > 0)
      return handlerMethodScope(methodRows, repoId, start.handler);
  }
  const operation = normalizeOperation(start.operation ?? start.operationPath);
  if (!operation) return undefined;
  const operationRows = operationHandlerRows(
    db, repoId, operation, start.servicePath, workspaceId,
  );
  if (operationRows.length > 0)
    return operationHandlerScope(operationRows, repoId, operation);
  if (!start.servicePath) return undefined;
  const implementationRows = implementationHandlerRows(
    db, repoId, start.servicePath, operation, workspaceId,
  );
  return implementationRows.length > 0
    ? executableScope(implementationRows, repoId)
    : undefined;
}

function handlerClassRows(
  db: Db,
  repoId: number | undefined,
  handler: string,
  workspaceId: number | undefined,
): HandlerSelectorRow[] {
  return db.prepare(`SELECT hc.id handlerClassId,hc.repo_id repoId,
      r.name repoName,hc.class_name className,
      hc.source_file sourceFile,hc.source_line sourceLine,hm.id methodId,
      sym.id symbolId,COALESCE(classSym.evidence_json,
        (SELECT fallback.evidence_json FROM symbols fallback
         WHERE fallback.repo_id=hc.repo_id AND fallback.kind='class'
           AND fallback.name=hc.class_name AND fallback.source_file=hc.source_file
         ORDER BY fallback.id LIMIT 1)) classEvidence
    FROM handler_classes hc
    JOIN repositories r ON r.id=hc.repo_id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id
      AND sym.source_file=hc.source_file
      AND sym.kind='method'
      AND substr(sym.qualified_name,1,length(hc.class_name)+1)=hc.class_name || '.'
      AND (NOT EXISTS (SELECT 1 FROM handler_methods declared
            WHERE declared.handler_class_id=hc.id
              AND declared.method_name=sym.name)
        OR EXISTS (SELECT 1 FROM handler_methods executable
            WHERE executable.handler_class_id=hc.id
              AND executable.method_name=sym.name
              AND COALESCE(json_extract(executable.decorator_resolution_json,
                '$.executable'),CASE WHEN executable.decorator_kind IN
                ('Action','Func','On','Event') THEN 1 ELSE 0 END)=1))
    LEFT JOIN handler_methods hm ON hm.handler_class_id=hc.id
      AND hm.method_name=sym.name
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On','Event')
          THEN 1 ELSE 0 END)=1
    LEFT JOIN symbols classSym ON classSym.id=hc.symbol_id
    WHERE (? IS NULL OR r.workspace_id=?)
      AND (? IS NULL OR hc.repo_id=?) AND hc.class_name=?
    ORDER BY hc.repo_id,hc.id,hm.id`).all(
      workspaceId, workspaceId, repoId, repoId, handler,
    ) as HandlerSelectorRow[];
}

function handlerMethodRows(
  db: Db,
  repoId: number | undefined,
  handler: string,
  workspaceId: number | undefined,
): HandlerSelectorRow[] {
  return db.prepare(`SELECT hc.id handlerClassId,hc.repo_id repoId,
      r.name repoName,hc.class_name className,hc.source_file sourceFile,
      hm.source_line sourceLine,hm.id methodId,sym.id symbolId
    FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories r ON r.id=hc.repo_id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id
      AND sym.source_file=hc.source_file
      AND sym.qualified_name=hc.class_name || '.' || hm.method_name
      AND sym.start_line=hm.source_line
    WHERE (? IS NULL OR r.workspace_id=?)
      AND (? IS NULL OR hc.repo_id=?) AND hm.method_name=?
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On','Event')
          THEN 1 ELSE 0 END)=1
    ORDER BY hc.repo_id,hc.id,hm.id`).all(
      workspaceId, workspaceId, repoId, repoId, handler,
    ) as HandlerSelectorRow[];
}

function operationHandlerRows(
  db: Db,
  repoId: number | undefined,
  operation: string,
  servicePath: string | undefined,
  workspaceId: number | undefined,
): HandlerSelectorRow[] {
  return db.prepare(`SELECT DISTINCT hc.id handlerClassId,hc.repo_id repoId,
      r.name repoName,hc.class_name className,hc.source_file sourceFile,
      hm.source_line sourceLine,hm.id methodId,sym.id symbolId
    FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories r ON r.id=hc.repo_id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id
      AND sym.source_file=hc.source_file
      AND sym.qualified_name=hc.class_name || '.' || hm.method_name
      AND sym.start_line=hm.source_line
    WHERE (? IS NULL OR r.workspace_id=?) AND (? IS NULL OR hc.repo_id=?)
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.handlerKind'),
        CASE WHEN hm.decorator_kind='Event' THEN 'event'
          WHEN hm.decorator_kind IN ('Action','Func','On') THEN 'operation'
          ELSE 'unsupported' END)='operation'
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On')
          THEN 1 ELSE 0 END)=1
      AND (hm.decorator_value=? OR hm.method_name=?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM cds_services svc JOIN cds_operations op ON op.service_id=svc.id
        WHERE svc.repo_id=hc.repo_id AND svc.service_path=?
          AND (op.operation_path=? OR op.operation_name=?)))
    ORDER BY hc.repo_id,hc.id,hm.id`).all(
      workspaceId, workspaceId, repoId, repoId,
      operation, operation, servicePath, servicePath,
      operation, operation,
    ) as HandlerSelectorRow[];
}

function operationHandlerScope(
  rows: HandlerSelectorRow[],
  fallbackRepoId: number | undefined,
  requested: string,
): SelectorSourceScope {
  const candidates = handlerSelectorCandidates(rows, 'method');
  if (candidates.length < 2) return executableScope(rows, fallbackRepoId);
  const classes = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${String(candidate.repoName)}:${String(candidate.className)}`;
    classes.set(key, new Set([
      ...(classes.get(key) ?? []),
      String(candidate.handlerClassId),
    ]));
  }
  const suggestions = candidates.flatMap((candidate) => {
    if (typeof candidate.repoName !== 'string'
      || typeof candidate.className !== 'string') return [];
    const key = `${candidate.repoName}:${candidate.className}`;
    return classes.get(key)?.size === 1
      ? [`--repo ${candidate.repoName} --handler ${candidate.className}`]
      : [];
  });
  const projection = boundedSelectorCandidates(candidates);
  const suggestionProjection = boundedSelectorSuggestions(suggestions);
  return { diagnostics: [{
    severity: 'warning',
    code: 'trace_start_ambiguous',
    message: 'Operation selector matched multiple handler-only executable scopes',
    selectorKind: 'operation',
    normalizedSelectorValue: requested,
    resolutionStage: 'handler',
    resolutionStatus: 'ambiguous_handler_operation',
    candidates: projection.items,
    candidateCount: projection.totalCount,
    shownCandidateCount: projection.shownCount,
    omittedCandidateCount: projection.omittedCount,
    selectorSuggestions: suggestionProjection.items,
    selectorSuggestionCount: suggestionProjection.totalCount,
    shownSelectorSuggestionCount: suggestionProjection.shownCount,
    omittedSelectorSuggestionCount: suggestionProjection.omittedCount,
    remediation: 'Select one handler class explicitly; no operation was chosen automatically.',
  }] };
}

function implementationHandlerRows(
  db: Db,
  repoId: number | undefined,
  servicePath: string,
  operation: string,
  workspaceId: number | undefined,
): HandlerSelectorRow[] {
  return db.prepare(`SELECT DISTINCT hc.repo_id repoId,
      hc.source_file sourceFile,hm.id methodId,sym.id symbolId
    FROM cds_services svc JOIN cds_operations op ON op.service_id=svc.id
    JOIN repositories r ON r.id=svc.repo_id
    JOIN graph_edges edge ON edge.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'
      AND edge.status='resolved' AND edge.from_kind='operation'
      AND edge.from_id=CAST(op.id AS TEXT)
    JOIN handler_methods hm ON hm.id=CAST(edge.to_id AS INTEGER)
    JOIN handler_classes hc ON hc.id=hm.handler_class_id
    LEFT JOIN symbols sym ON sym.repo_id=hc.repo_id
      AND sym.source_file=hc.source_file
      AND sym.qualified_name=hc.class_name || '.' || hm.method_name
      AND sym.start_line=hm.source_line
    WHERE (? IS NULL OR r.workspace_id=?)
      AND (? IS NULL OR svc.repo_id=?) AND svc.service_path=?
      AND (op.operation_path=? OR op.operation_name=?)
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.handlerKind'),
        CASE WHEN hm.decorator_kind='Event' THEN 'event'
          WHEN hm.decorator_kind IN ('Action','Func','On') THEN 'operation'
          ELSE 'unsupported' END)='operation'
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On')
          THEN 1 ELSE 0 END)=1
    ORDER BY hc.repo_id,hc.id,hm.id`).all(
      workspaceId, workspaceId, repoId, repoId,
      servicePath, operation, operation,
    ) as HandlerSelectorRow[];
}

function handlerClassScope(
  rows: HandlerSelectorRow[],
  requested: string,
): SelectorSourceScope {
  const ambiguity = handlerSelectorAmbiguity(rows, requested, 'class');
  if (ambiguity) return { diagnostics: [ambiguity] };
  const executable = rows.filter((row) => typeof row.symbolId === 'number');
  const repoId = numericValue(rows[0]?.repoId);
  if (executable.length > 0) {
    const scope = executableScope(executable, repoId);
    const warning = executable.some((row) => typeof row.methodId === 'number')
      ? handlerDecoratorsNotIndexedDiagnostic(rows[0])
      : handlerMethodsNotIndexedDiagnostic(rows[0]);
    return warning ? { ...scope, diagnostics: [warning] } : scope;
  }
  const first = rows[0];
  return {
    repoId,
    diagnostics: [handlerMethodsNotIndexedDiagnostic(first)],
  };
}

function handlerMethodScope(
  rows: HandlerSelectorRow[],
  fallbackRepoId: number | undefined,
  requested: string,
): SelectorSourceScope {
  const ambiguity = handlerSelectorAmbiguity(rows, requested, 'method');
  return ambiguity
    ? { diagnostics: [ambiguity] }
    : executableScope(rows, fallbackRepoId);
}

function handlerSelectorAmbiguity(
  rows: HandlerSelectorRow[],
  requested: string,
  matchKind: 'class' | 'method',
): Record<string, unknown> | undefined {
  const candidates = handlerSelectorCandidates(rows, matchKind);
  if (candidates.length < 2) return undefined;
  const repoCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (typeof candidate.repoName !== 'string') continue;
    repoCounts.set(
      candidate.repoName,
      (repoCounts.get(candidate.repoName) ?? 0) + 1,
    );
  }
  const suggestions = candidates.flatMap((candidate) => {
    const repoName = typeof candidate.repoName === 'string'
      ? candidate.repoName
      : undefined;
    if (repoName && repoCounts.get(repoName) === 1)
      return [`--repo ${repoName} --handler ${requested}`];
    if (matchKind === 'method' && typeof candidate.className === 'string')
      return [`${repoName ? `--repo ${repoName} ` : ''}--handler ${candidate.className}`];
    return [];
  });
  const projection = boundedSelectorCandidates(candidates);
  const suggestionProjection = boundedSelectorSuggestions(suggestions);
  return {
    severity: 'warning',
    code: 'trace_start_ambiguous',
    message: 'Handler selector matched multiple executable scopes and was not selected automatically',
    selectorKind: 'handler',
    requestedHandler: requested,
    resolutionStage: 'handler',
    resolutionStatus: 'ambiguous_handler',
    candidates: projection.items,
    candidateCount: projection.totalCount,
    shownCandidateCount: projection.shownCount,
    omittedCandidateCount: projection.omittedCount,
    selectorSuggestions: suggestionProjection.items,
    selectorSuggestionCount: suggestionProjection.totalCount,
    shownSelectorSuggestionCount: suggestionProjection.shownCount,
    omittedSelectorSuggestionCount: suggestionProjection.omittedCount,
    remediation: suggestions.length > 0
      ? 'Use one of the scoped handler selectors shown.'
      : 'No current CLI selector uniquely identifies these duplicate handler classes.',
  };
}

function handlerSelectorCandidates(
  rows: HandlerSelectorRow[],
  matchKind: 'class' | 'method',
): Array<Record<string, unknown>> {
  const candidates = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const identity = matchKind === 'class'
      ? `class:${String(row.handlerClassId)}`
      : `method:${String(row.repoId)}:${String(row.symbolId ?? row.methodId)}`;
    candidates.set(identity, {
      handlerClassId: row.handlerClassId,
      repoId: row.repoId,
      repoName: row.repoName,
      className: row.className,
      sourceFile: row.sourceFile,
      sourceLine: row.sourceLine,
      matchKind,
    });
  }
  return [...candidates.values()].sort((left, right) =>
    String(left.repoName ?? '').localeCompare(String(right.repoName ?? ''))
    || String(left.className ?? '').localeCompare(String(right.className ?? ''))
    || String(left.sourceFile ?? '').localeCompare(String(right.sourceFile ?? '')));
}

function executableScope(
  rows: HandlerSelectorRow[],
  fallbackRepoId: number | undefined,
): SelectorSourceScope {
  const files = rows.flatMap((row) => row.sourceFile ? [row.sourceFile] : []);
  const symbols = rows.flatMap((row) => typeof row.symbolId === 'number'
    ? [row.symbolId] : []);
  if (files.length === 0 || symbols.length === 0) return { repoId: fallbackRepoId };
  return {
    files: new Set(files),
    symbols: new Set(symbols),
    repoId: numericValue(rows[0]?.repoId) ?? fallbackRepoId,
  };
}

function handlerMethodsNotIndexedDiagnostic(
  row: HandlerSelectorRow | undefined,
): Record<string, unknown> {
  return {
    severity: 'warning',
    code: 'handler_methods_not_indexed',
    message: `Handler class ${row?.className ?? 'unknown'} has no indexed executable methods`,
    selectorKind: 'handler',
    className: row?.className,
    sourceFile: row?.sourceFile,
    sourceLine: row?.sourceLine,
    observedDecoratorNames: stringEvidenceArray(
      row?.classEvidence, 'observedDecoratorNames',
    ),
    unsupportedDecoratorNames: stringEvidenceArray(
      row?.classEvidence, 'unsupportedDecoratorNames',
    ),
    remediation: 'Use a supported CAP handler decorator on at least one class method and re-index the workspace.',
  };
}

function handlerDecoratorsNotIndexedDiagnostic(
  row: HandlerSelectorRow | undefined,
): Record<string, unknown> | undefined {
  const names = stringEvidenceArray(
    row?.classEvidence, 'unsupportedDecoratorNames',
  );
  const methods = arrayEvidence(row?.classEvidence, 'unsupportedMethods');
  if (names.length === 0 && methods.length === 0) return undefined;
  return {
    severity: 'warning',
    code: 'handler_decorators_not_indexed',
    message: `Handler class ${row?.className ?? 'unknown'} contains methods that were not indexed`,
    selectorKind: 'handler',
    className: row?.className,
    sourceFile: row?.sourceFile,
    sourceLine: row?.sourceLine,
    unsupportedDecoratorNames: names,
    unsupportedMethods: methods,
    remediation: 'Use a supported CAP handler decorator shape and re-index the workspace.',
  };
}

function evidenceRecord(
  evidenceJson: string | null | undefined,
): Record<string, unknown> {
  if (!evidenceJson) return {};
  try {
    const parsed = JSON.parse(evidenceJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringEvidenceArray(
  evidenceJson: string | null | undefined,
  key: string,
): string[] {
  const value = evidenceRecord(evidenceJson)[key];
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === 'string'))].sort()
    : [];
}

function arrayEvidence(
  evidenceJson: string | null | undefined,
  key: string,
): Array<Record<string, unknown>> {
  const value = evidenceRecord(evidenceJson)[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function numericValue(value: number | null | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/') ? value.slice(1) : value;
}
export function ambiguousStartDiagnostic(
  requested: string,
  candidates: Array<Record<string, unknown>>,
  message: string,
): Record<string, unknown> {
  const serviceSuggestions = [...new Set(candidates
    .flatMap((row) => typeof row.servicePath === 'string'
      ? [`--service ${row.servicePath}`]
      : []))].sort();
  const projection = boundedSelectorCandidates(candidates);
  const serviceProjection = boundedSelectorSuggestions(serviceSuggestions);
  const selectorProjection = boundedSelectorSuggestions(fullSelectorSuggestions(candidates));
  return {
    severity: 'warning',
    code: 'trace_start_ambiguous',
    message,
    normalizedSelectorValue: requested,
    resolutionStage: 'operation',
    resolutionStatus: 'ambiguous_operation',
    candidates: projection.items,
    candidateCount: projection.totalCount,
    shownCandidateCount: projection.shownCount,
    omittedCandidateCount: projection.omittedCount,
    serviceSuggestions: serviceProjection.items,
    serviceSuggestionCount: serviceProjection.totalCount,
    shownServiceSuggestionCount: serviceProjection.shownCount,
    omittedServiceSuggestionCount: serviceProjection.omittedCount,
    selectorSuggestions: selectorProjection.items,
    selectorSuggestionCount: selectorProjection.totalCount,
    shownSelectorSuggestionCount: selectorProjection.shownCount,
    omittedSelectorSuggestionCount: selectorProjection.omittedCount,
  };
}

function boundedSelectorCandidates(
  candidates: Array<Record<string, unknown>>,
): BoundedProjection<Record<string, unknown>> {
  return projectBounded(candidates, (left, right) =>
    String(left.repoName ?? '').localeCompare(String(right.repoName ?? ''))
    || String(left.servicePath ?? '').localeCompare(String(right.servicePath ?? ''))
    || String(left.className ?? '').localeCompare(String(right.className ?? ''))
    || String(left.sourceFile ?? '').localeCompare(String(right.sourceFile ?? ''))
    || Number(left.sourceLine ?? 0) - Number(right.sourceLine ?? 0)
    || Number(left.handlerClassId ?? left.operationId ?? 0)
      - Number(right.handlerClassId ?? right.operationId ?? 0));
}

function boundedSelectorSuggestions(
  suggestions: string[],
): BoundedProjection<string> {
  return projectBounded([...new Set(suggestions)], (left, right) =>
    left.localeCompare(right));
}
function fullSelectorSuggestions(
  candidates: Array<Record<string, unknown>>,
): string[] {
  const includeRepo = new Set(candidates.map((row) => row.repoName)).size > 1;
  return [...new Set(candidates.flatMap((row) => {
    if (typeof row.servicePath !== 'string'
      || typeof row.operationPath !== 'string') return [];
    const repoSelector = includeRepo && typeof row.repoName === 'string'
      ? `--repo ${row.repoName} `
      : '';
    return [
      `${repoSelector}--service ${row.servicePath} --path ${row.operationPath}`,
    ];
  }))].sort();
}
