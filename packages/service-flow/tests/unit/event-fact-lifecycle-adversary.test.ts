import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/fact-lifecycle.js';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { trace } from '../../src/trace/trace-engine.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const indexedAt = '2026-01-01T00:00:00.000Z';
const sourceFile = 'src/events.ts';
const eventSpan = { start: 100, end: 140 };

type ZeroRoleStatus =
  | 'unsupported_inline'
  | 'unsupported_wrapper'
  | 'unsupported_reference_shape'
  | 'missing_argument';

interface Fixture {
  db: Db;
  registrationId: number;
  roleId?: number;
  subscriptionId: number;
}

interface EventMutation {
  label: string;
  categories: string[];
  mutate: (fixture: Fixture) => void;
}

const zeroRoleEvidence: Record<ZeroRoleStatus, {
  reason: string;
  shape: string;
}> = {
  unsupported_inline: {
    reason: 'inline_handler_body_not_indexed',
    shape: 'inline_callback',
  },
  unsupported_wrapper: {
    reason: 'wrapper_requires_one_reference',
    shape: 'wrapper_call',
  },
  unsupported_reference_shape: {
    reason: 'handler_reference_shape_unsupported',
    shape: 'unsupported_expression',
  },
  missing_argument: {
    reason: 'handler_argument_missing',
    shape: 'missing',
  },
};

function packageSurface(): string {
  return JSON.stringify({
    schema: 'service-flow/package-public-surface@1',
    status: 'complete',
    reason: null,
    recordCap: 256,
    total: 0,
    shown: 0,
    omitted: 0,
    packageName: '@neutral/events',
    exportsPresent: false,
    exportsAuthoritative: false,
    main: null,
    module: null,
    entries: [],
    scopes: [],
  });
}

function bodyEvidence(): string {
  return JSON.stringify({
    executableBodyEligibility: {
      eligible: true,
      reason: 'body_present',
    },
  });
}

function insertRepository(db: Db, root: string): void {
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(1, root, db.path, indexedAt, indexedAt);
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,package_name,
    dependencies_json,package_public_surface_json,kind,is_git_repo,
    last_indexed_at,index_status,fact_generation,graph_generation,
    fact_analyzer_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'events', path.join(root, 'events'), 'events', '@neutral/events',
    '{}', packageSurface(), 'cap-service', 1, indexedAt, 'indexed', 2, 1,
    ANALYZER_VERSION,
  );
}

function insertSymbol(
  db: Db,
  id: number,
  kind: string,
  name: string,
  start: number,
  end: number,
): void {
  db.prepare(`INSERT INTO symbols(
    id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 1, kind, name,
    kind === 'event_registration' ? `event:${name}` : name,
    0, 1, 20, start, end, sourceFile, bodyEvidence(),
  );
}

function insertHandlerSelector(db: Db): void {
  db.prepare(`INSERT INTO handler_classes(
    id,repo_id,symbol_id,class_name,source_file,source_line
  ) VALUES(?,?,?,?,?,?)`).run(
    1, 1, 2, 'EventHandler', sourceFile, 10,
  );
  db.prepare(`INSERT INTO handler_methods(
    id,handler_class_id,method_name,decorator_kind,decorator_value,
    decorator_raw_expression,decorator_resolution_json,source_file,
    source_line
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'handle', 'Event', 'Created', "'Created'",
    JSON.stringify({
      resolutionKind: 'literal',
      handlerKind: 'event',
      executable: true,
    }),
    sourceFile, 11,
  );
}

function handlerEvidence(status?: ZeroRoleStatus): Record<string, unknown> {
  if (!status) return {
    handlerReferenceStatus: 'role_required',
    handlerReferenceShape: 'identifier',
  };
  return {
    handlerReferenceStatus: status,
    handlerReferenceReason: zeroRoleEvidence[status].reason,
    handlerReferenceShape: zeroRoleEvidence[status].shape,
  };
}

function outboundEvidence(status?: ZeroRoleStatus): string {
  return JSON.stringify({
    ...handlerEvidence(status),
    receiverClassification: 'cap_evidence',
    receiverProof: 'structural_cap_connect',
    consideredBindingSites: [],
    sourceOwnerResolution: 'owned_exact',
    serviceBindingReference: {
      status: 'not_applicable',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    },
    serviceBindingResolution: {
      status: 'not_applicable',
      candidateCount: 0,
    },
  });
}

function insertSubscription(db: Db, status?: ZeroRoleStatus): number {
  const row = db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,event_name_expr,source_file,
    source_line,call_site_start_offset,call_site_end_offset,confidence,
    evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    1, 1, 'async_subscribe', 'Created', sourceFile, 4,
    eventSpan.start, eventSpan.end, 1, outboundEvidence(status),
  );
  return Number(row?.id);
}

function roleEvidence(): string {
  return JSON.stringify({
    relation: 'indexed_local_symbol',
    caller: 'event:Created',
    targetName: 'handle',
    factOrigin: 'event_subscribe_handler_reference',
    candidateStrategy: 'same_file_exact',
    candidateCount: 1,
    eligibleCandidateCount: 1,
    selectedCandidateCount: 1,
    candidateSetComplete: true,
    unresolvedReason: null,
  });
}

function insertRole(db: Db): number {
  const row = db.prepare(`INSERT INTO symbol_calls(
    repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    1, 1, 2, 'handle', sourceFile, 4, eventSpan.start, eventSpan.end,
    'event_subscribe_handler', 'resolved', 1, roleEvidence(),
  );
  return Number(row?.id);
}

function insertLastGoodGraph(db: Db): void {
  db.prepare(`INSERT INTO graph_edges(
    id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'CALLS_SYMBOL', 'resolved', 'symbol', 'prior',
    'symbol', 'prior-target', 1, '{"lastGood":true}', 0, 1,
  );
}

function fixture(status?: ZeroRoleStatus): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sf-event-lifecycle-'));
  const db = openDatabase(path.join(root, 'graph.db'));
  insertRepository(db, root);
  insertSymbol(
    db, 1, 'event_registration', 'Created', eventSpan.start, eventSpan.end,
  );
  insertSymbol(db, 2, 'function', 'handle', 300, 400);
  insertHandlerSelector(db);
  const subscriptionId = insertSubscription(db, status);
  const roleId = status ? undefined : insertRole(db);
  insertLastGoodGraph(db);
  return { db, registrationId: 1, roleId, subscriptionId };
}

function categories(diagnostic: FactLifecycleDiagnostic): string[] {
  const values = diagnostic.invalidFactCategories;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return [];
    const category = (value as Record<string, unknown>).category;
    return typeof category === 'string' ? [category] : [];
  });
}

function updateEvidence(
  db: Db,
  table: 'outbound_calls' | 'symbol_calls',
  id: number,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const row = db.prepare(
    `SELECT evidence_json evidenceJson FROM ${table} WHERE id=?`,
  ).get(id);
  if (typeof row?.evidenceJson !== 'string')
    throw new Error(`Missing ${table} evidence`);
  const parsed: unknown = JSON.parse(row.evidenceJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`Invalid ${table} evidence`);
  const value = parsed as Record<string, unknown>;
  mutate(value);
  db.prepare(`UPDATE ${table} SET evidence_json=? WHERE id=?`)
    .run(JSON.stringify(value), id);
}

function duplicateRole(db: Db, roleId: number): void {
  db.prepare(`INSERT INTO symbol_calls(
    repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json,unresolved_reason
  ) SELECT repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json,unresolved_reason
    FROM symbol_calls WHERE id=?`).run(roleId);
}

function insertInvalidGeneratedConstant(db: Db): void {
  db.prepare(`INSERT INTO generated_constants(
    repo_id,source_file,source_line,name,container_name,member_name,value,
    constant_kind,exported,stable,resolution_status,unresolved_reason,
    declaration_start_offset,declaration_end_offset,
    value_start_offset,value_end_offset
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, sourceFile, 2, 'TOPICS.CREATED', 'TOPICS', 'CREATED', null,
    'const_object_property', 1, 1, 'resolved', null,
    10, 30, 20, 25,
  );
}

function insertDuplicateEmit(db: Db): void {
  const evidence = JSON.stringify({
    receiverClassification: 'cap_evidence',
    receiverProof: 'lexical_connect_assignment',
    consideredBindingSites: [],
    sourceOwnerResolution: 'owned_exact',
    serviceBindingReference: {
      status: 'not_applicable',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    },
    serviceBindingResolution: {
      status: 'not_applicable',
      candidateCount: 0,
    },
  });
  const row = db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,event_name_expr,source_file,
    source_line,call_site_start_offset,call_site_end_offset,confidence,
    evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    1, 2, 'async_emit', 'Duplicated', sourceFile, 12,
    320, 340, 1, evidence,
  );
  db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,event_name_expr,source_file,
    source_line,call_site_start_offset,call_site_end_offset,confidence,
    evidence_json
  ) SELECT repo_id,source_symbol_id,call_type,event_name_expr,source_file,
    source_line,call_site_start_offset,call_site_end_offset,confidence,
    evidence_json FROM outbound_calls WHERE id=?`).run(row?.id);
}

function graphSnapshot(db: Db): string {
  return JSON.stringify({
    graph: db.prepare('SELECT * FROM graph_edges ORDER BY id').all(),
    generation: db.prepare(`SELECT fact_generation factGeneration,
      graph_generation graphGeneration,graph_stale_reason graphStaleReason
      FROM repositories WHERE id=1`).get(),
  });
}

function requiredRoleId(value: Fixture): number {
  if (value.roleId === undefined) throw new Error('Missing role fixture');
  return value.roleId;
}

const mutations: EventMutation[] = [
  {
    label: 'missing event receiver classification',
    categories: ['event_fact_semantics_invalid'],
    mutate: ({ db, subscriptionId }) => updateEvidence(
      db, 'outbound_calls', subscriptionId,
      (value) => { delete value.receiverClassification; },
    ),
  },
  {
    label: 'invalid repository environment declaration counts',
    categories: ['repository_environment_declarations_invalid'],
    mutate: ({ db }) => db.prepare(`UPDATE repositories
      SET environment_declarations_json=? WHERE id=1`).run(JSON.stringify({
      schema: 'service-flow/environment-declarations@1',
      status: 'not_applicable',
      reason: null,
      recordCap: 32,
      total: 1,
      shown: 0,
      omitted: 1,
      declarations: [],
    })),
  },
  {
    label: 'malformed event skeleton semantics',
    categories: ['event_fact_semantics_invalid'],
    mutate: ({ db, subscriptionId }) => {
      db.prepare(`UPDATE outbound_calls SET event_name_expr=?,
        unresolved_reason='dynamic_event_name_identifier',
        event_skeleton_signature=?,event_skeleton_json='{}'
        WHERE id=?`).run('${kind}RecordStored', 'a'.repeat(64), subscriptionId);
      updateEvidence(db, 'outbound_calls', subscriptionId, (value) => {
        value.eventNameUnresolvedReason = 'dynamic_event_name_identifier';
        value.eventNameStatus = 'dynamic';
        value.eventNameSourceKind = 'template_with_substitutions';
        value.eventNamePlaceholderKeys = ['kind'];
      });
    },
  },
  {
    label: 'invalid generated constant resolution matrix',
    categories: ['generated_constant_fact_invalid'],
    mutate: ({ db }) => insertInvalidGeneratedConstant(db),
  },
  {
    label: 'duplicate event publication site',
    categories: ['async_emit_site_duplicate'],
    mutate: ({ db }) => insertDuplicateEmit(db),
  },
  {
    label: 'missing handler-reference status',
    categories: ['subscription_handler_status_invalid'],
    mutate: ({ db, subscriptionId }) => updateEvidence(
      db, 'outbound_calls', subscriptionId,
      (value) => { delete value.handlerReferenceStatus; },
    ),
  },
  {
    label: 'unknown handler-reference status',
    categories: ['subscription_handler_status_invalid'],
    mutate: ({ db, subscriptionId }) => updateEvidence(
      db, 'outbound_calls', subscriptionId,
      (value) => { value.handlerReferenceStatus = 'unknown'; },
    ),
  },
  {
    label: 'missing durable fact origin',
    categories: ['event_handler_role_provenance_invalid'],
    mutate: (value) => updateEvidence(
      value.db, 'symbol_calls', requiredRoleId(value),
      (evidence) => { delete evidence.factOrigin; },
    ),
  },
  {
    label: 'wrong durable fact origin',
    categories: ['event_handler_role_provenance_invalid'],
    mutate: (value) => updateEvidence(
      value.db, 'symbol_calls', requiredRoleId(value),
      (evidence) => { evidence.factOrigin = 'ordinary_symbol_reference'; },
    ),
  },
  {
    label: 'forged evidence caller',
    categories: ['symbol_call_owner_invalid'],
    mutate: (value) => updateEvidence(
      value.db, 'symbol_calls', requiredRoleId(value),
      (evidence) => { evidence.caller = 'forged.owner'; },
    ),
  },
  {
    label: 'empty resolver strategy',
    categories: [
      'event_handler_role_provenance_invalid',
      'symbol_call_resolution_matrix_invalid',
    ],
    mutate: (value) => updateEvidence(
      value.db, 'symbol_calls', requiredRoleId(value),
      (evidence) => { evidence.candidateStrategy = ''; },
    ),
  },
  {
    label: 'empty event name',
    categories: ['event_name_invalid'],
    mutate: ({ db, subscriptionId }) => db.prepare(
      'UPDATE outbound_calls SET event_name_expr=? WHERE id=?',
    ).run('', subscriptionId),
  },
  {
    label: 'deleted required role',
    categories: ['subscription_handler_cardinality_invalid'],
    mutate: (value) => value.db.prepare(
      'DELETE FROM symbol_calls WHERE id=?',
    ).run(requiredRoleId(value)),
  },
  {
    label: 'orphan handler role',
    categories: ['event_handler_role_provenance_invalid'],
    mutate: ({ db, subscriptionId }) => db.prepare(
      'DELETE FROM outbound_calls WHERE id=?',
    ).run(subscriptionId),
  },
  {
    label: 'duplicate handler role',
    categories: [
      'symbol_call_site_duplicate',
      'subscription_handler_cardinality_invalid',
    ],
    mutate: (value) => duplicateRole(value.db, requiredRoleId(value)),
  },
  {
    label: 'subscription and role source-line mismatch',
    categories: ['event_handler_role_provenance_invalid'],
    mutate: (value) => value.db.prepare(
      'UPDATE symbol_calls SET source_line=5 WHERE id=?',
    ).run(requiredRoleId(value)),
  },
  {
    label: 'subscription without exact registration owner',
    categories: [
      'outbound_call_owner_invalid',
      'symbol_call_owner_invalid',
    ],
    mutate: ({ db, registrationId }) => db.prepare(
      "UPDATE symbols SET kind='function' WHERE id=?",
    ).run(registrationId),
  },
  {
    label: 'zero-role status retaining a role row',
    categories: ['subscription_handler_cardinality_invalid'],
    mutate: ({ db, subscriptionId }) => updateEvidence(
      db, 'outbound_calls', subscriptionId,
      (value) => {
        value.handlerReferenceStatus = 'unsupported_inline';
        value.handlerReferenceReason = 'inline_handler_body_not_indexed';
        value.handlerReferenceShape = 'inline_callback';
      },
    ),
  },
];

function assertMutationRejected(testCase: EventMutation): void {
  const value = fixture();
  const before = graphSnapshot(value.db);
  testCase.mutate(value);
  const diagnostic = factLifecycleDiagnostic(value.db, 1);
  expect(diagnostic).toMatchObject({ code: 'reindex_required' });
  if (!diagnostic) throw new Error('Expected lifecycle rejection');
  expect(categories(diagnostic)).toEqual(
    expect.arrayContaining(testCase.categories),
  );
  const workspace = value.db.prepare(
    'SELECT root_path rootPath FROM workspaces WHERE id=1',
  ).get();
  expect(diagnostic.remediation).toContain(String(workspace?.rootPath));
  expect(diagnostic.remediation).toContain('doctor');
  expect(diagnostic.remediation).not.toContain('index');
  if (testCase.categories.some((item) =>
    item === 'event_fact_semantics_invalid'
      || item === 'generated_constant_fact_invalid')) {
    expect(diagnostic.invalidFactExamples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repositoryName: 'events',
        sourceFile,
      }),
    ]));
  }
  expect(() => linkWorkspace(value.db, 1)).toThrow(/reindex_required/);
  expect(graphSnapshot(value.db)).toBe(before);
  value.db.close();
}

function selectorJsonGuard(db: Db): Db {
  return {
    ...db,
    prepare: (sql) => {
      if (sql.includes('json_extract')
        && sql.includes('decorator_resolution_json'))
        throw new Error('selector_json_reached_before_lifecycle');
      return db.prepare(sql);
    },
  };
}

describe('event current-fact lifecycle adversary', () => {
  it('accepts one exact role-required association', () => {
    const value = fixture();
    expect(factLifecycleDiagnostic(value.db, 1)).toBeUndefined();
    value.db.close();
  });

  it.each(mutations)('rejects $label before graph replacement', (testCase) => {
    assertMutationRejected(testCase);
  });
});

describe('event zero-role and reader ordering lifecycle', () => {
  it.each(Object.keys(zeroRoleEvidence) as ZeroRoleStatus[])(
    'accepts explicit zero-role status %s',
    (status) => {
      const value = fixture(status);
      expect(factLifecycleDiagnostic(value.db, 1)).toBeUndefined();
      const linked = linkWorkspace(value.db, 1);
      expect(linked).toMatchObject({
        subscriptionHandlerResolvedCount: 0,
        subscriptionHandlerAmbiguousCount: 0,
        subscriptionHandlerUnresolvedCount: 0,
        subscriptionHandlerMissingAssociationCount: 0,
      });
      expect(value.db.prepare(`SELECT COUNT(*) count FROM graph_edges
        WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'`).get()?.count).toBe(0);
      value.db.close();
    },
  );

  it('short-circuits handler trace and strict doctor before selector JSON', () => {
    const value = fixture();
    const before = graphSnapshot(value.db);
    updateEvidence(
      value.db, 'symbol_calls', requiredRoleId(value),
      (evidence) => { delete evidence.factOrigin; },
    );
    const guarded = selectorJsonGuard(value.db);
    const traced = trace(
      guarded, { repo: 'events', handler: 'handle' },
      { workspaceId: 1, depth: 2 },
    );
    expect(traced.edges).toEqual([]);
    expect(traced.diagnostics).toEqual([
      expect.objectContaining({ code: 'reindex_required' }),
    ]);
    expect(doctorDiagnostics(guarded, true, {
      detail: true,
      workspaceId: 1,
    })).toEqual([
      expect.objectContaining({ code: 'reindex_required' }),
    ]);
    expect(graphSnapshot(value.db)).toBe(before);
    value.db.close();
  });
});
