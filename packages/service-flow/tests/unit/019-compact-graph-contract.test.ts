import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { renderCompactJson } from '../../src/output/001-compact-json-output.js';
import type {
  CompactEdgeObservation,
  CompactProjectionInput,
  CompactSemanticEndpoint,
} from '../../src/trace/014-compact-contract.js';
import { projectCompactGraph } from '../../src/trace/016-compact-projector.js';
import type { TraceEdge, TraceResult } from '../../src/types.js';

const databases: Db[] = [];
const source = {
  schemaVersion: 12,
  analyzerVersion: '0.1.66-facts.1',
  graphGeneration: 7,
};

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

async function temporaryDatabase(label: string): Promise<Db> {
  const root = await mkdtemp(path.join(os.tmpdir(), `service-flow-compact-${label}-`));
  const db = openDatabase(path.join(root, 'graph.db'));
  databases.push(db);
  return db;
}

function trace(edges: TraceEdge[], diagnostics: Array<Record<string, unknown>> = [],
  nodes: Array<Record<string, unknown>> = []): TraceResult {
  return { start: {}, nodes, edges, diagnostics };
}

function detailedEdge(index: number, evidence: Record<string, unknown> = {}): TraceEdge {
  return {
    step: 1, type: 'local_db_query', from: `display:${index}`,
    to: `target:${index}`, evidence, confidence: 0.8,
  };
}

function target(id: string): CompactSemanticEndpoint {
  return { kind: 'target', workspaceId: 1, targetKind: 'db_entity', targetId: id };
}

function observation(
  ordinal: number,
  sourceEndpoint: CompactSemanticEndpoint,
  targetEndpoint: CompactSemanticEndpoint,
  overrides: Partial<CompactEdgeObservation> = {},
): CompactEdgeObservation {
  return {
    ordinal, step: 1, type: 'local_db_query', source: sourceEndpoint,
    target: targetEndpoint, status: 'terminal', confidence: 0.8, ...overrides,
  };
}

function projectionInput(
  db: Db,
  result: TraceResult,
  observations: CompactEdgeObservation[],
): CompactProjectionInput {
  return {
    db, start: {}, options: { depth: 25 }, source, trace: result, observations,
  };
}

function insertedId(row: Record<string, unknown> | undefined): number {
  if (typeof row?.id !== 'number') throw new Error('fixture_insert_failed');
  return row.id;
}

function insertWorkspace(db: Db, name = 'primary'): number {
  return insertedId(db.prepare(`INSERT INTO workspaces(
    root_path,db_path,created_at,updated_at
  ) VALUES(?,?, '1970','1970') RETURNING id`).get(
    `/workspace/${name}`, `/workspace/${name}/graph.db`,
  ));
}

function insertRepository(db: Db, workspaceId: number, relativePath: string): number {
  return insertedId(db.prepare(`INSERT INTO repositories(
    workspace_id,name,absolute_path,relative_path,dependencies_json,kind,is_git_repo
  ) VALUES(?,?,?,?, '{}','helper-package',1) RETURNING id`).get(
    workspaceId, relativePath, `/workspace/${relativePath}`, relativePath,
  ));
}

function insertSymbol(db: Db, repoId: number, name: string): number {
  return insertedId(db.prepare(`INSERT INTO symbols(
    repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,evidence_json
  ) VALUES(?,?,?,?,1,10,12,100,160,'src/handler.ts','{}') RETURNING id`).get(
    repoId, 'method', name, name,
  ));
}

function insertHandlerMethod(db: Db, repoId: number, symbolId: number): number {
  const classId = insertedId(db.prepare(`INSERT INTO handler_classes(
    repo_id,symbol_id,class_name,source_file,source_line
  ) VALUES(?,?,'Handler','src/handler.ts',1) RETURNING id`).get(repoId, symbolId));
  return insertedId(db.prepare(`INSERT INTO handler_methods(
    handler_class_id,method_name,decorator_kind,decorator_raw_expression,
    decorator_resolution_json,source_file,source_line
  ) VALUES(?,'run','Action','Action','{}','src/handler.ts',10) RETURNING id`)
    .get(classId));
}

it('renders the exact empty fixed-width contract as one minified line', async () => {
    const db = await temporaryDatabase('empty');
    const compact = projectCompactGraph(projectionInput(db, trace([]), []));

    expect(compact).toEqual({
      schema: 'service-flow/compact-graph@1',
      start: { repo: null, servicePath: null, operation: null,
        operationPath: null, handler: null },
      query: { depth: 25, includeAsync: false, includeDb: false,
        includeExternal: false, dynamicMode: 'strict', maxDynamicCandidates: 5,
        suppliedVariableNames: [], runtimeValuesOmitted: true,
        implementationRepo: null, implementationHints: [] },
      source,
      summary: { completeness: 'complete', fullTraceNodes: 0,
        fullTraceEdges: 0, fullTraceDiagnostics: 0, nodes: 0, edges: 0,
        collapsedEdges: 0, statusCounts: { resolved: 0, terminal: 0,
          inferred: 0, dynamic: 0, ambiguous: 0, unresolved: 0, cycle: 0 },
        projection: { evidence: 'summary-only', syntheticEndpoints: 0,
          omittedUnreferencedFullNodes: 0 } },
      repos: [], files: [],
      nodeColumns: ['id', 'kind', 'label', 'repo', 'file', 'line'], nodes: [],
      edgeColumns: ['id', 'traceOrdinals', 'step', 'type', 'from', 'to',
        'status', 'confidence', 'count', 'details'], edges: [],
      diagnosticColumns: ['fullDiagnosticIndex', 'severity', 'code', 'message',
        'file', 'line', 'details'], diagnostics: [],
    });
    const rendered = renderCompactJson(compact);
    expect(rendered).toBe(`${JSON.stringify(compact)}\n`);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.slice(0, -1)).not.toContain('\n');
  });

  it('fails closed to a blocked, bounded diagnostic without copying raw text', async () => {
    const db = await temporaryDatabase('blocked');
    const sentinel = 'https://private.invalid/path?token=BEARER_SENTINEL';
    const result = trace([], [{
      severity: 'warning', code: 'trace_workspace_ambiguous',
      message: `Do not copy ${sentinel}`, remediation: `Try ${sentinel}`,
      sourceFile: 'src/start.ts', sourceLine: 9,
    }]);
    const compact = projectCompactGraph(projectionInput(db, result, []));
    const rendered = renderCompactJson(compact);

    expect(compact.summary.completeness).toBe('blocked');
    expect(compact.diagnostics[0]).toEqual([
      0, 'warning', 'trace_workspace_ambiguous',
      'The trace workspace is ambiguous.', 0, 9, null,
    ]);
    expect(rendered).not.toContain(sentinel);
    expect(compact.files).toEqual(['src/start.ts']);
  });

  it('keeps authoritative diagnostic name totals after bounding the array', async () => {
    const db = await temporaryDatabase('diagnostic-name-count');
    const missingVariables = Array.from({ length: 20 }, (_, index) => `V${index}`);
    const result = trace([], [{
      severity: 'warning', code: 'trace_runtime_variables_missing',
      message: 'Full diagnostic text is intentionally not projected.',
      missingVariables,
    }]);
    const compact = projectCompactGraph(projectionInput(db, result, []));
    const details = compact.diagnostics[0]?.[6];

    expect(details?.missingVariableNames).toHaveLength(8);
    expect(details?.missingVariableCount).toBe(20);
    expect(details?.shownMissingVariableCount).toBe(8);
    expect(details?.omittedMissingVariableCount).toBe(12);
    expect(details?.omittedHintCount).toBe(19);
  });

  it('aggregates exact decisions while preserving multiplicity and bounded refs', async () => {
    const db = await temporaryDatabase('aggregate');
    const edges = [detailedEdge(0), detailedEdge(1), detailedEdge(2)];
    const sourceEndpoint = target('Orders');
    const common = {
      effectiveResolutionStatus: 'terminal', candidateCount: 11,
      viableCandidateCount: 7, rejectedCandidateCount: 4,
      persistedResolutionStatus: 'unresolved',
      persistedTarget: { kind: 'db_entity', id: 'LegacyItems' },
    } as const;
    const observations = [
      observation(0, sourceEndpoint, target('Items'), {
        decision: common, refs: { graphEdgeIds: [9, 7, 6, 5] },
        site: { repository: 'repo', sourceFile: 'z.ts', sourceLine: 3 },
      }),
      observation(1, sourceEndpoint, target('Items'), {
        decision: common, refs: { graphEdgeIds: [8, 4, 3, 2] },
        site: { repository: 'repo', sourceFile: 'a.ts', sourceLine: 2 },
      }),
      observation(2, sourceEndpoint, target('Items'), {
        decision: { ...common, candidateCount: 12 },
      }),
    ];
    const compact = projectCompactGraph(projectionInput(db, trace(edges), observations));

    expect(compact.edges).toHaveLength(2);
    const aggregate = compact.edges.find((edge) => edge[8] === 2);
    expect(aggregate?.[1]).toEqual([0, 1]);
    expect(aggregate?.[9]?.refs.graphEdgeIds).toEqual({
      values: [2, 3, 4, 5, 6], total: 8, shown: 5, omitted: 3,
    });
    expect(aggregate?.[9]?.decision.persistedTarget).toBe('db_entity:LegacyItems');
    expect(compact.summary.collapsedEdges).toBe(1);
    expect(compact.summary.statusCounts.terminal).toBe(3);
    expect(compact.edges.reduce((sum, edge) => sum + edge[8], 0)).toBe(3);
  });

  it('uses code-point ordering and preserves colliding labels as distinct nodes', async () => {
    const db = await temporaryDatabase('codepoint');
    const workspaceId = insertWorkspace(db);
    const bmpRepo = insertRepository(db, workspaceId, '\uE000');
    const supplementaryRepo = insertRepository(db, workspaceId, '\u{10000}');
    const first = insertSymbol(db, bmpRepo, 'Handler.run');
    const second = insertSymbol(db, supplementaryRepo, 'Handler.run');
    const result = trace([detailedEdge(0), detailedEdge(1)]);
    const observations = [
      observation(0, { kind: 'symbol', symbolId: second }, target('Second')),
      observation(1, { kind: 'symbol', symbolId: first }, target('First')),
    ];
    const compact = projectCompactGraph(projectionInput(db, result, observations));

    expect(compact.repos).toEqual(['\uE000', '\u{10000}']);
    expect(compact.nodes.filter((node) => node[2] === 'Handler.run')).toHaveLength(2);
    expect(new Set(compact.nodes.map((node) => node[0])).size).toBe(compact.nodes.length);
  });

  it('never merges identical semantic labels across workspaces', async () => {
    const db = await temporaryDatabase('workspaces');
    const firstWorkspace = insertWorkspace(db, 'first');
    const secondWorkspace = insertWorkspace(db, 'second');
    const edges = [detailedEdge(0), detailedEdge(1)];
    const observations = [firstWorkspace, secondWorkspace].map((workspaceId, ordinal) =>
      observation(ordinal, {
        kind: 'event', workspaceId, eventName: 'OrderPlaced',
      }, {
        kind: 'target', workspaceId, targetKind: 'db_entity', targetId: 'Orders',
      }));
    const compact = projectCompactGraph(projectionInput(db, trace(edges), observations));

    expect(compact.nodes.filter((node) => node[2] === 'OrderPlaced')).toHaveLength(2);
    expect(compact.nodes.filter((node) => node[2] === 'Orders')).toHaveLength(2);
    expect(compact.nodes).toHaveLength(4);
    expect(compact.edges).toHaveLength(2);
  });

  it('omits persisted resolution when handler and symbol identities are equivalent', async () => {
    const db = await temporaryDatabase('equivalent-handler');
    const workspaceId = insertWorkspace(db);
    const repoId = insertRepository(db, workspaceId, 'worker');
    const symbolId = insertSymbol(db, repoId, 'Handler.run');
    const handlerMethodId = insertHandlerMethod(db, repoId, symbolId);
    const item = observation(0, {
      kind: 'event', workspaceId, eventName: 'OrderPlaced',
    }, { kind: 'symbol', symbolId }, {
      status: 'resolved',
      decision: {
        effectiveResolutionStatus: 'resolved',
        persistedResolutionStatus: 'resolved',
        persistedTarget: { kind: 'handler_method', id: String(handlerMethodId) },
      },
    });
    const compact = projectCompactGraph(projectionInput(db, trace([detailedEdge(0)]), [item]));
    const decision = compact.edges[0]?.[9]?.decision;

    expect(decision?.effectiveTarget).toContain('symbol:worker:src/handler.ts');
    expect(decision).not.toHaveProperty('persistedResolutionStatus');
    expect(decision).not.toHaveProperty('persistedTarget');
  });

  it('omits raw evidence, supplied values, unsafe targets, and diagnostic hints', async () => {
    const db = await temporaryDatabase('privacy');
    const privateUrl = 'https://private.invalid/hook?token=TOP_SECRET';
    const destination = 'PRIVATE_DESTINATION_SENTINEL';
    const bearer = 'Bearer eyJhbGciOiJub25lIn0.SENTINEL';
    const result = trace([detailedEdge(0, {
      privateUrl, destination, authorization: bearer,
      rawExpression: `send('${privateUrl}')`, payload: { secret: destination },
      dynamicTargetCandidates: [{ privateUrl }],
    })], [{ severity: 'info', code: 'unknown_shape',
      message: `${privateUrl} ${bearer}`, remediation: destination }]);
    const item = observation(0, target('Orders'), {
      kind: 'target', workspaceId: 1,
      targetKind: 'external_endpoint', targetId: 'endpoint:deadbeef',
    }, {
      decision: { effectiveResolutionStatus: 'terminal',
        effectiveTarget: { kind: 'external_endpoint', id: privateUrl },
        persistedResolutionStatus: 'unresolved',
        persistedTarget: { kind: 'external_endpoint', id: privateUrl },
        missingVariableNames: ['SAFE_NAME', privateUrl], missingVariableCount: 9 },
    });
    const input = projectionInput(db, result, [item]);
    input.options.vars = { SAFE_NAME: destination };
    const rendered = renderCompactJson(projectCompactGraph(input));

    expect(rendered).not.toContain(privateUrl);
    expect(rendered).not.toContain(destination);
    expect(rendered).not.toContain(bearer);
    expect(rendered).not.toContain('dynamicTargetCandidates');
    expect(rendered).not.toContain('rawExpression');
    expect(rendered).toContain('SAFE_NAME');
    expect(rendered).toContain('external_endpoint:endpoint:deadbeef');
  });

  it('is byte deterministic under shuffled equivalent observation input', async () => {
    const db = await temporaryDatabase('shuffle');
    const edges = [detailedEdge(0), detailedEdge(1), detailedEdge(2)];
    const observations = [
      observation(0, target('A'), target('B'), { refs: { symbolIds: [3, 1] } }),
      observation(1, target('A'), target('B'), { refs: { symbolIds: [2] } }),
      observation(2, target('B'), target('C'), { status: 'unresolved' }),
    ];
    const input = projectionInput(db, trace(edges), observations);
    const first = renderCompactJson(projectCompactGraph(input));
    const second = renderCompactJson(projectCompactGraph({
      ...input, observations: [observations[2], observations[0], observations[1]],
    }));

    expect(second).toBe(first);
  });

  it('rejects a missing, duplicated, or non-partitioning trace ordinal', async () => {
    const db = await temporaryDatabase('invariant');
    const result = trace([detailedEdge(0), detailedEdge(1)]);
    const duplicated = [
      observation(0, target('A'), target('B')),
      observation(0, target('B'), target('C')),
    ];

    expect(() => projectCompactGraph(projectionInput(db, result, duplicated)))
      .toThrow('compact_graph_invariant:trace_ordinal_partition_invalid');
    expect(() => projectCompactGraph(projectionInput(db, result, duplicated.slice(0, 1))))
      .toThrow('compact_graph_invariant:observation_count_mismatch');
});
