import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import {
  CompactObservationCollector,
  type CompactEdgeObservation,
  type CompactGraphV1,
  type CompactProjectionInput,
  type CompactSemanticEndpoint,
  type CompactStatus,
} from '../../src/trace/014-compact-contract.js';
import {
  compactEventStatus,
  TraceEdgeRecorder,
} from '../../src/trace/015-trace-edge-recorder.js';
import { projectCompactGraph } from '../../src/trace/016-compact-projector.js';
import { traceAndCompact } from '../../src/trace/018-compact-trace.js';
import { traceWithObserver } from '../../src/trace/trace-engine.js';
import type {
  TraceEdge,
  TraceOptions,
  TraceResult,
  TraceStart,
} from '../../src/types.js';
import { ANALYZER_VERSION } from '../../src/version.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const compactSource = {
  schemaVersion: 12,
  analyzerVersion: ANALYZER_VERSION,
  graphGeneration: 1,
};

function semanticTarget(id: string): CompactSemanticEndpoint {
  return {
    kind: 'target', workspaceId: 1,
    targetKind: 'db_entity', targetId: id,
  };
}

async function temporaryDatabase(label: string): Promise<Db> {
  const root = await mkdtemp(path.join(os.tmpdir(), `service-flow-edge-${label}-`));
  return openDatabase(path.join(root, 'graph.db'));
}

function projectionInput(
  db: Db,
  trace: TraceResult,
  observations: CompactEdgeObservation[],
  start: TraceStart = {},
  options: TraceOptions = { depth: 25 },
): CompactProjectionInput {
  return { db, start, options, source: compactSource, trace, observations };
}

function traceResult(edges: TraceEdge[]): TraceResult {
  return { start: {}, nodes: [], edges, diagnostics: [] };
}

function recordStatusEdges(): {
  trace: TraceResult;
  observations: CompactEdgeObservation[];
} {
  const edges: TraceEdge[] = [];
  const collector = new CompactObservationCollector();
  const recorder = new TraceEdgeRecorder(edges, collector);
  const statuses: CompactStatus[] = [
    'resolved', 'terminal', 'inferred', 'dynamic',
    'ambiguous', 'unresolved', 'cycle',
  ];
  statuses.forEach((status, index) => {
    const source = semanticTarget(status === 'cycle' ? 'Loop' : `from-${status}`);
    const target = status === 'cycle' ? source : semanticTarget(`to-${status}`);
    recorder.record({
      step: index + 1, type: `${status}_edge`, from: status,
      to: status, evidence: {}, confidence: (index + 1) / 10,
    }, { source, target, status });
  });
  return { trace: traceResult(edges), observations: collector.observations };
}

function expectStatusContract(compact: CompactGraphV1): void {
  expect(compact.summary.statusCounts).toEqual({
    resolved: 1, terminal: 1, inferred: 1, dynamic: 1,
    ambiguous: 1, unresolved: 1, cycle: 1,
  });
  expect(compact.nodes.every((row) => row.length === 6)).toBe(true);
  expect(compact.edges.every((row) => row.length === 10)).toBe(true);
  expect(compact.edges.every((row) => row[8] === row[1].length)).toBe(true);
  expect(compact.edges.reduce((sum, row) => sum + row[8], 0)).toBe(7);
  expect(compact.edges.flatMap((row) => row[1]).sort((a, b) => a - b))
    .toEqual([0, 1, 2, 3, 4, 5, 6]);
  const cycle = compact.edges.find((row) => row[6] === 'cycle');
  expect(cycle?.[4]).toBe(cycle?.[5]);
}

describe('compact status and tuple invariants', () => {
  it('counts all seven statuses exactly and preserves a visible cycle self-loop', async () => {
    const db = await temporaryDatabase('statuses');
    try {
      const recorded = recordStatusEdges();
      const compact = projectCompactGraph(projectionInput(
        db, recorded.trace, recorded.observations,
      ));
      expectStatusContract(compact);
    } finally {
      db.close();
    }
  });

  it('uses the documented event bridge status precedence', () => {
    expect([
      compactEventStatus('ambiguous', 'cycle_blocked'),
      compactEventStatus('ambiguous', 'not_scheduled'),
      compactEventStatus('unresolved', 'not_scheduled'),
      compactEventStatus('resolved', 'scheduled'),
    ]).toEqual(['cycle', 'ambiguous', 'unresolved', 'inferred']);
  });

  it('renders an exact fixed-width one-edge tuple', async () => {
    const db = await temporaryDatabase('one-edge');
    try {
      const edges: TraceEdge[] = [];
      const collector = new CompactObservationCollector();
      const recorder = new TraceEdgeRecorder(edges, collector);
      recorder.record({
        step: 3, type: 'single_relation', from: 'display A', to: 'display B',
        evidence: {}, confidence: 0.42,
      }, {
        source: semanticTarget('A'), target: semanticTarget('B'),
        status: 'resolved',
      });
      const compact = projectCompactGraph(projectionInput(
        db, traceResult(edges), collector.observations,
      ));
      expect(compact.edges).toEqual([
        ['e0', [0], 3, 'single_relation', 'n0', 'n1',
          'resolved', 0.42, 1, null],
      ]);
    } finally {
      db.close();
    }
  });
});

async function writeOrdinalFixture(root: string): Promise<void> {
  await writeFixtureFile(root, 'ordinal-repo/.git-fixture');
  await writeFixtureFile(root, 'ordinal-repo/package.json', JSON.stringify({
    name: '@neutral/ordinal-repo', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'ordinal-repo/src/flow.ts', `
import cds from '@sap/cds';
export async function indexedFlow(): Promise<void> {
  await cds.run(SELECT.from(Orders));
  await fetch('https://example.invalid/orders');
}
`);
}

describe('one-pass semantic observation correlation', () => {
  it('matches each detailed edge ordinal, step, type, and confidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-ordinal-'));
    await writeOrdinalFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      linkWorkspace(db, workspaceId);
      const collector = new CompactObservationCollector();
      const result = traceWithObserver(db, {
        repo: '@neutral/ordinal-repo',
      }, {
        depth: 4, workspaceId, includeDb: true, includeExternal: true,
      }, collector);

      expect(result.edges.length).toBeGreaterThan(0);
      expect(collector.observations).toHaveLength(result.edges.length);
      result.edges.forEach((edge, ordinal) => {
        expect(collector.observations[ordinal]).toMatchObject({
          ordinal, step: edge.step, type: edge.type, confidence: edge.confidence,
        });
      });
    } finally {
      db.close();
    }
  }, 30_000);
});

function insertedId(row: Record<string, unknown> | undefined): number {
  if (typeof row?.id !== 'number') throw new Error('fixture_insert_failed');
  return row.id;
}

function insertWorkspace(db: Db, name: string): number {
  return insertedId(db.prepare(`INSERT INTO workspaces(
    root_path,db_path,created_at,updated_at
  ) VALUES(?,?, '1970','1970') RETURNING id`).get(
    `/workspace/${name}`, `/workspace/${name}/graph.db`,
  ));
}

function insertRepository(
  db: Db,
  workspaceId: number,
  name: string,
  packageName: string,
  analyzerVersion: string,
  graphGeneration: number,
): void {
  db.prepare(`INSERT INTO repositories(
    workspace_id,name,absolute_path,relative_path,package_name,
    dependencies_json,kind,is_git_repo,index_status,
    fact_analyzer_version,graph_generation
  ) VALUES(?,?,?,?,?,'{}','helper-package',1,'indexed',?,?)`).run(
    workspaceId, name, `/workspace/${name}`, name,
    packageName, analyzerVersion, graphGeneration,
  );
}

describe('compact source compatibility context', () => {
  it('uses the exact selected workspace generation and persisted analyzer', async () => {
    const db = await temporaryDatabase('source-context');
    try {
      const currentWorkspace = insertWorkspace(db, 'current');
      const staleWorkspace = insertWorkspace(db, 'stale');
      insertRepository(
        db, currentWorkspace, 'current-repo', '@neutral/current',
        ANALYZER_VERSION, 41,
      );
      insertRepository(
        db, staleWorkspace, 'stale-repo', '@neutral/stale', '0.1.65', 9,
      );

      const current = traceAndCompact(
        db, { repo: '@neutral/current' }, { depth: 2 },
      ).compact;
      expect(current.source).toMatchObject({
        graphGeneration: 41, analyzerVersion: ANALYZER_VERSION,
      });

      const stale = traceAndCompact(
        db, { repo: '@neutral/stale' }, { depth: 2 },
      ).compact;
      expect(stale.source).toMatchObject({
        graphGeneration: 9, analyzerVersion: '0.1.65',
      });
      expect(stale.summary.completeness).toBe('blocked');
      expect(stale.diagnostics[0]?.[2]).toBe('reindex_required');

      const ambiguous = traceAndCompact(db, {}, { depth: 2 }).compact;
      expect(ambiguous.source).toMatchObject({
        graphGeneration: 0, analyzerVersion: 'mixed',
      });
      expect(ambiguous.summary.completeness).toBe('blocked');
      expect(ambiguous.diagnostics[0]?.[2]).toBe('trace_workspace_ambiguous');
      expect(JSON.stringify([stale, ambiguous]).toLowerCase())
        .not.toContain('no such column');
    } finally {
      db.close();
    }
  });
});

describe('compact fixed selector and query fields', () => {
  it('normalizes hints and variable names into deterministic fixed fields', async () => {
    const db = await temporaryDatabase('query-fields');
    try {
      const start: TraceStart = {
        repo: 'orders', servicePath: '/OrdersService', operation: 'submit',
        operationPath: '/OrdersService/submit', handler: 'OrdersHandler',
      };
      const options: TraceOptions = {
        depth: 9, includeAsync: true, includeDb: true, includeExternal: true,
        dynamicMode: 'candidates', maxDynamicCandidates: 13,
        vars: { ZETA: 'PRIVATE_ZETA', ALPHA: 'PRIVATE_ALPHA' },
        implementationRepo: 'primary-implementation',
        implementationHints: [
          { servicePath: '/Z', implementationRepo: 'z-implementation' },
          {
            servicePath: '/A', operationPath: '/A/run', packageName: '@neutral/a',
            repositoryName: 'repo-a', candidateFamily: '@neutral/family-a',
            implementationRepo: 'a-implementation',
          },
        ],
      };
      const compact = projectCompactGraph(projectionInput(
        db, traceResult([]), [], start, options,
      ));

      expect(Object.keys(compact.start)).toEqual([
        'repo', 'servicePath', 'operation', 'operationPath', 'handler',
      ]);
      expect(Object.keys(compact.query)).toEqual([
        'depth', 'includeAsync', 'includeDb', 'includeExternal', 'dynamicMode',
        'maxDynamicCandidates', 'suppliedVariableNames', 'runtimeValuesOmitted',
        'implementationRepo', 'implementationHints',
      ]);
      expect(compact.query.suppliedVariableNames).toEqual(['ALPHA', 'ZETA']);
      expect(compact.query.implementationHints.map((hint) => hint.servicePath))
        .toEqual(['/A', '/Z']);
      expect(compact.query.implementationHints.every((hint) =>
        Object.keys(hint).join(',') === [
          'servicePath', 'operationPath', 'packageName', 'repositoryName',
          'candidateFamily', 'implementationRepo',
        ].join(','))).toBe(true);
      expect(JSON.stringify(compact)).not.toContain('PRIVATE_ALPHA');
      expect(JSON.stringify(compact)).not.toContain('PRIVATE_ZETA');
    } finally {
      db.close();
    }
  });
});
