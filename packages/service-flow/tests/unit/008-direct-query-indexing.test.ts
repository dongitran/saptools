import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { parseOutboundCalls } from '../../src/parsers/outbound-call-parser.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOwnedCallRow(value: unknown): value is {
  callType: string;
  queryEntity: string | null;
  sourceSymbolId: number | null;
  qualifiedName: string | null;
  sourceFile: string;
  sourceLine: number;
} {
  return isRecord(value)
    && typeof value.callType === 'string'
    && (typeof value.queryEntity === 'string' || value.queryEntity === null)
    && (typeof value.sourceSymbolId === 'number' || value.sourceSymbolId === null)
    && (typeof value.qualifiedName === 'string' || value.qualifiedName === null)
    && typeof value.sourceFile === 'string'
    && typeof value.sourceLine === 'number';
}

function isDatabaseEdgeRow(value: unknown): value is {
  edgeType: string;
  toKind: string;
  toId: string;
} {
  return isRecord(value)
    && typeof value.edgeType === 'string'
    && typeof value.toKind === 'string'
    && typeof value.toId === 'string';
}

async function callsFor(source: string): Promise<Awaited<ReturnType<typeof parseOutboundCalls>>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-direct-query-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'handler.ts'), source);
  return parseOutboundCalls(root, 'src/handler.ts');
}

async function createDirectQueryWorkspace(root: string): Promise<void> {
  await writeFixtureFile(root, 'data-app/.git-fixture');
  await writeFixtureFile(
    root,
    'data-app/package.json',
    JSON.stringify({ name: '@neutral/data-app', version: '1.0.0' }),
  );
  await writeFixtureFile(
    root,
    'data-app/srv/service.cds',
    'service DataService { action runDirect(); }',
  );
  await writeFixtureFile(
    root,
    'data-app/srv/DirectQueryHandler.ts',
    `import { Action, Handler, OnUpdate } from 'cds-routing-handlers';
@Handler()
export class DirectQueryHandler {
  @OnUpdate()
  async refreshRows(): Promise<void> {
    await SELECT.from(LifecycleRows).where({ ID: 1 });
  }

  @Action('runDirect')
  async runDirect(): Promise<void> {
    await UPDATE.entity(OperationRows).set({ status: 'ready' });
  }
}
`,
  );
  await writeFixtureFile(
    root,
    'data-app/srv/server.ts',
    `import { createCombinedHandler } from 'cds-routing-handlers';
import { DirectQueryHandler } from './DirectQueryHandler.js';
createCombinedHandler({ handler: [DirectQueryHandler] });
`,
  );
}

describe('direct CAP query-builder outbound facts', () => {
  it('indexes supported direct static query builders as one audited fact each', async () => {
    const calls = await callsFor(`async function run(entityName: string): Promise<void> {
  await SELECT.from(ReadRows).columns('ID').where({ ID: 1 }).orderBy('ID').limit(1);
  await SELECT.one.from(OneRows).where({ ID: 1 });
  await SELECT.one(SingleRows).columns('ID');
  await INSERT.into(InsertRows).entries({ ID: 1 });
  await UPSERT.into(UpsertRows).entries({ ID: 1 });
  await UPDATE.entity(UpdateRows).set({ status: 'ready' });
  await UPDATE(UpdateFormRows).with({ status: 'ready' });
  await DELETE.from(this.model['DeleteRows']).where({ ID: 1 });
  await (SELECT.from(ParenthesizedRows).limit(1));
  await (SELECT.from(AssertedRows).where({ ID: 1 }) as unknown);
  await SELECT.from(this.model[entityName]).where({ ID: 1 });
}`);

    const databaseCalls = calls.filter((call) => call.callType === 'local_db_query');
    expect(databaseCalls.map((call) => call.queryEntity)).toEqual([
      'ReadRows',
      'OneRows',
      'SingleRows',
      'InsertRows',
      'UpsertRows',
      'UpdateRows',
      'UpdateFormRows',
      'DeleteRows',
      'ParenthesizedRows',
      'AssertedRows',
      undefined,
    ]);
    expect(databaseCalls.map((call) => call.sourceLine)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(databaseCalls.filter((call) => call.queryEntity === 'ReadRows')).toHaveLength(1);
    expect(databaseCalls.every((call) => call.confidence === 0.9 || call.confidence === 0.55)).toBe(true);
    expect(databaseCalls.at(-1)?.unresolvedReason).toBe('dynamic_entity_expression');
    for (const call of databaseCalls) {
      const evidence = call.evidence ?? {};
      expect(evidence.classifier).toBe('cap_query_builder_direct');
      expect(evidence.queryDispatch).toBe('direct_query_builder');
      expect(typeof evidence.startOffset).toBe('number');
      expect(typeof evidence.endOffset).toBe('number');
      expect(typeof evidence.queryRootStartOffset).toBe('number');
      expect(typeof evidence.queryStatementStartOffset).toBe('number');
      expect(typeof evidence.queryStatementEndOffset).toBe('number');
    }
  });

  it('keeps one wrapper fact and never promotes nested query builders a second time', async () => {
    const calls = await callsFor(`async function run(): Promise<void> {
  await cds.run(SELECT.from(WrappedRows).where({ ID: 1 }));
}`);

    const databaseCalls = calls.filter((call) => call.callType === 'local_db_query');
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0]?.queryEntity).toBe('WrappedRows');
    expect(databaseCalls[0]?.evidence).toMatchObject({
      classifier: 'cap_query_run_wrapper',
      queryDispatch: 'cds_run_wrapper',
    });
  });

  it('rejects member-name lookalikes while retaining a conservative dynamic direct query', async () => {
    const calls = await callsFor(`async function run(entityName: string): Promise<void> {
  await ordinary.from(LookalikeRows).where({ ID: 1 });
  await utility.set({ status: 'ready' });
  await factory().delete(LookalikeRows);
  await SELECT.from(this.model[entityName]).where({ ID: 1 });
}`);

    const databaseCalls = calls.filter((call) => call.callType === 'local_db_query');
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0]).toMatchObject({
      queryEntity: undefined,
      confidence: 0.55,
      unresolvedReason: 'dynamic_entity_expression',
    });
  });
});

describe('direct CAP query-builder indexing and trace integration', () => {
  it('owns direct database calls by method, links them once, and respects include-db', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-direct-query-workspace-'));
    await createDirectQueryWorkspace(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const rawCalls: unknown[] = db.prepare(`SELECT c.call_type callType,c.query_entity queryEntity,
      c.source_symbol_id sourceSymbolId,s.qualified_name qualifiedName,
      c.source_file sourceFile,c.source_line sourceLine
      FROM outbound_calls c LEFT JOIN symbols s ON s.id=c.source_symbol_id
      WHERE c.call_type='local_db_query' ORDER BY c.source_line`).all();
    const calls = rawCalls.filter(isOwnedCallRow);
    expect(calls).toEqual([
      expect.objectContaining({ queryEntity: 'LifecycleRows', qualifiedName: 'DirectQueryHandler.refreshRows' }),
      expect.objectContaining({ queryEntity: 'OperationRows', qualifiedName: 'DirectQueryHandler.runDirect' }),
    ]);
    expect(calls.every((call) => call.sourceSymbolId !== null)).toBe(true);
    expect(calls.map((call) => call.sourceFile)).toEqual([
      'srv/DirectQueryHandler.ts',
      'srv/DirectQueryHandler.ts',
    ]);

    const rawEdges: unknown[] = db.prepare(`SELECT e.edge_type edgeType,e.to_kind toKind,e.to_id toId
      FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER)
      WHERE e.from_kind='call' AND c.call_type='local_db_query' ORDER BY e.id`).all();
    const databaseEdges = rawEdges.filter(isDatabaseEdgeRow);
    expect(databaseEdges).toEqual([
      { edgeType: 'HANDLER_RUNS_DB_QUERY', toKind: 'db_entity', toId: 'LifecycleRows' },
      { edgeType: 'HANDLER_RUNS_DB_QUERY', toKind: 'db_entity', toId: 'OperationRows' },
    ]);

    const withoutDatabase = trace(
      db,
      { repo: 'data-app', handler: 'DirectQueryHandler' },
      { workspaceId, depth: 5 },
    );
    expect(withoutDatabase.edges.some((edge) => edge.type === 'local_db_query')).toBe(false);

    const withDatabase = trace(
      db,
      { repo: 'data-app', handler: 'DirectQueryHandler' },
      { workspaceId, depth: 5, includeDb: true },
    );
    expect(withDatabase.edges.filter((edge) => edge.type === 'local_db_query').map((edge) => edge.to)).toEqual([
      'Entity: LifecycleRows',
      'Entity: OperationRows',
    ]);
    expect(renderTraceTable(withDatabase)).toContain('Entity: LifecycleRows');
    expect(renderTraceJson(withDatabase)).toContain('"to": "Entity: OperationRows"');
    expect(renderMermaid(withDatabase)).toContain('Entity: LifecycleRows');

    const firstCallCount = calls.length;
    const firstEdgeCount = databaseEdges.length;
    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    const secondCallCount = Number(db.prepare("SELECT COUNT(*) count FROM outbound_calls WHERE call_type='local_db_query'").get()?.count ?? 0);
    const secondEdgeCount = Number(db.prepare("SELECT COUNT(*) count FROM graph_edges WHERE edge_type='HANDLER_RUNS_DB_QUERY'").get()?.count ?? 0);
    expect({ secondCallCount, secondEdgeCount }).toEqual({
      secondCallCount: firstCallCount,
      secondEdgeCount: firstEdgeCount,
    });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
