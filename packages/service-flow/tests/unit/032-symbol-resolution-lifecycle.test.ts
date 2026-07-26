import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/001-fact-lifecycle.js';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { trace } from '../../src/trace/trace-engine.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const indexedAt = '2026-01-01T00:00:00.000Z';
const sourceFile = 'src/run.ts';
const surface = JSON.stringify({
  schema: 'service-flow/package-public-surface@1',
  status: 'not_applicable',
  reason: null,
  recordCap: 256,
  total: 0,
  shown: 0,
  omitted: 0,
  packageName: null,
  exportsPresent: false,
  exportsAuthoritative: false,
  main: null,
  module: null,
  entries: [],
  scopes: [],
});

function bodyEvidence(eligible = true): string {
  return JSON.stringify({
    executableBodyEligibility: {
      eligible,
      reason: eligible ? 'body_present' : 'declaration_only',
    },
  });
}

function callEvidence(): Record<string, unknown> {
  return {
    relation: 'indexed_local_symbol',
    caller: 'caller',
    targetName: 'target',
    candidateStrategy: 'same_file_exact',
    candidateCount: 1,
    eligibleCandidateCount: 1,
    selectedCandidateCount: 1,
    candidateSetComplete: true,
    unresolvedReason: null,
  };
}

function insertOperations(db: Db): void {
  db.prepare(`INSERT INTO cds_services(
    id,repo_id,service_name,qualified_name,service_path,is_extend,
    source_file,source_line
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    1, 1, 'NeutralService', 'NeutralService', '/neutral', 0,
    'srv/service.cds', 1,
  );
  const operation = db.prepare(`INSERT INTO cds_operations(
    id,service_id,operation_type,operation_name,operation_path,params_json,
    source_file,source_line,provenance
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  operation.run(
    1, 1, 'action', 'refresh', '/refresh', '[]',
    'srv/service.cds', 2, 'direct',
  );
  operation.run(
    2, 1, 'action', 'reset', '/reset', '[]',
    'srv/service.cds', 3, 'direct',
  );
}

function seed(db: Db, dbPath: string): void {
  const root = path.dirname(dbPath);
  db.prepare(`INSERT INTO workspaces(
    id,root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?,?)`).run(1, root, dbPath, indexedAt, indexedAt);
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,dependencies_json,
    package_public_surface_json,kind,is_git_repo,last_indexed_at,
    index_status,fact_generation,graph_generation,fact_analyzer_version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'neutral', path.join(root, 'neutral'), 'neutral', '{}',
    surface, 'helper-package', 1, indexedAt, 'indexed', 2, 1,
    ANALYZER_VERSION,
  );
  insertSymbol(db, 1, 'caller', 0, 100);
  insertSymbol(db, 2, 'target', 110, 150);
  insertOperations(db);
  db.prepare(`INSERT INTO symbol_calls(
    id,repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 1, 2, 'target', sourceFile, 2, 20, 30,
    'ordinary_call', 'resolved', 1, JSON.stringify(callEvidence()),
  );
  db.prepare(`INSERT INTO graph_edges(
    id,workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
    confidence,evidence_json,is_dynamic,generation
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 'HANDLER_CALLS_LOCAL_FUNCTION', 'resolved',
    'symbol', 'prior', 'symbol', 'prior-target', 1,
    '{"lastGood":true}', 0, 1,
  );
}

function insertSymbol(
  db: Db,
  id: number,
  name: string,
  start: number,
  end: number,
): void {
  db.prepare(`INSERT INTO symbols(
    id,repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 1, 'function', name, name, 0, 1, 10,
    start, end, sourceFile, bodyEvidence(),
  );
}

function fixture(): Db {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sf-symbol-lifecycle-'));
  const dbPath = path.join(root, 'graph.db');
  const db = openDatabase(dbPath);
  seed(db, dbPath);
  return db;
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

function evidence(db: Db): Record<string, unknown> {
  const value = db.prepare(
    'SELECT evidence_json evidenceJson FROM symbol_calls WHERE id=1',
  ).get()?.evidenceJson;
  if (typeof value !== 'string') throw new Error('Missing symbol evidence');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid symbol evidence');
  return parsed as Record<string, unknown>;
}

function setEvidence(db: Db, value: Record<string, unknown>): void {
  db.prepare('UPDATE symbol_calls SET evidence_json=? WHERE id=1')
    .run(JSON.stringify(value));
}

function graphSnapshot(db: Db): string {
  return JSON.stringify(db.prepare(
    'SELECT * FROM graph_edges ORDER BY id',
  ).all());
}

interface MutationCase {
  label: string;
  mutate: (db: Db) => void;
  expectedCategory: string;
}

const cases: MutationCase[] = [
  {
    label: 'forged inherited operation provenance',
    expectedCategory: 'cds_operation_semantics_invalid',
    mutate: (db) => db.prepare(`UPDATE cds_operations
      SET provenance='inherited',base_operation_id=2 WHERE id=1`).run(),
  },
  {
    label: 'repository kind outside the public closed set',
    expectedCategory: 'repository_kind_invalid',
    mutate: (db) => db.prepare(
      "UPDATE repositories SET kind='forged-kind' WHERE id=1",
    ).run(),
  },
  {
    label: 'missing candidate-set completeness',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      const value = evidence(db);
      delete value.candidateSetComplete;
      setEvidence(db, value);
    },
  },
  {
    label: 'missing explicit resolved reason',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      const value = evidence(db);
      delete value.unresolvedReason;
      setEvidence(db, value);
    },
  },
  {
    label: 'package strategy on an ordinary local fact',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      const value = evidence(db);
      value.candidateStrategy = 'package_public_surface_exact';
      setEvidence(db, value);
    },
  },
  {
    label: 'relative strategy without relative typed provenance',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      const value = evidence(db);
      value.candidateStrategy = 'relative_import_exported_exact';
      setEvidence(db, value);
    },
  },
  {
    label: 'erased package markers on a non-relative import',
    expectedCategory: 'package_import_provenance_marker_invalid',
    mutate: (db) => db.prepare(
      "UPDATE symbol_calls SET import_source='@neutral/forged' WHERE id=1",
    ).run(),
  },
  {
    label: 'resolved row with a null target',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => db.prepare(
      'UPDATE symbol_calls SET callee_symbol_id=NULL WHERE id=1',
    ).run(),
  },
  {
    label: 'wrong same-workspace executable target',
    expectedCategory: 'symbol_call_resolution_proof_invalid',
    mutate: (db) => {
      insertSymbol(db, 3, 'other', 160, 190);
      db.prepare(
        'UPDATE symbol_calls SET callee_symbol_id=3 WHERE id=1',
      ).run();
    },
  },
  {
    label: 'bodyless target behind forged resolved evidence',
    expectedCategory: 'symbol_call_resolution_proof_invalid',
    mutate: (db) => db.prepare(
      'UPDATE symbols SET evidence_json=? WHERE id=2',
    ).run(bodyEvidence(false)),
  },
  {
    label: 'non-executable symbol kind behind forged body evidence',
    expectedCategory: 'symbol_call_resolution_proof_invalid',
    mutate: (db) => db.prepare(
      "UPDATE symbols SET kind='object_alias' WHERE id=2",
    ).run(),
  },
  {
    label: 'complete unresolved row with an eligible candidate',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      setEvidence(db, {
        ...callEvidence(),
        selectedCandidateCount: 0,
        unresolvedReason: 'no_local_symbol_target',
      });
      db.prepare(`UPDATE symbol_calls SET status='unresolved',
        callee_symbol_id=NULL,unresolved_reason='no_local_symbol_target'
        WHERE id=1`).run();
    },
  },
  {
    label: 'complete ambiguous row with fewer than two eligible candidates',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => {
      setEvidence(db, {
        ...callEvidence(),
        selectedCandidateCount: 0,
        unresolvedReason: 'multiple_same_file_symbol_targets',
      });
      db.prepare(`UPDATE symbol_calls SET status='ambiguous',
        callee_symbol_id=NULL,
        unresolved_reason='multiple_same_file_symbol_targets'
        WHERE id=1`).run();
    },
  },
  {
    label: 'selected candidate count greater than eligible count',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => setEvidence(db, {
      ...callEvidence(),
      eligibleCandidateCount: 0,
    }),
  },
  {
    label: 'eligible candidate count greater than examined count',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => setEvidence(db, {
      ...callEvidence(),
      candidateCount: 0,
    }),
  },
  {
    label: 'selected candidate count outside the closed zero-or-one set',
    expectedCategory: 'symbol_call_resolution_matrix_invalid',
    mutate: (db) => setEvidence(db, {
      ...callEvidence(),
      selectedCandidateCount: 2,
      candidateCount: 2,
      eligibleCandidateCount: 2,
    }),
  },
];

describe('symbol resolution lifecycle proof', () => {
  it('accepts a recomputed exact executable target', () => {
    const db = fixture();
    expect(factLifecycleDiagnostic(db, 1)).toBeUndefined();
    db.close();
  });

  it.each(cases)('rejects $label before graph replacement', ({
    mutate,
    expectedCategory,
  }) => {
    const db = fixture();
    const before = graphSnapshot(db);
    mutate(db);
    const diagnostic = factLifecycleDiagnostic(db, 1);
    expect(diagnostic).toMatchObject({ code: 'reindex_required' });
    if (!diagnostic) throw new Error('Expected lifecycle rejection');
    expect(categories(diagnostic)).toContain(expectedCategory);
    expect(doctorDiagnostics(db, true, { workspaceId: 1 })[0])
      .toMatchObject({ code: 'reindex_required' });
    expect(trace(db, { repo: 'neutral' }, {
      depth: 1,
      workspaceId: 1,
    }).diagnostics[0]).toMatchObject({ code: 'reindex_required' });
    expect(() => linkWorkspace(db, 1)).toThrow(/reindex_required/);
    expect(graphSnapshot(db)).toBe(before);
    db.close();
  });
});
