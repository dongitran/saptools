import type { Db } from '../db/connection.js';
import { implementationHintSuggestionProjection } from '../trace/implementation-hints.js';
import { normalizeDecoratorOperationSignal, normalizedOperationName } from './operation-decorator-normalizer.js';
import {
  boundedImplementationEvidence,
  boundedImplementationTargetIds,
  displayImplementationCandidates,
  selectedHandlerProvenance,
} from './001-implementation-evidence-projection.js';

interface ImplementationCandidate extends Record<string, unknown> {
  methodId: number;
  registrations?: Array<Record<string, unknown>>;
  score: number;
  accepted: boolean;
  acceptedReasons: string[];
  rejectedReasons: string[];
}

interface ImplementationDecision {
  candidates: ImplementationCandidate[];
  accepted: ImplementationCandidate[];
  selected: ImplementationCandidate[];
  unique?: ImplementationCandidate;
  evidence: Record<string, unknown>;
  evidenceWithHints: Record<string, unknown>;
}

export function linkImplementations(
  db: Db,
  workspaceId: number,
  generation: number,
): { edgeCount: number; resolvedCount: number; ambiguousCount: number; unresolvedCount: number } {
  const operations = workspaceOperations(db, workspaceId);
  let edgeCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  for (const operation of operations) {
    const decision = implementationDecision(db, workspaceId, operation, true);
    if (decision.candidates.length === 0) continue;
    const status = decision.unique ? 'resolved' : decision.accepted.length > 0
      ? 'ambiguous'
      : 'unresolved';
    insertImplementationEdge(db, workspaceId, generation, operation, decision, status);
    edgeCount += 1;
    if (status === 'resolved') resolvedCount += 1;
    else if (status === 'ambiguous') ambiguousCount += 1;
    else unresolvedCount += 1;
  }
  return { edgeCount, resolvedCount, ambiguousCount, unresolvedCount };
}

export function canonicalImplementationEvidence(
  db: Db,
  operationId: string | number,
): Record<string, unknown> | undefined {
  const operation = operationById(db, operationId);
  const workspaceId = numberValue(operation?.workspaceId);
  if (!operation || workspaceId === undefined) return undefined;
  return implementationDecision(db, workspaceId, operation, false).evidenceWithHints;
}

function workspaceOperations(db: Db, workspaceId: number): Array<Record<string, unknown>> {
  const rows = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,
      o.operation_name operationName,o.provenance provenance,o.base_operation_id baseOperationId,
      s.service_path servicePath,s.repo_id modelRepoId,r.name modelRepo,
      r.package_name modelPackage,r.kind modelKind
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id WHERE r.workspace_id=?`).all(workspaceId);
  return rows;
}

function operationById(
  db: Db,
  operationId: string | number,
): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,
      o.operation_name operationName,o.provenance provenance,o.base_operation_id baseOperationId,
      s.service_path servicePath,s.repo_id modelRepoId,r.name modelRepo,
      r.package_name modelPackage,r.kind modelKind,r.workspace_id workspaceId
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operationId);
  return row;
}

function implementationDecision(
  db: Db,
  workspaceId: number,
  operation: Record<string, unknown>,
  recordDiagnostics: boolean,
): ImplementationDecision {
  const implementationContext = implementationContextForOperation(db, operation);
  const candidates = rankedImplementationCandidates(
    db, workspaceId, implementationContext, recordDiagnostics,
  );
  const accepted = candidates.filter((candidate) => candidate.accepted);
  const topScore = accepted[0]?.score ?? 0;
  const winners = accepted.filter((candidate) => candidate.score === topScore);
  const duplicateFamilies = duplicatePackageFamilies(accepted);
  const duplicatePackageAmbiguous = duplicateFamilies.length > 0
    && !accepted.some(hasDirectOwnershipEvidence);
  const selected = duplicatePackageAmbiguous ? accepted : winners;
  const unique = !duplicatePackageAmbiguous && winners.length === 1
    ? winners[0]
    : undefined;
  const ambiguityReasons = duplicatePackageAmbiguous
    ? ['duplicate_package_name_candidates']
    : winners.length > 1 ? ['multiple_equal_score_implementation_candidates'] : [];
  const evidence = implementationEvidence(
    operation, implementationContext, candidates, duplicateFamilies, ambiguityReasons,
    unique,
  );
  const hintProjection = implementationHintSuggestionProjection(evidence);
  return {
    candidates,
    accepted,
    selected,
    unique,
    evidence,
    evidenceWithHints: unique
      ? evidence
      : {
        ...evidence,
        implementationHintSuggestions: hintProjection.suggestions,
        implementationHintSuggestionCount: hintProjection.suggestionCount,
        shownImplementationHintSuggestionCount: hintProjection.shownSuggestionCount,
        omittedImplementationHintSuggestionCount: hintProjection.omittedSuggestionCount,
      },
  };
}

function insertImplementationEdge(
  db: Db,
  workspaceId: number,
  generation: number,
  operation: Record<string, unknown>,
  decision: ImplementationDecision,
  status: 'resolved' | 'ambiguous' | 'unresolved',
): void {
  const targetCandidates = status === 'unresolved'
    ? decision.candidates
    : decision.selected;
  const targetProjection = boundedImplementationTargetIds(targetCandidates);
  const targetIds = targetProjection.items;
  const toId = status === 'resolved'
    ? graphId(decision.unique?.methodId)
    : targetIds.join(',');
  const reason = status === 'unresolved'
    ? 'No implementation candidate passed policy'
    : status === 'ambiguous'
      ? 'Ambiguous registered handler implementation candidates'
      : null;
  db.prepare(`INSERT INTO graph_edges(workspace_id,edge_type,status,from_kind,from_id,
      to_kind,to_id,confidence,evidence_json,is_dynamic,unresolved_reason,generation)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    workspaceId,
    'OPERATION_IMPLEMENTED_BY_HANDLER',
    status,
    'operation',
    graphId(operation.operationId),
    status === 'resolved' ? 'handler_method' : 'handler_method_candidates',
    toId,
    status === 'resolved' ? 0.95 : status === 'ambiguous' ? 0.5 : 0,
    JSON.stringify(boundedImplementationEvidence(
      decision.evidenceWithHints, targetProjection.totalCount,
    )),
    0,
    reason,
    generation,
  );
}

function implementationEvidence(
  operation: Record<string, unknown>,
  context: Record<string, unknown>,
  candidates: ImplementationCandidate[],
  duplicateFamilies: Array<Record<string, unknown>>,
  ambiguityReasons: string[],
  selected: ImplementationCandidate | undefined,
): Record<string, unknown> {
  return {
    servicePath: operation.servicePath,
    operationPath: operation.operationPath,
    operationName: operation.operationName,
    modelPackage: {
      id: operation.modelRepoId,
      name: operation.modelRepo,
      packageName: operation.modelPackage,
    },
    implementationSource: context.operationId === operation.operationId
      ? 'direct_or_concrete_override'
      : 'inherited_from_base_operation',
    baseOperationId: operation.baseOperationId,
    implementationOperationId: context.operationId,
    ambiguityReasons,
    candidateFamilies: duplicateFamilies,
    selectedHandler: selected
      ? selectedHandlerProvenance(selectedHandlerSource(selected))
      : undefined,
    candidates: displayImplementationCandidates(
      candidates.map((candidate, index) => candidateEvidence(candidate, index + 1)),
      selected?.methodId,
    ),
  };
}


function implementationContextForOperation(
  db: Db,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.provenance !== 'inherited' || !operation.baseOperationId) return operation;
  const base = db.prepare(`SELECT o.id operationId,o.operation_path operationPath,
      o.operation_name operationName,o.provenance provenance,o.base_operation_id baseOperationId,
      s.service_path servicePath,s.repo_id modelRepoId,r.name modelRepo,
      r.package_name modelPackage,r.kind modelKind
    FROM cds_operations o JOIN cds_services s ON s.id=o.service_id
    JOIN repositories r ON r.id=s.repo_id WHERE o.id=?`).get(operation.baseOperationId);
  return base ? {
    ...base,
    effectiveOperationId: operation.operationId,
    effectiveServicePath: operation.servicePath,
    effectiveOperationPath: operation.operationPath,
  } : operation;
}

function rankedImplementationCandidates(
  db: Db,
  workspaceId: number,
  operation: Record<string, unknown>,
  recordDiagnostics: boolean,
): ImplementationCandidate[] {
  const rows = implementationCandidates(db, workspaceId, operation);
  if (recordDiagnostics) recordRegistrationInvariantDiagnostics(
    db, rows.filter((row) => !validRegistrationPair(row)),
  );
  return deduplicateCandidates(rows.filter(validRegistrationPair)
    .map((row) => scoreImplementationCandidate(row, operation)))
    .sort((left, right) => right.score - left.score
      || String(left.className).localeCompare(String(right.className))
      || left.methodId - right.methodId);
}

function validRegistrationPair(row: Record<string, unknown>): boolean {
  if (row.registrationHandlerClassId === null || row.registrationHandlerClassId === undefined)
    return registrationPairingStrategy(row) !== 'unproven';
  return Number(row.registrationHandlerClassId) === Number(row.classId);
}

function registrationPairingStrategy(row: Record<string, unknown>): string {
  if (row.registrationHandlerClassId !== null && row.registrationHandlerClassId !== undefined)
    return 'exact_handler_class_id';
  if (Number(row.applicationRepoId) === Number(row.handlerRepoId))
    return 'same_repository_class_name_fallback';
  const source = stringValue(row.importSource);
  const separator = source?.lastIndexOf('#') ?? -1;
  if (!source || separator <= 0) return 'unproven';
  const moduleName = source.slice(0, separator);
  const importedName = source.slice(separator + 1);
  const matchesClass = importedName === row.className
    || (importedName === 'default' && row.registrationClassName === row.className);
  return moduleName === row.handlerPackage && matchesClass
    ? 'explicit_package_import'
    : 'unproven';
}

function recordRegistrationInvariantDiagnostics(
  db: Db,
  rows: Array<Record<string, unknown>>,
): void {
  const insert = db.prepare(`INSERT INTO diagnostics(repo_id,severity,code,message,
      source_file,source_line)
    SELECT ?,'error','handler_registration_class_mismatch',
      'Implementation candidate registration did not match its persisted handler class id',?,?
    WHERE NOT EXISTS (SELECT 1 FROM diagnostics WHERE repo_id=?
      AND code='handler_registration_class_mismatch' AND source_file=? AND source_line=?)`);
  for (const row of rows) insert.run(
    row.applicationRepoId, row.registrationFile, row.registrationLine,
    row.applicationRepoId, row.registrationFile, row.registrationLine,
  );
}

function deduplicateCandidates(rows: ImplementationCandidate[]): ImplementationCandidate[] {
  const merged = new Map<string, ImplementationCandidate>();
  for (const row of rows) {
    const key = [row.methodId, row.classId, row.handlerRepoId].join(':');
    const registration = registrationEvidence(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, registrations: [registration] });
      continue;
    }
    existing.registrations = uniqueRegistrations([
      ...(existing.registrations ?? []), registration,
    ]);
    existing.score = Math.max(existing.score, row.score);
    existing.accepted = existing.accepted || row.accepted;
    existing.acceptedReasons = [...new Set([...existing.acceptedReasons, ...row.acceptedReasons])];
    existing.rejectedReasons = [...new Set([...existing.rejectedReasons, ...row.rejectedReasons])];
  }
  return [...merged.values()];
}

function registrationEvidence(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.registrationId,
    handlerClassId: row.registrationHandlerClassId,
    file: row.registrationFile,
    line: row.registrationLine,
    kind: row.registrationKind,
    importSource: row.importSource,
    pairingStrategy: registrationPairingStrategy(row),
  };
}

function uniqueRegistrations(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function duplicatePackageFamilies(candidates: ImplementationCandidate[]): Array<Record<string, unknown>> {
  const byPackage = new Map<string, ImplementationCandidate[]>();
  for (const candidate of candidates) {
    const packageName = stringValue(candidate.handlerPackage);
    if (packageName) byPackage.set(packageName, [
      ...(byPackage.get(packageName) ?? []), candidate,
    ]);
  }
  return [...byPackage.entries()].filter(([, rows]) =>
    new Set(rows.map((row) => Number(row.handlerRepoId))).size > 1)
    .map(([packageName, rows]) => ({
      reason: 'duplicate_package_name_candidates',
      packageName,
      count: rows.length,
      repositories: rows.map((row) => row.handlerRepo).sort(),
    }));
}

function hasDirectOwnershipEvidence(candidate: ImplementationCandidate): boolean {
  return candidate.acceptedReasons.some((reason) => [
    'model package equals registration package',
    'model package equals handler package',
    'registration package contains exact local service path',
  ].includes(reason));
}

function implementationCandidates(
  db: Db,
  workspaceId: number,
  operation: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const modelRepoGraphId = graphId(operation.modelRepoId);
  return db.prepare(`SELECT DISTINCT
      hm.id methodId,hm.method_name methodName,hm.decorator_value decoratorValue,
      hm.decorator_raw_expression decoratorRawExpression,
      hm.decorator_resolution_json decoratorResolutionJson,hc.id classId,
      hc.class_name className,hc.source_file sourceFile,hm.source_line sourceLine,
      hr.id registrationId,hr.handler_class_id registrationHandlerClassId,
      hr.class_name registrationClassName,hr.repo_id applicationRepoId,
      hr.registration_file registrationFile,hr.registration_line registrationLine,
      hr.registration_kind registrationKind,hr.import_source importSource,
      handlerRepo.id handlerRepoId,handlerRepo.name handlerRepo,
      handlerRepo.package_name handlerPackage,appRepo.name applicationRepo,
      appRepo.package_name applicationPackage,? modelRepoId,? modelRepo,? modelPackage,
      ? modelKind,? servicePath,? operationPath,? operationName,
      CASE WHEN appRepo.id=? THEN 1 ELSE 0 END modelIsApplicationRepo,
      CASE WHEN handlerRepo.id=? THEN 1 ELSE 0 END modelIsHandlerRepo,
      CASE WHEN appRepo.id=handlerRepo.id THEN 1 ELSE 0 END sameRepoRegistration,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService
        WHERE localService.repo_id=appRepo.id AND localService.service_path=?)
        THEN 1 ELSE 0 END localServicePathMatch,
      CASE WHEN EXISTS (SELECT 1 FROM cds_services localService
        WHERE localService.repo_id=appRepo.id) THEN 1 ELSE 0 END applicationHasLocalServices,
      CASE WHEN EXISTS (SELECT 1 FROM handler_registrations localReg
        JOIN handler_classes localClass ON ((localReg.handler_class_id IS NOT NULL
          AND localClass.id=localReg.handler_class_id) OR (localReg.handler_class_id IS NULL
          AND localClass.class_name=localReg.class_name AND localClass.repo_id=localReg.repo_id))
        JOIN handler_methods localMethod ON localMethod.handler_class_id=localClass.id
        WHERE localReg.repo_id=appRepo.id
          AND COALESCE(json_extract(localMethod.decorator_resolution_json,'$.handlerKind'),
            CASE WHEN localMethod.decorator_kind='Event' THEN 'event'
              WHEN localMethod.decorator_kind IN ('Action','Func','On') THEN 'operation'
              ELSE 'unsupported' END)='operation'
          AND COALESCE(json_extract(localMethod.decorator_resolution_json,'$.executable'),
            CASE WHEN localMethod.decorator_kind IN ('Action','Func','On') THEN 1 ELSE 0 END)=1
          AND (localMethod.decorator_value=? OR localMethod.decorator_value=?
            OR localMethod.method_name=? OR localMethod.decorator_raw_expression LIKE ?))
        THEN 1 ELSE 0 END applicationHasLocalRegistrationForOperation,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep
        WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved'
          AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT)
          AND dep.to_id=?) THEN 1 ELSE 0 END appDependsOnModel,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep
        WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved'
          AND dep.from_kind='repo' AND dep.from_id=CAST(appRepo.id AS TEXT)
          AND dep.to_id=CAST(handlerRepo.id AS TEXT)) THEN 1 ELSE 0 END appDependsOnHandler,
      CASE WHEN EXISTS (SELECT 1 FROM graph_edges dep
        WHERE dep.edge_type='REPO_IMPORTS_HELPER_PACKAGE' AND dep.status='resolved'
          AND dep.from_kind='repo' AND dep.from_id=CAST(handlerRepo.id AS TEXT)
          AND dep.to_id=?) THEN 1 ELSE 0 END handlerDependsOnModel
    FROM handler_methods hm JOIN handler_classes hc ON hc.id=hm.handler_class_id
    JOIN repositories handlerRepo ON handlerRepo.id=hc.repo_id
    JOIN handler_registrations hr ON ((hr.handler_class_id IS NOT NULL
      AND hr.handler_class_id=hc.id) OR (hr.handler_class_id IS NULL AND
      ((hr.class_name=hc.class_name AND hr.repo_id=hc.repo_id) OR
        (instr(hr.import_source,'#')>1 AND substr(hr.import_source,1,
          instr(hr.import_source,'#')-1)=handlerRepo.package_name AND
          (substr(hr.import_source,instr(hr.import_source,'#')+1)=hc.class_name OR
            (substr(hr.import_source,instr(hr.import_source,'#')+1)='default'
              AND hr.class_name=hc.class_name))))))
    JOIN repositories appRepo ON appRepo.id=hr.repo_id
    WHERE appRepo.workspace_id=?
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.handlerKind'),
        CASE WHEN hm.decorator_kind='Event' THEN 'event'
          WHEN hm.decorator_kind IN ('Action','Func','On') THEN 'operation'
          ELSE 'unsupported' END)='operation'
      AND COALESCE(json_extract(hm.decorator_resolution_json,'$.executable'),
        CASE WHEN hm.decorator_kind IN ('Action','Func','On') THEN 1 ELSE 0 END)=1
      AND (hm.decorator_value=? OR hm.decorator_value=? OR hm.method_name=?
        OR hm.decorator_raw_expression LIKE ?)`).all(
    operation.modelRepoId, operation.modelRepo, operation.modelPackage, operation.modelKind,
    operation.servicePath, operation.operationPath, operation.operationName,
    operation.modelRepoId, operation.modelRepoId, operation.servicePath,
    normalizedOperation(String(operation.operationPath ?? '')),
    operation.operationName, operation.operationName,
    `%${upperFirst(normalizedOperation(String(operation.operationPath
      ?? operation.operationName ?? '')))}%`,
    modelRepoGraphId, modelRepoGraphId, workspaceId,
    normalizedOperation(String(operation.operationPath ?? '')),
    operation.operationName, operation.operationName,
    `%${upperFirst(normalizedOperation(String(operation.operationPath
      ?? operation.operationName ?? '')))}%`,
  );
}

function scoreImplementationCandidate(
  row: Record<string, unknown>,
  operation: Record<string, unknown>,
): ImplementationCandidate {
  const acceptedReasons: string[] = [];
  const rejectedReasons: string[] = [];
  const methodSignal = implementationMethodSignal(row, operation);
  acceptedReasons.push(...methodSignal.acceptedReasons);
  rejectedReasons.push(...methodSignal.rejectedReasons);
  const signals = implementationOwnershipSignals(row, methodSignal.matches);
  acceptedReasons.push(...signals.acceptedReasons);
  rejectedReasons.push(...signals.rejectedReasons);
  const accepted = methodSignal.matches && !methodSignal.contradicted
    && !signals.contradicted && signals.hasOwnership;
  if (!accepted && rejectedReasons.length === 0)
    rejectedReasons.push('candidate did not meet implementation ownership policy');
  return {
    ...row,
    methodId: Number(row.methodId),
    score: signals.score,
    accepted,
    acceptedReasons,
    rejectedReasons,
  };
}

function implementationOwnershipSignals(
  row: Record<string, unknown>,
  methodMatches: boolean,
): { score: number; hasOwnership: boolean; contradicted: boolean; acceptedReasons: string[]; rejectedReasons: string[] } {
  const acceptedReasons: string[] = [];
  const rejectedReasons: string[] = [];
  const modelIsApplicationRepo = flag(row.modelIsApplicationRepo);
  const modelIsHandlerRepo = flag(row.modelIsHandlerRepo);
  const localServicePathMatch = flag(row.localServicePathMatch);
  const applicationHasLocalServices = flag(row.applicationHasLocalServices);
  const appDependsOnModel = flag(row.appDependsOnModel);
  const appDependsOnHandler = flag(row.appDependsOnHandler);
  const handlerDependsOnModel = flag(row.handlerDependsOnModel);
  const importSource = Boolean(stringValue(row.importSource));
  const sameRepoRegistration = flag(row.sameRepoRegistration);
  const modelOriented = row.modelKind === 'cap-db-model'
    || !flag(row.applicationHasLocalRegistrationForOperation);
  const helperOwned = modelOriented && methodMatches && sameRepoRegistration && importSource
    && !applicationHasLocalServices && !modelIsApplicationRepo && !modelIsHandlerRepo
    && !localServicePathMatch && !appDependsOnModel && !appDependsOnHandler && !handlerDependsOnModel;
  const score = ownershipScore({
    modelIsApplicationRepo, modelIsHandlerRepo, localServicePathMatch,
    appDependsOnModel, appDependsOnHandler, handlerDependsOnModel, helperOwned,
    importSource,
  }, acceptedReasons);
  const hasOwnership = modelIsApplicationRepo || modelIsHandlerRepo;
  const hasCrossPackage = appDependsOnModel
    && (modelIsHandlerRepo || appDependsOnHandler || !importSource);
  const contradicted = applicationHasLocalServices && !localServicePathMatch
    && !appDependsOnModel && !hasOwnership;
  if (applicationHasLocalServices && !localServicePathMatch && !appDependsOnModel
    && !modelIsApplicationRepo)
    rejectedReasons.push(`registration package has local services but none match ${String(row.servicePath ?? '')}`);
  if (!hasOwnership && !localServicePathMatch && !hasCrossPackage && !helperOwned)
    rejectedReasons.push('missing direct ownership, exact local service path, or validated cross-package dependency evidence');
  return {
    score,
    hasOwnership: hasOwnership || localServicePathMatch || hasCrossPackage
      || handlerDependsOnModel || helperOwned,
    contradicted,
    acceptedReasons,
    rejectedReasons,
  };
}

function ownershipScore(
  signals: Record<string, boolean>,
  acceptedReasons: string[],
): number {
  let score = 0;
  const values: Array<[keyof typeof signals, number, string]> = [
    ['modelIsApplicationRepo', 100, 'model package equals registration package'],
    ['modelIsHandlerRepo', 100, 'model package equals handler package'],
    ['localServicePathMatch', 80, 'registration package contains exact local service path'],
    ['appDependsOnModel', 70, 'registration package depends on model package'],
    ['appDependsOnHandler', 30, 'registration package depends on handler package'],
    ['handlerDependsOnModel', 20, 'handler package depends on model package'],
    ['helperOwned', 60, 'unique registered helper implementation for model-only operation'],
    ['importSource', 10, 'registration imports handler class'],
  ];
  for (const [key, amount, reason] of values) {
    if (!signals[key]) continue;
    score += amount;
    acceptedReasons.push(reason);
  }
  return score;
}

function candidateEvidence(candidate: ImplementationCandidate, rank: number): Record<string, unknown> {
  return {
    rank,
    rankKind: 'discovery_score',
    score: candidate.score,
    accepted: candidate.accepted,
    acceptedReasons: candidate.acceptedReasons,
    rejectedReasons: candidate.rejectedReasons,
    methodId: candidate.methodId,
    classId: candidate.classId,
    className: candidate.className,
    sourceFile: candidate.sourceFile,
    sourceLine: candidate.sourceLine,
    decoratorResolution: objectJson(candidate.decoratorResolutionJson),
    registration: registrationEvidence(candidate),
    registrations: candidate.registrations ?? [],
    registrationPairing: {
      strategy: registrationPairingStrategy(candidate),
      registrationId: candidate.registrationId,
      registrationHandlerClassId: candidate.registrationHandlerClassId,
      candidateHandlerClassId: candidate.classId,
      invariantStatus: validRegistrationPair(candidate) ? 'valid' : 'invalid',
    },
    applicationPackage: {
      id: candidate.applicationRepoId,
      name: candidate.applicationRepo,
      packageName: candidate.applicationPackage,
    },
    handlerPackage: {
      id: candidate.handlerRepoId,
      name: candidate.handlerRepo,
      packageName: candidate.handlerPackage,
    },
    modelPackage: {
      id: candidate.modelRepoId,
      name: candidate.modelRepo,
      packageName: candidate.modelPackage,
    },
    servicePath: candidate.servicePath,
    operationPath: candidate.operationPath,
    operationName: candidate.operationName,
    signals: {
      directOwnership: {
        modelIsApplicationRepo: flag(candidate.modelIsApplicationRepo),
        modelIsHandlerRepo: flag(candidate.modelIsHandlerRepo),
      },
      localServicePathMatch: flag(candidate.localServicePathMatch),
      applicationHasLocalServices: flag(candidate.applicationHasLocalServices),
      applicationHasLocalRegistrationForOperation:
        flag(candidate.applicationHasLocalRegistrationForOperation),
      appDependsOnModel: flag(candidate.appDependsOnModel),
      appDependsOnHandler: flag(candidate.appDependsOnHandler),
      handlerDependsOnModel: flag(candidate.handlerDependsOnModel),
      sameRepoRegistration: flag(candidate.sameRepoRegistration),
    },
  };
}

function selectedHandlerSource(candidate: ImplementationCandidate): {
  methodId: number;
  className?: string;
  methodName?: string;
  repositoryId?: number;
  repositoryName?: string;
  repositoryPackageName?: string;
  sourceFile?: string;
  sourceLine?: number;
} {
  return {
    methodId: candidate.methodId,
    className: stringValue(candidate.className),
    methodName: stringValue(candidate.methodName),
    repositoryId: numberValue(candidate.handlerRepoId),
    repositoryName: stringValue(candidate.handlerRepo),
    repositoryPackageName: stringValue(candidate.handlerPackage),
    sourceFile: stringValue(candidate.sourceFile),
    sourceLine: numberValue(candidate.sourceLine),
  };
}

function implementationMethodSignal(
  row: Record<string, unknown>,
  operation: Record<string, unknown>,
): { matches: boolean; contradicted: boolean; acceptedReasons: string[]; rejectedReasons: string[] } {
  const resolution = objectJson(row.decoratorResolutionJson) ?? {};
  if (resolution.handlerKind && resolution.handlerKind !== 'operation')
    return { matches: false, contradicted: true, acceptedReasons: [], rejectedReasons: ['non_operation_handler_kind'] };
  if (resolution.executable === false)
    return { matches: false, contradicted: true, acceptedReasons: [], rejectedReasons: ['handler_method_not_executable'] };
  const operationName = normalizedOperationName(String(
    operation.operationPath ?? operation.operationName ?? '',
  ));
  const decorator = normalizeDecoratorOperationSignal(
    stringValue(row.decoratorValue), stringValue(row.decoratorRawExpression), operationName,
  );
  if (decorator.status === 'resolved' && decorator.operationName === operationName)
    return { matches: true, contradicted: false, acceptedReasons: ['decorator targets operation'], rejectedReasons: [] };
  if (decorator.status === 'resolved')
    return { matches: false, contradicted: true, acceptedReasons: [], rejectedReasons: ['method_name_matches_but_decorator_targets_different_operation'] };
  return String(row.methodName ?? '') === operationName
    ? { matches: true, contradicted: false, acceptedReasons: ['method name fallback matched operation'], rejectedReasons: [] }
    : { matches: false, contradicted: false, acceptedReasons: [], rejectedReasons: ['method name does not match operation'] };
}

function objectJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function upperFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}

function flag(value: unknown): boolean {
  return Boolean(Number(value ?? 0));
}

function graphId(value: unknown): string {
  return String(value ?? '');
}

function normalizedOperation(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
