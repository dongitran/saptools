import type { Db } from '../../src/db/connection.js';
import {
  PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
  PACKAGE_PUBLIC_SURFACE_SCHEMA,
} from '../../src/parsers/003-package-public-surface.js';
import { extractPlaceholderKeys } from '../../src/utils/001-placeholders.js';
import { ANALYZER_VERSION } from '../../src/version.js';

export function markRepositoryCurrent(
  db: Db,
  repoId: number,
  packageName: string,
): void {
  const surface = {
    schema: PACKAGE_PUBLIC_SURFACE_SCHEMA,
    status: 'complete',
    reason: null,
    recordCap: PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
    total: 0,
    shown: 0,
    omitted: 0,
    packageName,
    exportsPresent: false,
    exportsAuthoritative: false,
    main: null,
    module: null,
    entries: [],
    scopes: [],
  };
  db.prepare(`UPDATE repositories SET index_status='indexed',
    fact_analyzer_version=?,package_public_surface_json=? WHERE id=?`)
    .run(ANALYZER_VERSION, JSON.stringify(surface), repoId);
}

interface OwnerlessBindingOptions {
  variableName: string;
  alias: string;
  servicePathExpr?: string;
  sourceFile: string;
  sourceLine: number;
  startOffset: number;
  endOffset: number;
}

export function insertOwnerlessBinding(
  db: Db,
  repoId: number,
  options: OwnerlessBindingOptions,
): number {
  const placeholders = extractPlaceholderKeys(options.servicePathExpr);
  const row = db.prepare(`INSERT INTO service_bindings(
    repo_id,variable_name,alias,service_path_expr,is_dynamic,
    placeholders_json,source_file,source_line,binding_site_start_offset,
    binding_site_end_offset,owner_resolution
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, options.variableName, options.alias, options.servicePathExpr,
    placeholders.length > 0 ? 1 : 0, JSON.stringify(placeholders),
    options.sourceFile, options.sourceLine, options.startOffset,
    options.endOffset, 'ownerless_file_scope',
  );
  return Number(row?.id);
}

interface OwnerlessCallOptions {
  callType: string;
  bindingId?: number;
  method?: string;
  operationPathExpr?: string;
  queryEntity?: string;
  sourceFile: string;
  sourceLine: number;
  startOffset: number;
  endOffset: number;
  evidence?: Record<string, unknown>;
}

function bindingReference(
  db: Db,
  bindingId: number,
  call: OwnerlessCallOptions,
): Record<string, unknown> {
  const binding = db.prepare(`SELECT variable_name variableName,
    source_file sourceFile,binding_site_start_offset startOffset,
    binding_site_end_offset endOffset FROM service_bindings WHERE id=?`)
    .get(bindingId);
  const scopeEnd = Math.max(call.endOffset, Number(binding?.endOffset)) + 1;
  return {
    status: 'resolved_exact',
    variableName: binding?.variableName,
    bindingSourceFile: binding?.sourceFile,
    bindingSiteStartOffset: binding?.startOffset,
    bindingSiteEndOffset: binding?.endOffset,
    resolutionStrategy: 'lexical_declaration',
    lexicalScopeChain: [{
      kind: 'source_file', startOffset: 0, endOffset: scopeEnd,
    }],
    bindingScopeIndex: 0,
    scopeChainTotal: 1,
    scopeChainShown: 1,
    scopeChainOmitted: 0,
  };
}

function callBindingEvidence(
  db: Db,
  call: OwnerlessCallOptions,
): Record<string, unknown> {
  if (call.bindingId === undefined) return {
    serviceBindingReference: {
      status: 'not_applicable',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    },
    serviceBindingResolution: {
      status: 'not_applicable', candidateCount: 0,
    },
  };
  return {
    serviceBindingReference: bindingReference(db, call.bindingId, call),
    serviceBindingResolution: {
      status: 'selected_exact',
      selectedBindingId: call.bindingId,
      candidateCount: 1,
    },
  };
}

export function insertOwnerlessCall(
  db: Db,
  repoId: number,
  options: OwnerlessCallOptions,
): number {
  const evidence = {
    ...(options.evidence ?? {}),
    sourceOwnerResolution: 'ownerless_file_scope',
    ...callBindingEvidence(db, options),
  };
  const row = db.prepare(`INSERT INTO outbound_calls(
    repo_id,call_type,service_binding_id,method,operation_path_expr,
    query_entity,source_file,source_line,call_site_start_offset,
    call_site_end_offset,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, options.callType, options.bindingId ?? null, options.method,
    options.operationPathExpr, options.queryEntity, options.sourceFile,
    options.sourceLine, options.startOffset, options.endOffset, 0.8,
    JSON.stringify(evidence),
  );
  return Number(row?.id);
}
