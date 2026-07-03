import type { Db } from '../db/connection.js';
import { applyVariables } from './dynamic-edge-resolver.js';
import { resolveOperation } from './service-resolver.js';
import { linkHelperPackages } from './helper-package-linker.js';
export interface LinkWorkspaceResult {
  edgeCount: number;
  unresolvedCount: number;
  resolvedCount: number;
  ambiguousCount: number;
  dynamicCount: number;
  terminalCount: number;
  dependencyResolvedCount: number;
  dependencyAmbiguousCount: number;
  implementationResolvedCount: number;
  implementationAmbiguousCount: number;
  implementationUnresolvedCount: number;
}
export function linkWorkspace(db: Db, workspaceId: number, vars: Record<string, string> = {}): LinkWorkspaceResult {
  return db.transaction(() => {
    const generation = nextGraphGeneration(db, workspaceId);
    db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
    const deps = linkHelperPackages(db, workspaceId, generation);
    const callSummary = linkCalls(db, workspaceId, vars, generation);
    const impl = linkImplementations(db, workspaceId, generation);
    db.prepare("UPDATE repositories SET graph_generation=?, graph_stale_reason=NULL, graph_stale_at=NULL WHERE workspace_id=?").run(generation, workspaceId);
    return { ...callSummary, edgeCount: deps.edgeCount + callSummary.edgeCount + impl.edgeCount, dependencyResolvedCount: deps.resolvedCount, dependencyAmbiguousCount: deps.ambiguousCount, implementationResolvedCount: impl.resolvedCount, implementationAmbiguousCount: impl.ambiguousCount, implementationUnresolvedCount: impl.unresolvedCount };
  });
}
function nextGraphGeneration(db: Db, workspaceId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(graph_generation),0) generation FROM repositories WHERE workspace_id=?').get(workspaceId) as { generation?: number } | undefined;
  return Number(row?.generation ?? 0) + 1;
}
function linkCalls(db: Db, workspaceId: number, vars: Record<string, string>, generation: number): Omit<LinkWorkspaceResult, 'dependencyResolvedCount' | 'dependencyAmbiguousCount' | 'implementationResolvedCount' | 'implementationAmbiguousCount' | 'implementationUnresolvedCount'> {
  let edgeCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db.prepare(`SELECT c.*,r.name repoName,b.alias,b.alias_expr aliasExpr,b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,b.helper_chain_json helperChainJson,req.service_path requireServicePath,req.destination requireDestination FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id LEFT JOIN service_bindings b ON b.id=c.service_binding_id LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias WHERE r.workspace_id=?`).all(workspaceId) as Array<Record<string, unknown>>;
  for (const call of calls) {
    const result = insertCallEdge(db, workspaceId, call, vars, generation);
    edgeCount += 1;
    resolvedCount += result.status === 'resolved' ? 1 : 0;
    unresolvedCount += result.status === 'unresolved' ? 1 : 0;
    ambiguousCount += result.status === 'ambiguous' ? 1 : 0;
    dynamicCount += result.status === 'dynamic' ? 1 : 0;
    terminalCount += result.status === 'terminal' ? 1 : 0;
  }
  return { edgeCount, unresolvedCount, resolvedCount, ambiguousCount, dynamicCount, terminalCount };
}
function insertCallEdge(db: Db, workspaceId: number, call: Record<string, unknown>, vars: Record<string, string>, generation: number): { status: string } {
  const callType = String(call.call_type);
  const op = applyVariables(String(call.operation_path_expr ?? ''), vars);
  const servicePath = applyVariables((call.servicePathExpr as string | undefined) ?? (call.requireServicePath as string | undefined), vars);
  const destination = (call.destinationExpr as string | undefined) ?? (call.requireDestination as string | undefined);
  const isDynamic = Boolean(Number(call.isDynamic ?? 0));
  const resolution = callType.startsWith('remote') ? resolveOperation(db, { servicePath, operationPath: op, alias: applyVariables((call.aliasExpr as string | undefined) ?? (call.alias as string | undefined), vars), destination: destination ? applyVariables(destination, vars) : undefined, isDynamic, hasExplicitOverride: Object.keys(vars).length > 0 }, workspaceId) : { status: 'unresolved' as const, candidates: [], reasons: [] };
  const evidence = callEvidence(call, resolution, servicePath, op, destination ? applyVariables(destination, vars) : undefined);
  if (resolution.target) {
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'call', String(call.id), 'operation', String(resolution.target.operationId), resolution.target.score, JSON.stringify(evidence), isDynamic ? 1 : 0, generation);
    return { status: 'resolved' };
  }
  const edgeType = callType === 'local_db_query' ? 'HANDLER_RUNS_DB_QUERY' : callType === 'external_http' ? 'HANDLER_CALLS_EXTERNAL_HTTP' : callType === 'async_emit' ? 'HANDLER_EMITS_EVENT' : callType === 'async_subscribe' ? 'EVENT_CONSUMED_BY_HANDLER' : resolution.status === 'dynamic' ? 'DYNAMIC_EDGE_CANDIDATE' : 'UNRESOLVED_EDGE';
  const status = edgeType === 'DYNAMIC_EDGE_CANDIDATE' ? 'dynamic' : resolution.status === 'ambiguous' ? 'ambiguous' : edgeType === 'UNRESOLVED_EDGE' ? 'unresolved' : 'terminal';
  const unresolvedReason = status === 'terminal' ? null : String(call.unresolved_reason ?? (resolution.status === 'ambiguous' ? 'Ambiguous operation candidates require a strong service signal' : resolution.status === 'dynamic' ? `Dynamic target requires runtime variable overrides: ${(resolution.reasons.length ? resolution.reasons : ['missing runtime variables']).join(', ')}` : 'No indexed target operation matched'));
  db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, edgeType, status, 'call', String(call.id), callType.startsWith('async_') ? 'event' : 'external', String(call.event_name_expr ?? call.query_entity ?? op ?? call.id), Number(call.confidence ?? 0.2), JSON.stringify(evidence), isDynamic || resolution.status === 'dynamic' ? 1 : 0, unresolvedReason, generation);
  return { status };
}
function callEvidence(call: Record<string, unknown>, resolution: { target?: { repoName?: string; operationName?: string }; candidates: unknown[]; status: string; reasons: string[] }, servicePath: string | undefined, op: string | undefined, destination: string | undefined): Record<string, unknown> {
  return { sourceFile: call.source_file, sourceLine: call.source_line, file: call.source_file, line: call.source_line, repo: call.repoName, serviceAlias: call.alias, serviceAliasExpr: call.aliasExpr, destination, servicePath, operationPath: op, targetRepo: resolution.target?.repoName, targetOperation: resolution.target?.operationName, helperChain: call.helperChainJson ? (JSON.parse(String(call.helperChainJson)) as unknown) : undefined, candidates: resolution.candidates, candidateCount: resolution.candidates.length, resolutionStatus: resolution.status, resolutionReasons: resolution.reasons, analysisCompleteness: call.unresolved_reason ? 'partial' : 'complete', parserWarning: call.unresolved_reason ? { code: 'parser_warning', message: call.unresolved_reason } : undefined };
}

function linkImplementations(db: Db, workspaceId: number, generation: number): { edgeCount: number; resolvedCount: number; ambiguousCount: number; unresolvedCount: number } {
  const operations = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,o.operation_name operationName,s.service_path servicePath,s.repo_id modelRepoId,r.name modelRepo,r.package_name modelPackage,r.kind modelKind FROM cds_operations o JOIN cds_services s ON s.id=o.service_id JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=?`).all(workspaceId) as Array<Record<string, unknown>>;
  let edgeCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  for (const operation of operations) {
    const candidates = rankedImplementationCandidates(db, workspaceId, operation);
    if (candidates.length === 0) continue;
    const accepted = candidates.filter((candidate) => candidate.accepted);
    const topScore = accepted[0]?.score ?? 0;
    const winners = accepted.filter((candidate) => candidate.score === topScore);
    const unique = winners.length === 1 ? winners[0] : undefined;
    const evidence = {
      servicePath: operation.servicePath,
      operationPath: operation.operationPath,
      operationName: operation.operationName,
      modelPackage: { id: operation.modelRepoId, name: operation.modelRepo, packageName: operation.modelPackage },
      candidates: candidates.map((candidate, index) => candidateEvidence(candidate, index + 1)),
    };
    if (accepted.length === 0) {
      db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'OPERATION_IMPLEMENTED_BY_HANDLER', 'unresolved', 'operation', graphId(operation.operationId), 'handler_method_candidates', candidates.map((row) => graphId(row.methodId)).join(','), 0, JSON.stringify(evidence), 0, 'No implementation candidate passed policy', generation);
      edgeCount += 1;
      unresolvedCount += 1;
      continue;
    }
    db.prepare('INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, 'OPERATION_IMPLEMENTED_BY_HANDLER', unique ? 'resolved' : 'ambiguous', 'operation', graphId(operation.operationId), unique ? 'handler_method' : 'handler_method_candidates', unique ? graphId(unique.methodId) : winners.map((row) => graphId(row.methodId)).join(','), unique ? 0.95 : 0.5, JSON.stringify(evidence), 0, unique ? null : 'Ambiguous registered handler implementation candidates', generation);
    edgeCount += 1;
    if (unique) resolvedCount += 1;
    else ambiguousCount += 1;
  }
  return { edgeCount, resolvedCount, ambiguousCount, unresolvedCount };
}
interface ImplementationCandidate extends Record<string, unknown> {
  methodId: number;
  score: number;
  accepted: boolean;
  acceptedReasons: string[];
  rejectedReasons: string[];
}
function rankedImplementationCandidates(db: Db, workspaceId: number, operation: Record<string, unknown>): ImplementationCandidate[] {
  const rows = implementationCandidates(db, workspaceId, operation);
  return rows.map((row) => scoreImplementationCandidate(row, operation)).sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)) || a.methodId - b.methodId);
}
function implementationCandidates(db: Db, workspaceId: number, operation: Record<string, unknown>): Array<Record<string, unknown>> {
  const modelRepoGraphId = graphId(operation.modelRepoId);
  return db.prepare(`SELECT DISTINCT
      hm.id methodId,
      hc.id classId,
      hc.class_name className,
      hc.source_file sourceFile,
      hc.source_line sourceLine,
      hr.repo_id applicationRepoId,
      hr.registration_file registrationFile,
      hr.registration_line registrationLine,
      hr.registration_kind registrationKind,
      hr.import_source importSource,
      handlerRepo.id handlerRepoId,
      handlerRepo.name handlerRepo,
      handlerRepo.package_name handlerPackage,
      appRepo.name applicationRepo,
      appRepo.package_name applicationPackage,
      ? modelRepoId,
      ? modelRepo,
      ? modelPackage,
      ? modelKind,
      ? servicePath,
      ? operationPath,
      ? operationName,
      CASE WHEN appRepo.id=? THEN 1 ELSE 0 END modelIsApplicationRepo,
      CASE WHEN handlerRepo.id=? THEN 1 ELSE 0 END modelIsHandlerRepo,
      CASE WHEN appRepo.id=handlerRepo.id THEN 1 ELSE 0 END sameRepoRegistration,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService WHERE localService.repo_id=appRepo.id AND localService.service_path=?) THEN 1 ELSE 0 END localServicePathMatch,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService WHERE localService.repo_id=appRepo.id) THEN 1 ELSE 0 END applicationHasLocalServices,
      CASE WHEN EXISTS (SELECT 1 FROM handler_registrations localReg JOIN handler_classes localClass ON (localClass.id=localReg.handler_class_id OR localClass.class_name=localReg.class_name) JOIN handler_methods localMethod ON localMethod.handler_class_id=localClass.id WHERE localReg.repo_id=appRepo.id AND (localMethod.decorator_value=? OR localMethod.decorator_value=? OR localMethod.method_name=?)) THEN 1 ELSE 0 END applicationHasLocalRegistrationForOperation,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT) AND dep.to_id=?) THEN 1 ELSE 0 END appDependsOnModel,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT) AND dep.to_id=CAST(handlerRepo.id AS TEXT)) THEN 1 ELSE 0 END appDependsOnHandler,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved' AND dep.from_kind='repo' AND dep.from_id=CAST(handlerRepo.id AS TEXT) AND dep.to_id=?) THEN 1 ELSE 0 END handlerDependsOnModel
    FROM handler_methods hm
    JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories handlerRepo ON handlerRepo.id=hc.repo_id
    JOIN handler_registrations hr ON (hr.handler_class_id=hc.id OR (hr.class_name=hc.class_name AND (hr.repo_id=hc.repo_id OR hr.import_source IS NOT NULL)))
    JOIN repositories appRepo ON appRepo.id=hr.repo_id
    WHERE appRepo.workspace_id=?
      AND (hm.decorator_value=? OR hm.decorator_value=? OR hm.method_name=?)`).all(
        operation.modelRepoId,
        operation.modelRepo,
        operation.modelPackage,
        operation.modelKind,
        operation.servicePath,
        operation.operationPath,
        operation.operationName,
        operation.modelRepoId,
        operation.modelRepoId,
        operation.servicePath,
        normalizedOperation(String(operation.operationPath ?? '')),
        operation.operationName,
        operation.operationName,
        modelRepoGraphId,
        modelRepoGraphId,
        workspaceId,
        normalizedOperation(String(operation.operationPath ?? '')),
        operation.operationName,
        operation.operationName,
      ) as Array<Record<string, unknown>>;
}
function scoreImplementationCandidate(row: Record<string, unknown>, operation: Record<string, unknown>): ImplementationCandidate {
  const acceptedReasons: string[] = [];
  const rejectedReasons: string[] = [];
  let score = 0;
  const modelIsApplicationRepo = flag(row.modelIsApplicationRepo);
  const modelIsHandlerRepo = flag(row.modelIsHandlerRepo);
  const localServicePathMatch = flag(row.localServicePathMatch);
  const applicationHasLocalServices = flag(row.applicationHasLocalServices);
  const appDependsOnModel = flag(row.appDependsOnModel);
  const applicationHasLocalRegistrationForOperation = flag(row.applicationHasLocalRegistrationForOperation);
  const appDependsOnHandler = flag(row.appDependsOnHandler);
  const handlerDependsOnModel = flag(row.handlerDependsOnModel);
  const importSource = typeof row.importSource === 'string' && row.importSource.length > 0;
  const sameRepoRegistration = flag(row.sameRepoRegistration);
  const modelOriented = row.modelKind === 'cap-db-model' || !applicationHasLocalRegistrationForOperation;
  const methodMatches = true;
  const registeredAndLinked = sameRepoRegistration && importSource;
  const helperOwned = modelOriented && methodMatches && registeredAndLinked && sameRepoRegistration && !applicationHasLocalServices && !modelIsApplicationRepo && !modelIsHandlerRepo && !localServicePathMatch && !appDependsOnModel && !appDependsOnHandler && !handlerDependsOnModel;
  if (modelIsApplicationRepo) {
    score += 100;
    acceptedReasons.push('model package equals registration package');
  }
  if (modelIsHandlerRepo) {
    score += 100;
    acceptedReasons.push('model package equals handler package');
  }
  if (localServicePathMatch) {
    score += 80;
    acceptedReasons.push('registration package contains exact local service path');
  } else if (applicationHasLocalServices && !appDependsOnModel && !modelIsApplicationRepo) {
    rejectedReasons.push(`registration package has local services but none match ${String(operation.servicePath ?? '')}`);
  }
  if (appDependsOnModel) {
    score += 70;
    acceptedReasons.push('registration package depends on model package');
  }
  if (appDependsOnHandler) {
    score += 30;
    acceptedReasons.push('registration package depends on handler package');
  }
  if (handlerDependsOnModel) {
    score += 20;
    acceptedReasons.push('handler package depends on model package');
  }
  if (helperOwned) {
    score += 60;
    acceptedReasons.push('unique registered helper implementation for model-only operation');
  }
  if (importSource) {
    score += 10;
    acceptedReasons.push('registration imports handler class');
  }
  const hasOwnership = modelIsApplicationRepo || modelIsHandlerRepo;
  const hasCrossPackage = appDependsOnModel && (modelIsHandlerRepo || appDependsOnHandler || !importSource);
  const contradicted = applicationHasLocalServices && !localServicePathMatch && !appDependsOnModel && !hasOwnership;
  if (!hasOwnership && !localServicePathMatch && !hasCrossPackage && !helperOwned) rejectedReasons.push('missing direct ownership, exact local service path, or validated cross-package dependency evidence');
  const accepted = !contradicted && (hasOwnership || localServicePathMatch || hasCrossPackage || handlerDependsOnModel || helperOwned);
  if (!accepted && rejectedReasons.length === 0) rejectedReasons.push('candidate did not meet implementation ownership policy');
  return { ...row, methodId: Number(row.methodId), score, accepted, acceptedReasons, rejectedReasons };
}
function candidateEvidence(candidate: ImplementationCandidate, rank: number): Record<string, unknown> {
  return {
    rank,
    score: candidate.score,
    accepted: candidate.accepted,
    acceptedReasons: candidate.acceptedReasons,
    rejectedReasons: candidate.rejectedReasons,
    methodId: candidate.methodId,
    classId: candidate.classId,
    className: candidate.className,
    sourceFile: candidate.sourceFile,
    sourceLine: candidate.sourceLine,
    registration: { file: candidate.registrationFile, line: candidate.registrationLine, kind: candidate.registrationKind, importSource: candidate.importSource },
    applicationPackage: { id: candidate.applicationRepoId, name: candidate.applicationRepo, packageName: candidate.applicationPackage },
    handlerPackage: { id: candidate.handlerRepoId, name: candidate.handlerRepo, packageName: candidate.handlerPackage },
    modelPackage: { id: candidate.modelRepoId, name: candidate.modelRepo, packageName: candidate.modelPackage },
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    operationName: candidate.operationName,
    signals: {
      directOwnership: { modelIsApplicationRepo: flag(candidate.modelIsApplicationRepo), modelIsHandlerRepo: flag(candidate.modelIsHandlerRepo) },
      localServicePathMatch: flag(candidate.localServicePathMatch),
      applicationHasLocalServices: flag(candidate.applicationHasLocalServices),
      applicationHasLocalRegistrationForOperation: flag(candidate.applicationHasLocalRegistrationForOperation),
      appDependsOnModel: flag(candidate.appDependsOnModel),
      appDependsOnHandler: flag(candidate.appDependsOnHandler),
      handlerDependsOnModel: flag(candidate.handlerDependsOnModel),
      sameRepoRegistration: flag(candidate.sameRepoRegistration),
    },
  };
}
function flag(value: unknown): boolean {
  return Boolean(Number(value ?? 0));
}
function graphId(value: unknown): string {
  return String(value);
}
function normalizedOperation(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}
