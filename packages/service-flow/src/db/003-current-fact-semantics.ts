import type { Db } from './connection.js';
import type { CallType, RepoKind } from '../types.js';
import { ANALYZER_VERSION } from '../version.js';
import {
  invalidPackageFactCategories,
} from './007-package-fact-semantics.js';
import {
  invalidRelativeFactCategories,
} from './008-relative-fact-semantics.js';
import {
  invalidBindingFactCategories,
} from './009-binding-fact-semantics.js';
import {
  invalidSymbolFactCategories,
} from './011-symbol-call-semantics.js';

export type PackageFactPhase = 'pre_package' | 'terminal';

export interface FactSemanticCategoryCount {
  category: string;
  count: number;
}

const executableKindSql =
  "'event_registration','callback','method','object_method','function'";
const callTypeAllowlist: Record<CallType, true> = {
  remote_action: true,
  remote_query: true,
  remote_entity_read: true,
  remote_entity_mutation: true,
  remote_entity_delete: true,
  remote_entity_media: true,
  remote_entity_candidate: true,
  local_db_query: true,
  external_http: true,
  async_emit: true,
  async_subscribe: true,
  local_service_call: true,
  unknown: true,
};
const repositoryKindAllowlist: Record<RepoKind, true> = {
  'cap-service': true,
  'cap-db-model': true,
  'helper-package': true,
  mixed: true,
  unknown: true,
};
const symbolStrategies = [
  'same_file_exact',
  'exported_exact',
  'exact_symbol_match',
  'relative_import_class_instance_method',
  'relative_import_namespace_member',
  'relative_import_static_accessor_instance_method',
  'relative_import_path_disambiguated',
  'relative_import_exported_exact',
  'proxy_member_exported_object_map',
  'proxy_member_no_global_name_fallback',
  'package_import_pending',
  'package_import_derived_member_unsupported',
  'package_public_surface_exact',
  'package_public_surface_ambiguous',
  'package_public_surface_unresolved',
] as const;
const symbolReasons = [
  'multiple_same_file_symbol_targets',
  'multiple_exported_symbol_targets',
  'no_local_symbol_target',
  'symbol_target_has_no_executable_body',
  'relative_import_provenance_missing',
  'relative_import_type_only',
  'relative_import_module_resolution_ambiguous',
  'relative_import_requested_module_has_no_executable_body',
  'relative_import_requested_module_has_no_target',
  'multiple_relative_class_targets_in_requested_module',
  'multiple_namespace_targets_in_requested_module',
  'multiple_accessor_targets_in_requested_module',
  'multiple_exported_targets_in_requested_module',
  'multiple_proxy_targets_in_requested_module',
  'package_resolution_pending',
  'package_derived_member_provenance_insufficient',
  'package_repository_scope_ambiguous',
  'package_repository_not_indexed',
  'package_public_surface_unsupported',
  'public_surface_evidence_incomplete',
  'package_binding_type_only',
  'package_public_scope_duplicate',
  'package_public_name_not_exposed',
  'package_public_target_ambiguous',
  'public_symbol_has_no_executable_body',
] as const;
const incompleteReasons = [
  'relative_import_provenance_missing',
  'relative_import_module_resolution_ambiguous',
  'package_resolution_pending',
  'package_repository_scope_ambiguous',
  'package_public_surface_unsupported',
  'public_surface_evidence_incomplete',
] as const;
const packageStrategies = [
  'package_import_pending',
  'package_public_surface_exact',
  'package_public_surface_ambiguous',
  'package_public_surface_unresolved',
] as const;
const relativeStrategies = [
  'relative_import_class_instance_method',
  'relative_import_namespace_member',
  'relative_import_static_accessor_instance_method',
  'relative_import_path_disambiguated',
  'relative_import_exported_exact',
  'proxy_member_exported_object_map',
  'proxy_member_no_global_name_fallback',
] as const;
const simpleStrategies = [
  'same_file_exact',
  'exported_exact',
  'exact_symbol_match',
] as const;

function sqlTextList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

function count(
  db: Db,
  sql: string,
  workspaceId?: number,
  predicateCount = 1,
): number {
  const params = Array.from({ length: predicateCount }, () =>
    [ANALYZER_VERSION, workspaceId, workspaceId]).flat();
  const row = db.prepare(sql).get(...params);
  return Number(row?.count ?? 0);
}

function category(
  categoryName: string,
  categoryCount: number,
): FactSemanticCategoryCount[] {
  return categoryCount > 0
    ? [{ category: categoryName, count: categoryCount }]
    : [];
}

function currentRepositoryPredicate(alias = 'r'): string {
  return `${alias}.fact_analyzer_version=?
    AND (? IS NULL OR ${alias}.workspace_id=?)`;
}

function repositoryCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  const invalid = count(db, `SELECT COUNT(*) count FROM repositories r
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(r.kind)<>'text' OR r.kind NOT IN (
        ${sqlTextList(Object.keys(repositoryKindAllowlist))}
      ))`, workspaceId);
  return category('repository_kind_invalid', invalid);
}

function operationCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  const invalid = count(db, `SELECT COUNT(*) count
    FROM cds_operations fact
    JOIN cds_services service ON service.id=fact.service_id
    JOIN repositories r ON r.id=service.repo_id
    LEFT JOIN cds_operations base ON base.id=fact.base_operation_id
    LEFT JOIN cds_services base_service ON base_service.id=base.service_id
    LEFT JOIN repositories base_repo ON base_repo.id=base_service.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(fact.operation_type)<>'text'
        OR fact.operation_type NOT IN ('action','function','event')
        OR typeof(fact.operation_name)<>'text'
        OR length(fact.operation_name)=0
        OR typeof(fact.operation_path)<>'text'
        OR length(fact.operation_path)=0
        OR typeof(fact.source_file)<>'text'
        OR length(fact.source_file)=0
        OR typeof(fact.source_line)<>'integer' OR fact.source_line<1
        OR fact.provenance NOT IN ('direct','inherited')
        OR (fact.provenance='direct' AND fact.base_operation_id IS NOT NULL)
        OR (fact.provenance='inherited' AND (
          base.id IS NULL OR COALESCE(service.is_extend,0)<>1
          OR COALESCE(service.extension_base_status,'')<>'resolved'
          OR service.extension_base_service_id IS NULL
          OR service.extension_base_service_id<>base.service_id
          OR COALESCE(base.provenance,'')<>'direct'
          OR base.base_operation_id IS NOT NULL
          OR base_repo.workspace_id IS NULL
          OR base_repo.workspace_id<>r.workspace_id
          OR fact.operation_type<>base.operation_type
          OR fact.operation_name<>base.operation_name
          OR fact.operation_path<>base.operation_path
          OR fact.params_json<>base.params_json
          OR fact.return_type IS NOT base.return_type
          OR fact.source_file<>base.source_file
          OR fact.source_line<>base.source_line)))`, workspaceId);
  return category('cds_operation_semantics_invalid', invalid);
}

function callSpanCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  const outbound = count(db, `SELECT COUNT(*) count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(fact.source_file)<>'text'
        OR length(fact.source_file)=0
        OR typeof(fact.call_site_start_offset)<>'integer'
        OR typeof(fact.call_site_end_offset)<>'integer'
        OR fact.call_site_start_offset<0
        OR fact.call_site_end_offset<=fact.call_site_start_offset)`, workspaceId);
  const callType = count(db, `SELECT COUNT(*) count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(fact.call_type)<>'text'
        OR fact.call_type NOT IN (
          ${sqlTextList(Object.keys(callTypeAllowlist))}
        ))`, workspaceId);
  const symbol = count(db, `SELECT COUNT(*) count
    FROM symbol_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(fact.source_file)<>'text'
        OR length(fact.source_file)=0
        OR typeof(fact.callee_expression)<>'text'
        OR length(fact.callee_expression)=0
        OR typeof(fact.call_site_start_offset)<>'integer'
        OR typeof(fact.call_site_end_offset)<>'integer'
        OR fact.call_site_start_offset<0
        OR fact.call_site_end_offset<=fact.call_site_start_offset
        OR fact.call_role NOT IN ('ordinary_call','event_subscribe_handler'))`, workspaceId);
  return [
    ...category('outbound_call_span_invalid', outbound),
    ...category('outbound_call_type_invalid', callType),
    ...category('symbol_call_span_or_role_invalid', symbol),
  ];
}

function duplicateSymbolCallCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  const duplicate = count(db, `SELECT COUNT(*) count FROM (
    SELECT fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset,fact.call_role,COUNT(*) duplicate_count
    FROM symbol_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
    GROUP BY fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset,fact.call_role
    HAVING COUNT(*)<>1
  )`, workspaceId);
  return category('symbol_call_site_duplicate', duplicate);
}

function eventNameCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  const invalid = count(db, `SELECT COUNT(*) count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND fact.call_type IN ('async_emit','async_subscribe')
      AND (typeof(fact.event_name_expr)<>'text'
        OR length(fact.event_name_expr)=0)`, workspaceId);
  const duplicate = count(db, `SELECT COUNT(*) count FROM (
    SELECT fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset,COUNT(*) duplicate_count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND fact.call_type='async_subscribe'
    GROUP BY fact.repo_id,fact.source_file,fact.call_site_start_offset,
      fact.call_site_end_offset HAVING COUNT(*)<>1
  )`, workspaceId);
  return [
    ...category('event_name_invalid', invalid),
    ...category('async_subscription_site_duplicate', duplicate),
  ];
}

function outboundOwnerCount(db: Db, workspaceId?: number): number {
  return count(db, `WITH eligible AS (
    SELECT fact.id fact_id,s.id symbol_id,
      DENSE_RANK() OVER (PARTITION BY fact.id ORDER BY
        CASE WHEN fact.call_type='async_subscribe'
          AND s.kind='event_registration'
          AND s.start_offset=fact.call_site_start_offset
          AND s.end_offset=fact.call_site_end_offset THEN 0 ELSE 1 END,
        s.end_offset-s.start_offset,
        CASE s.kind WHEN 'event_registration' THEN 0 WHEN 'callback' THEN 1
          WHEN 'method' THEN 2 WHEN 'object_method' THEN 3 ELSE 4 END,
        s.start_offset,s.end_offset,s.qualified_name COLLATE BINARY) owner_rank
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    JOIN symbols s ON s.repo_id=fact.repo_id
      AND s.source_file=fact.source_file
      AND s.kind IN (${executableKindSql})
      AND s.start_offset<=fact.call_site_start_offset
      AND s.end_offset>=fact.call_site_end_offset
      AND (fact.call_type<>'async_subscribe'
        OR (s.kind='event_registration'
          AND s.start_offset=fact.call_site_start_offset
          AND s.end_offset=fact.call_site_end_offset))
    WHERE ${currentRepositoryPredicate()}
  ), best AS (
    SELECT fact_id,COUNT(*) best_count,MAX(symbol_id) symbol_id
    FROM eligible WHERE owner_rank=1 GROUP BY fact_id
  )
  SELECT COUNT(*) count FROM outbound_calls fact
  JOIN repositories r ON r.id=fact.repo_id
  LEFT JOIN best ON best.fact_id=fact.id
  WHERE ${currentRepositoryPredicate()}
    AND ((best.fact_id IS NULL AND (
      fact.source_symbol_id IS NOT NULL
      OR COALESCE(json_extract(fact.evidence_json,
        '$.sourceOwnerResolution'),'')
        <>'ownerless_file_scope'))
    OR (best.fact_id IS NOT NULL AND (
      best.best_count<>1 OR fact.source_symbol_id IS NOT best.symbol_id
      OR COALESCE(json_extract(fact.evidence_json,
        '$.sourceOwnerResolution'),'')<>'owned_exact')))`, workspaceId, 2);
}

function symbolOwnerCount(db: Db, workspaceId?: number): number {
  return count(db, `WITH eligible AS (
    SELECT fact.id fact_id,s.id symbol_id,
      DENSE_RANK() OVER (PARTITION BY fact.id ORDER BY
        CASE WHEN fact.call_role='event_subscribe_handler'
          AND s.kind='event_registration'
          AND s.start_offset=fact.call_site_start_offset
          AND s.end_offset=fact.call_site_end_offset THEN 0 ELSE 1 END,
        s.end_offset-s.start_offset,
        CASE s.kind WHEN 'event_registration' THEN 0 WHEN 'callback' THEN 1
          WHEN 'method' THEN 2 WHEN 'object_method' THEN 3 ELSE 4 END,
        s.start_offset,s.end_offset,s.qualified_name COLLATE BINARY) owner_rank
    FROM symbol_calls fact JOIN repositories r ON r.id=fact.repo_id
    JOIN symbols s ON s.repo_id=fact.repo_id
      AND s.source_file=fact.source_file
      AND s.kind IN (${executableKindSql})
      AND s.start_offset<=fact.call_site_start_offset
      AND s.end_offset>=fact.call_site_end_offset
      AND (fact.call_role<>'event_subscribe_handler'
        OR (s.kind='event_registration'
          AND s.start_offset=fact.call_site_start_offset
          AND s.end_offset=fact.call_site_end_offset))
    WHERE ${currentRepositoryPredicate()}
  ), best AS (
    SELECT fact_id,COUNT(*) best_count,MAX(symbol_id) symbol_id
    FROM eligible WHERE owner_rank=1 GROUP BY fact_id
  )
  SELECT COUNT(*) count FROM symbol_calls fact
  JOIN repositories r ON r.id=fact.repo_id
  LEFT JOIN best ON best.fact_id=fact.id
  LEFT JOIN symbols selected ON selected.id=best.symbol_id
  WHERE ${currentRepositoryPredicate()}
    AND (best.fact_id IS NULL OR best.best_count<>1
      OR fact.caller_symbol_id IS NOT best.symbol_id
      OR typeof(json_extract(fact.evidence_json,'$.caller'))<>'text'
      OR json_extract(fact.evidence_json,'$.caller') COLLATE BINARY
        <>selected.qualified_name COLLATE BINARY)`, workspaceId, 2);
}

function ownerCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  return [
    ...category('outbound_call_owner_invalid',
      outboundOwnerCount(db, workspaceId)),
    ...category('symbol_call_owner_invalid',
      symbolOwnerCount(db, workspaceId)),
  ];
}

function bindingSiteCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count
    FROM service_bindings fact JOIN repositories r ON r.id=fact.repo_id
    LEFT JOIN symbols owner ON owner.id=fact.symbol_id
    WHERE ${currentRepositoryPredicate()}
      AND (typeof(fact.binding_site_start_offset)<>'integer'
        OR typeof(fact.binding_site_end_offset)<>'integer'
        OR typeof(fact.source_file)<>'text'
        OR length(fact.source_file)=0
        OR typeof(fact.variable_name)<>'text'
        OR length(fact.variable_name)=0
        OR fact.binding_site_start_offset<0
        OR fact.binding_site_end_offset<=fact.binding_site_start_offset
        OR fact.owner_resolution NOT IN
          ('owned_exact','ownerless_file_scope')
        OR (fact.owner_resolution='owned_exact' AND (
          owner.id IS NULL OR owner.repo_id<>fact.repo_id
          OR owner.source_file<>fact.source_file
          OR owner.kind NOT IN (${executableKindSql})
          OR owner.start_offset>fact.binding_site_start_offset
          OR owner.end_offset<fact.binding_site_end_offset))
        OR (fact.owner_resolution='ownerless_file_scope'
          AND fact.symbol_id IS NOT NULL))`, workspaceId);
}

function duplicateBindingSiteCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM (
    SELECT fact.repo_id,fact.source_file,fact.variable_name,
      fact.binding_site_start_offset,fact.binding_site_end_offset,COUNT(*) total
    FROM service_bindings fact JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
    GROUP BY fact.repo_id,fact.source_file,fact.variable_name,
      fact.binding_site_start_offset,fact.binding_site_end_offset
    HAVING COUNT(*)<>1
  )`, workspaceId);
}

function bindingCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  return [
    ...category('service_binding_site_or_owner_invalid',
      bindingSiteCount(db, workspaceId)),
    ...category('service_binding_exact_site_duplicate',
      duplicateBindingSiteCount(db, workspaceId)),
    ...category('outbound_binding_reference_invalid',
      bindingReferenceCount(db, workspaceId)),
  ];
}

function bindingReferenceCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    LEFT JOIN service_bindings binding ON binding.id=fact.service_binding_id
    WHERE ${currentRepositoryPredicate()}
      AND (
        COALESCE(json_extract(fact.evidence_json,
          '$.serviceBindingReference.status'),'')
          NOT IN ('resolved_exact','ambiguous','unresolved','not_applicable')
        OR (json_extract(fact.evidence_json,
          '$.serviceBindingReference.status')='resolved_exact' AND (
          binding.id IS NULL OR binding.repo_id<>fact.repo_id
          OR binding.source_file IS NOT json_extract(fact.evidence_json,
            '$.serviceBindingReference.bindingSourceFile')
          OR binding.variable_name IS NOT json_extract(fact.evidence_json,
            '$.serviceBindingReference.variableName')
          OR binding.binding_site_start_offset IS NOT json_extract(
            fact.evidence_json,
            '$.serviceBindingReference.bindingSiteStartOffset')
          OR binding.binding_site_end_offset IS NOT json_extract(
            fact.evidence_json,
            '$.serviceBindingReference.bindingSiteEndOffset')))
        OR (json_extract(fact.evidence_json,
          '$.serviceBindingReference.status') IN ('ambiguous','unresolved')
          AND (fact.service_binding_id IS NOT NULL
            OR typeof(json_extract(fact.evidence_json,
              '$.serviceBindingReference.reason'))<>'text'))
        OR (json_extract(fact.evidence_json,
          '$.serviceBindingReference.status')='not_applicable'
          AND (fact.service_binding_id IS NOT NULL
            OR json_extract(fact.evidence_json,
              '$.serviceBindingReference.variableName') IS NOT NULL))
      )`, workspaceId);
}

function handlerStatusCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM outbound_calls fact
    JOIN repositories r ON r.id=fact.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND fact.call_type='async_subscribe'
      AND (
        COALESCE(json_extract(fact.evidence_json,
          '$.handlerReferenceStatus'),'')
          NOT IN ('role_required','unsupported_inline','unsupported_wrapper',
            'unsupported_reference_shape','missing_argument')
        OR (json_extract(fact.evidence_json,
          '$.handlerReferenceStatus')='role_required' AND (
          json_extract(fact.evidence_json,
            '$.handlerReferenceReason') IS NOT NULL
          OR COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceShape'),'') NOT IN (
              'identifier','namespace_member','static_member','default_member',
              'wrapped_identifier','wrapped_namespace_member',
              'wrapped_static_member','wrapped_default_member')))
        OR (json_extract(fact.evidence_json,
          '$.handlerReferenceStatus')='unsupported_inline' AND (
          COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceReason'),'')<>'inline_handler_body_not_indexed'
          OR COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceShape'),'')<>'inline_callback'))
        OR (json_extract(fact.evidence_json,
          '$.handlerReferenceStatus')='unsupported_wrapper' AND (
          COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceReason'),'') NOT IN (
              'wrapper_requires_one_reference',
              'wrapper_reference_shape_unsupported')
          OR COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceShape'),'')<>'wrapper_call'))
        OR (json_extract(fact.evidence_json,
          '$.handlerReferenceStatus')='unsupported_reference_shape' AND (
          COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceReason'),'')
            <>'handler_reference_shape_unsupported'
          OR COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceShape'),'')<>'unsupported_expression'))
        OR (json_extract(fact.evidence_json,
          '$.handlerReferenceStatus')='missing_argument' AND (
          COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceReason'),'')<>'handler_argument_missing'
          OR COALESCE(json_extract(fact.evidence_json,
            '$.handlerReferenceShape'),'')<>'missing'))
      )`, workspaceId);
}

function handlerAssociationCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM (
    SELECT fact.id,
      json_extract(fact.evidence_json,
        '$.handlerReferenceStatus') handler_status,
      COUNT(role.id) role_count
    FROM outbound_calls fact JOIN repositories r ON r.id=fact.repo_id
    LEFT JOIN symbol_calls role ON role.repo_id=fact.repo_id
      AND role.source_file=fact.source_file
      AND role.call_site_start_offset=fact.call_site_start_offset
      AND role.call_site_end_offset=fact.call_site_end_offset
      AND role.call_role='event_subscribe_handler'
    WHERE ${currentRepositoryPredicate()}
      AND fact.call_type='async_subscribe'
    GROUP BY fact.id HAVING
      (handler_status='role_required' AND role_count<>1)
      OR (handler_status<>'role_required' AND role_count<>0)
  )`, workspaceId);
}

function handlerRoleCount(db: Db, workspaceId?: number): number {
  return count(db, `SELECT COUNT(*) count FROM symbol_calls fact
    JOIN repositories r ON r.id=fact.repo_id
    LEFT JOIN outbound_calls subscription
      ON subscription.repo_id=fact.repo_id
      AND subscription.source_file=fact.source_file
      AND subscription.call_site_start_offset=fact.call_site_start_offset
      AND subscription.call_site_end_offset=fact.call_site_end_offset
      AND subscription.call_type='async_subscribe'
    WHERE ${currentRepositoryPredicate()}
      AND fact.call_role='event_subscribe_handler'
      AND (subscription.id IS NULL
        OR subscription.source_line<>fact.source_line
        OR subscription.source_symbol_id IS NOT fact.caller_symbol_id
        OR COALESCE(json_extract(fact.evidence_json,'$.factOrigin'),'')
          <>'event_subscribe_handler_reference'
        OR typeof(json_extract(fact.evidence_json,'$.candidateStrategy'))
          <>'text'
        OR length(json_extract(fact.evidence_json,'$.candidateStrategy'))=0)`,
  workspaceId);
}

function eventAssociationCategories(
  db: Db,
  workspaceId?: number,
): FactSemanticCategoryCount[] {
  return [
    ...category('subscription_handler_status_invalid',
      handlerStatusCount(db, workspaceId)),
    ...category('subscription_handler_cardinality_invalid',
      handlerAssociationCount(db, workspaceId)),
    ...category('event_handler_role_provenance_invalid',
      handlerRoleCount(db, workspaceId)),
  ];
}

const symbolResolutionSql = `SELECT COUNT(*) count FROM symbol_calls fact
    JOIN repositories r ON r.id=fact.repo_id
    LEFT JOIN symbols target ON target.id=fact.callee_symbol_id
    LEFT JOIN repositories target_repo ON target_repo.id=target.repo_id
    WHERE ${currentRepositoryPredicate()}
      AND (fact.status NOT IN ('resolved','ambiguous','unresolved')
        OR typeof(json_extract(fact.evidence_json,'$.candidateStrategy'))
          <>'text'
        OR length(json_extract(fact.evidence_json,'$.candidateStrategy'))=0
        OR json_extract(fact.evidence_json,'$.candidateStrategy')
          NOT IN (${sqlTextList(symbolStrategies)})
        OR typeof(json_extract(fact.evidence_json,'$.candidateCount'))
          <>'integer'
        OR typeof(json_extract(fact.evidence_json,'$.eligibleCandidateCount'))
          <>'integer'
        OR typeof(json_extract(fact.evidence_json,'$.selectedCandidateCount'))
          <>'integer'
        OR COALESCE(json_type(
          fact.evidence_json,'$.candidateSetComplete'),'missing')
          NOT IN ('true','false')
        OR json_extract(fact.evidence_json,'$.candidateCount')<0
        OR json_extract(fact.evidence_json,'$.eligibleCandidateCount')<0
        OR json_extract(fact.evidence_json,'$.selectedCandidateCount')
          NOT IN (0,1)
        OR json_extract(fact.evidence_json,'$.selectedCandidateCount')
          >json_extract(fact.evidence_json,'$.eligibleCandidateCount')
        OR json_extract(fact.evidence_json,'$.eligibleCandidateCount')
          >json_extract(fact.evidence_json,'$.candidateCount')
        OR fact.unresolved_reason IS NOT json_extract(
          fact.evidence_json,'$.unresolvedReason')
        OR (fact.status='resolved' AND (
          fact.callee_symbol_id IS NULL OR target.id IS NULL
          OR target_repo.workspace_id IS NOT r.workspace_id
          OR json_extract(fact.evidence_json,'$.candidateSetComplete')<>1
          OR json_extract(fact.evidence_json,'$.eligibleCandidateCount')<>1
          OR json_extract(fact.evidence_json,'$.selectedCandidateCount')<>1
          OR fact.unresolved_reason IS NOT NULL
          OR COALESCE(json_type(
            fact.evidence_json,'$.unresolvedReason'),'missing')<>'null'))
        OR (fact.status='ambiguous' AND (
          fact.callee_symbol_id IS NOT NULL
          OR json_extract(fact.evidence_json,'$.candidateSetComplete')<>1
          OR json_extract(fact.evidence_json,'$.eligibleCandidateCount')<2
          OR json_extract(fact.evidence_json,'$.selectedCandidateCount')<>0
          OR typeof(fact.unresolved_reason)<>'text'
          OR length(fact.unresolved_reason)=0
          OR COALESCE(json_type(
            fact.evidence_json,'$.unresolvedReason'),'missing')<>'text'
          OR fact.unresolved_reason NOT IN (${sqlTextList(symbolReasons)})))
        OR (fact.status='unresolved' AND (
          fact.callee_symbol_id IS NOT NULL
          OR json_extract(fact.evidence_json,'$.selectedCandidateCount')<>0
          OR typeof(fact.unresolved_reason)<>'text'
          OR length(fact.unresolved_reason)=0
          OR COALESCE(json_type(
            fact.evidence_json,'$.unresolvedReason'),'missing')<>'text'
          OR fact.unresolved_reason NOT IN (${sqlTextList(symbolReasons)})
          OR (json_extract(fact.evidence_json,'$.candidateSetComplete')=1
            AND json_extract(fact.evidence_json,
              '$.eligibleCandidateCount')<>0)
          OR (json_extract(fact.evidence_json,'$.candidateSetComplete')=0
            AND fact.unresolved_reason NOT IN (
              ${sqlTextList(incompleteReasons)}))))
        OR (json_extract(fact.evidence_json,'$.candidateStrategy')
            ='package_import_pending'
          AND (COALESCE(json_extract(fact.evidence_json,'$.relation'),'')
              <>'package_import'
            OR COALESCE(json_extract(fact.evidence_json,
              '$.importBinding.moduleKind'),'')<>'package'))
        OR (json_extract(fact.evidence_json,'$.candidateStrategy')
            IN (${sqlTextList(packageStrategies)})
          AND (COALESCE(json_extract(
              fact.evidence_json,'$.relation'),'')<>'package_import'
            OR COALESCE(json_extract(fact.evidence_json,
              '$.importBinding.moduleKind'),'')<>'package'))
        OR (json_extract(fact.evidence_json,'$.candidateStrategy')
            ='package_import_derived_member_unsupported'
          AND (COALESCE(json_extract(fact.evidence_json,'$.relation'),'')
              <>'package_import_derived_member'
            OR COALESCE(json_extract(fact.evidence_json,
              '$.derivedImportBinding.moduleKind'),'')<>'package'))
        OR (json_extract(fact.evidence_json,'$.candidateStrategy')
            IN (${sqlTextList(relativeStrategies)})
          AND (COALESCE(json_extract(fact.evidence_json,
              '$.importBinding.moduleKind'),'')<>'relative'
            OR COALESCE(fact.import_source,'') NOT LIKE '.%'))
        OR (json_extract(fact.evidence_json,'$.candidateStrategy')
            IN (${sqlTextList(simpleStrategies)})
          AND (fact.import_source IS NOT NULL
            OR COALESCE(json_extract(fact.evidence_json,
              '$.importBinding.moduleKind'),'') IN ('relative','package')
            OR COALESCE(json_extract(fact.evidence_json,'$.relation'),'')
              IN ('package_import','package_import_derived_member')))
        __PACKAGE_PENDING_TERMINAL_CHECK__)`;

function symbolResolutionCount(
  db: Db,
  workspaceId: number | undefined,
  phase: PackageFactPhase,
): number {
  const pendingInvalid = phase === 'terminal'
    ? "OR json_extract(fact.evidence_json,'$.candidateStrategy')='package_import_pending'"
    : '';
  return count(db, symbolResolutionSql.replace(
    '__PACKAGE_PENDING_TERMINAL_CHECK__', pendingInvalid,
  ), workspaceId);
}

export function invalidFactSemanticCategories(
  db: Db,
  workspaceId?: number,
  phase: PackageFactPhase = 'pre_package',
): FactSemanticCategoryCount[] {
  return [
    ...repositoryCategories(db, workspaceId),
    ...operationCategories(db, workspaceId),
    ...callSpanCategories(db, workspaceId),
    ...duplicateSymbolCallCategories(db, workspaceId),
    ...eventNameCategories(db, workspaceId),
    ...ownerCategories(db, workspaceId),
    ...bindingCategories(db, workspaceId),
    ...invalidBindingFactCategories(db, workspaceId),
    ...eventAssociationCategories(db, workspaceId),
    ...invalidPackageFactCategories(db, workspaceId, phase),
    ...invalidRelativeFactCategories(db, workspaceId),
    ...invalidSymbolFactCategories(db, workspaceId),
    ...category('symbol_call_resolution_matrix_invalid',
      symbolResolutionCount(db, workspaceId, phase)),
  ];
}
