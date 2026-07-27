import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/fact-lifecycle.js';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import type { ServiceBindingReference } from '../../src/types.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const indexedAt = '2026-01-01T00:00:00.000Z';
const sourceFile = 'src/run.ts';
const publicSurface = JSON.stringify({
  schema: 'service-flow/package-public-surface@1',
  recordCap: 256,
  packageName: null,
  exportsPresent: false,
  exportsAuthoritative: false,
  status: 'not_applicable',
  reason: null,
  main: null,
  module: null,
  entries: [],
  scopes: [],
  total: 0,
  shown: 0,
  omitted: 0,
});

function resolvedReference(): ServiceBindingReference {
  return {
    status: 'resolved_exact',
    variableName: 'remote',
    bindingSourceFile: sourceFile,
    bindingSiteStartOffset: 10,
    bindingSiteEndOffset: 20,
    resolutionStrategy: 'lexical_declaration',
    lexicalScopeChain: [
      { kind: 'source_file', startOffset: 0, endOffset: 300 },
      { kind: 'function', startOffset: 1, endOffset: 250 },
      { kind: 'block', startOffset: 5, endOffset: 240 },
    ],
    bindingScopeIndex: 2,
    scopeChainTotal: 3,
    scopeChainShown: 3,
    scopeChainOmitted: 0,
  };
}

function callEvidence(
  reference: Record<string, unknown> | ServiceBindingReference,
  selectedBindingId = 1,
): string {
  const status = Reflect.get(reference, 'status');
  const resolution = status === 'resolved_exact'
    ? {
        status: 'selected_exact',
        selectedBindingId,
        candidateCount: 1,
      }
    : { status, candidateCount: 0 };
  return JSON.stringify({
    sourceOwnerResolution: 'owned_exact',
    serviceBindingReference: reference,
    serviceBindingResolution: resolution,
  });
}

function insertRepository(
  db: Db,
  id: number,
  workspaceRoot: string,
): void {
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,package_name,
    package_version,dependencies_json,package_public_surface_json,kind,
    is_git_repo,last_indexed_at,index_status,fingerprint,fact_generation,
    graph_generation,fact_analyzer_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 1, `neutral-${id}`, path.join(workspaceRoot, `neutral-${id}`),
    `neutral-${id}`, null, null, '{}', publicSurface, 'cap-service', 1,
    indexedAt, 'indexed', `fingerprint-${id}`, 3, 2, ANALYZER_VERSION,
  );
}

function insertSymbol(
  db: Db,
  id: number,
  repoId: number,
  startOffset: number,
  endOffset: number,
  qualifiedName = 'run',
  kind = 'function',
): void {
  db.prepare(`INSERT INTO symbols(
    id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, repoId, kind, qualifiedName, qualifiedName, 0, 1, 20,
    startOffset, endOffset, sourceFile, '{}',
  );
}

function insertBinding(
  db: Db,
  id: number,
  repoId: number,
  symbolId: number | null,
  variableName: string,
  startOffset: number,
  endOffset: number,
): void {
  const owner = symbolId === null
    ? 'ownerless_file_scope'
    : 'owned_exact';
  db.prepare(`INSERT INTO service_bindings(
    id,repo_id,symbol_id,variable_name,is_dynamic,placeholders_json,
    source_file,source_line,binding_site_start_offset,
    binding_site_end_offset,owner_resolution,helper_chain_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, repoId, symbolId, variableName, 0, '[]', sourceFile, 2,
    startOffset, endOffset, owner, '[]',
  );
}

function seedFixture(db: Db, dbPath: string): void {
  const workspaceRoot = path.dirname(dbPath);
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(
    1, workspaceRoot, dbPath, indexedAt, indexedAt,
  );
  insertRepository(db, 1, workspaceRoot);
  insertSymbol(db, 1, 1, 1, 250);
  insertBinding(db, 1, 1, 1, 'remote', 10, 20);
  db.prepare(`INSERT INTO outbound_calls(
    id,repo_id,source_symbol_id,call_type,service_binding_id,method,
    operation_path_expr,source_file,source_line,call_site_start_offset,
    call_site_end_offset,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 'remote_action', 1, 'POST', '/run', sourceFile, 3,
    50, 60, 1, callEvidence(resolvedReference()),
  );
  db.prepare(`INSERT INTO graph_edges(
    id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'CALLS_SYMBOL', 'resolved', 'symbol', 'old-source',
    'symbol', 'old-target', 1, '{"lastGood":true}', 0, 2,
  );
}

function fixture(): Db {
  const root = mkdtempSync(path.join(os.tmpdir(), 'service-flow-binding-'));
  const dbPath = path.join(root, 'graph.db');
  const db = openDatabase(dbPath);
  seedFixture(db, dbPath);
  return db;
}

function graphSnapshot(db: Db): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT * FROM graph_edges ORDER BY id',
  ).all();
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function diagnosticCategories(
  diagnostic: FactLifecycleDiagnostic,
): string[] {
  const raw = diagnostic.invalidFactCategories;
  if (!isUnknownArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || isUnknownArray(item))
      return [];
    return 'category' in item && typeof item.category === 'string'
      ? [item.category]
      : [];
  });
}

function expectRejected(
  db: Db,
  graphBefore: Array<Record<string, unknown>>,
  expectedCategory: string,
): void {
  const diagnostic = factLifecycleDiagnostic(db, 1);
  expect(diagnostic).toMatchObject({
    code: 'reindex_required',
    staleRepositoryCount: 0,
  });
  if (!diagnostic) throw new Error('Expected lifecycle diagnostic');
  expect(diagnosticCategories(diagnostic)).toContain(expectedCategory);
  expect(diagnostic.remediation).toContain('service-flow doctor');
  expect(diagnostic.remediation).toContain('--strict --detail');
  expect(diagnostic.remediation).not.toContain('index');
  expect(typeof diagnostic.invalidFactCategoryCount).toBe('number');
  expect(typeof diagnostic.shownInvalidFactCategoryCount).toBe('number');
  expect(typeof diagnostic.omittedInvalidFactCategoryCount).toBe('number');
  expect(JSON.stringify(diagnostic)).not.toContain(sourceFile);
  expect(() => linkWorkspace(db, 1)).toThrow(/reindex_required/);
  expect(graphSnapshot(db)).toEqual(graphBefore);
}

function setReference(
  db: Db,
  reference: Record<string, unknown> | ServiceBindingReference,
  selectedBindingId = 1,
): void {
  db.prepare(
    'UPDATE outbound_calls SET evidence_json=? WHERE id=1',
  ).run(callEvidence(reference, selectedBindingId));
}

interface MutationCase {
  label: string;
  category: string;
  mutate: (db: Db) => void;
}

const ownerAndSpanCases: MutationCase[] = [
  {
    label: 'an unknown outbound call type',
    category: 'outbound_call_type_invalid',
    mutate: (db) => db.prepare(
      "UPDATE outbound_calls SET call_type='forged_call' WHERE id=1",
    ).run(),
  },
  {
    label: 'an empty outbound source file',
    category: 'outbound_binding_row_shape_invalid',
    mutate: (db) => db.prepare(
      "UPDATE outbound_calls SET source_file='' WHERE id=1",
    ).run(),
  },
  {
    label: 'missing binding-site spans',
    category: 'service_binding_site_or_owner_invalid',
    mutate: (db) => db.prepare(`UPDATE service_bindings
      SET binding_site_start_offset=NULL,binding_site_end_offset=NULL
      WHERE id=1`).run(),
  },
  {
    label: 'an inverted binding-site span',
    category: 'service_binding_site_or_owner_invalid',
    mutate: (db) => db.prepare(`UPDATE service_bindings
      SET binding_site_start_offset=20,binding_site_end_offset=10
      WHERE id=1`).run(),
  },
  {
    label: 'a wider containing owner instead of the unique best owner',
    category: 'service_binding_unique_owner_invalid',
    mutate: (db) => {
      insertSymbol(db, 2, 1, 0, 300, 'wider');
      db.prepare(
        'UPDATE service_bindings SET symbol_id=2 WHERE id=1',
      ).run();
    },
  },
  {
    label: 'a non-containing binding owner',
    category: 'service_binding_site_or_owner_invalid',
    mutate: (db) => {
      insertSymbol(db, 2, 1, 21, 40, 'unrelated', 'callback');
      db.prepare(
        'UPDATE service_bindings SET symbol_id=2 WHERE id=1',
      ).run();
    },
  },
  {
    label: 'ownerless binding state while an executable scope contains it',
    category: 'service_binding_unique_owner_invalid',
    mutate: (db) => db.prepare(`UPDATE service_bindings
      SET symbol_id=NULL,owner_resolution='ownerless_file_scope'
      WHERE id=1`).run(),
  },
  {
    label: 'two equal unique-best owner facts',
    category: 'service_binding_unique_owner_invalid',
    mutate: (db) => insertSymbol(db, 2, 1, 1, 250),
  },
  {
    label: 'a binding owner that contains the site but not the call',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      insertSymbol(db, 2, 1, 5, 30, 'binding-only', 'callback');
      db.prepare(
        'UPDATE service_bindings SET symbol_id=2 WHERE id=1',
      ).run();
    },
  },
];

const referenceShapeCases: MutationCase[] = [
  {
    label: 'a missing service-binding reference',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => db.prepare(
      'UPDATE outbound_calls SET evidence_json=? WHERE id=1',
    ).run(JSON.stringify({ sourceOwnerResolution: 'owned_exact' })),
  },
  {
    label: 'an unknown service-binding reference status',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      status: 'selected',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    }),
  },
  {
    label: 'a not-applicable reference that still names a variable',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=NULL WHERE id=1',
      ).run();
      setReference(db, {
        status: 'not_applicable',
        variableName: 'remote',
        scopeChainTotal: 0,
        scopeChainShown: 0,
        scopeChainOmitted: 0,
      });
    },
  },
  {
    label: 'an unresolved reference with a selected binding',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      status: 'unresolved',
      variableName: 'remote',
      reason: 'binding_not_found',
      scopeChainTotal: 0,
      scopeChainShown: 0,
      scopeChainOmitted: 0,
    }),
  },
  {
    label: 'a resolved reference with a null binding',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => db.prepare(
      'UPDATE outbound_calls SET service_binding_id=NULL WHERE id=1',
    ).run(),
  },
  {
    label: 'an ambiguous reference with a non-ambiguous reason',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=NULL WHERE id=1',
      ).run();
      setReference(db, {
        status: 'ambiguous',
        variableName: 'remote',
        reason: 'binding_not_found',
        scopeChainTotal: 0,
        scopeChainShown: 0,
        scopeChainOmitted: 0,
      });
    },
  },
  {
    label: 'a resolved reference with forged persistence resolution',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => db.prepare(
      'UPDATE outbound_calls SET evidence_json=? WHERE id=1',
    ).run(JSON.stringify({
      sourceOwnerResolution: 'owned_exact',
      serviceBindingReference: resolvedReference(),
      serviceBindingResolution: {
        status: 'selected_exact',
        selectedBindingId: 1,
        candidateCount: 2,
      },
    })),
  },
  {
    label: 'a not-applicable reference with omitted lexical scopes',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=NULL WHERE id=1',
      ).run();
      setReference(db, {
        status: 'not_applicable',
        scopeChainTotal: 1,
        scopeChainShown: 0,
        scopeChainOmitted: 1,
      });
    },
  },
  {
    label: 'a non-limit unresolved reason with omitted lexical scopes',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=NULL WHERE id=1',
      ).run();
      setReference(db, {
        status: 'unresolved',
        variableName: 'remote',
        reason: 'binding_not_found',
        scopeChainTotal: 1,
        scopeChainShown: 0,
        scopeChainOmitted: 1,
      });
    },
  },
];

const exactIdentityCases: MutationCase[] = [
  {
    label: 'a same-repository binding with the wrong exact identity',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      insertBinding(db, 2, 1, 1, 'other', 21, 30);
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=2 WHERE id=1',
      ).run();
      setReference(db, resolvedReference(), 2);
    },
  },
  {
    label: 'a cross-repository exact binding',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      insertRepository(db, 2, path.dirname(db.path));
      insertSymbol(db, 20, 2, 1, 250);
      insertBinding(db, 20, 2, 20, 'remote', 10, 20);
      db.prepare(
        'UPDATE outbound_calls SET service_binding_id=20 WHERE id=1',
      ).run();
      setReference(db, resolvedReference(), 20);
    },
  },
  {
    label: 'a variable mismatch in the exact-site proof',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      variableName: 'other',
    }),
  },
  {
    label: 'a site mismatch in the exact-site proof',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      bindingSiteStartOffset: 11,
    }),
  },
  {
    label: 'a declaration after the call',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => {
      db.prepare(`UPDATE service_bindings SET
        binding_site_start_offset=70,binding_site_end_offset=80 WHERE id=1`)
        .run();
      setReference(db, {
        ...resolvedReference(),
        bindingSiteStartOffset: 70,
        bindingSiteEndOffset: 80,
      });
    },
  },
];

const lexicalProofCases: MutationCase[] = [
  {
    label: 'a truncated resolved lexical chain',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      scopeChainTotal: 3,
      scopeChainOmitted: 1,
    }),
  },
  {
    label: 'a non-nested resolved lexical chain',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      lexicalScopeChain: [
        { kind: 'source_file', startOffset: 0, endOffset: 300 },
        { kind: 'function', startOffset: 1, endOffset: 250 },
        { kind: 'block', startOffset: 0, endOffset: 100 },
      ],
      scopeChainTotal: 3,
      scopeChainShown: 3,
      bindingScopeIndex: 1,
    }),
  },
  {
    label: 'an out-of-range binding-scope index',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      bindingScopeIndex: 3,
    }),
  },
  {
    label: 'a shallower scope index than the binding site proves',
    category: 'outbound_binding_lexical_proof_invalid',
    mutate: (db) => setReference(db, {
      ...resolvedReference(),
      bindingScopeIndex: 1,
    }),
  },
];

describe('schema 13 binding lifecycle preflight', () => {
  it('accepts the exact owner, exact binding site, and complete lexical proof', () => {
    const db = fixture();
    expect(db.prepare(`SELECT call.service_binding_id bindingId,
      call.evidence_json evidenceJson,binding.repo_id repoId,
      binding.symbol_id symbolId,binding.variable_name variableName,
      binding.source_file bindingSourceFile,
      binding.binding_site_start_offset bindingSiteStartOffset,
      binding.binding_site_end_offset bindingSiteEndOffset,
      binding.owner_resolution ownerResolution
      FROM outbound_calls call
      JOIN service_bindings binding ON binding.id=call.service_binding_id
      WHERE call.id=1`).get()).toEqual({
      bindingId: 1,
      evidenceJson: callEvidence(resolvedReference()),
      repoId: 1,
      symbolId: 1,
      variableName: 'remote',
      bindingSourceFile: sourceFile,
      bindingSiteStartOffset: 10,
      bindingSiteEndOffset: 20,
      ownerResolution: 'owned_exact',
    });
    expect(factLifecycleDiagnostic(db, 1)).toBeUndefined();
    db.close();
  });

  it.each([
    ...ownerAndSpanCases,
    ...referenceShapeCases,
    ...exactIdentityCases,
    ...lexicalProofCases,
  ])('rejects $label before replacing the last-good graph', ({
    mutate,
    category,
  }) => {
    const db = fixture();
    const graphBefore = graphSnapshot(db);
    mutate(db);
    expectRejected(db, graphBefore, category);
    db.close();
  });
});
