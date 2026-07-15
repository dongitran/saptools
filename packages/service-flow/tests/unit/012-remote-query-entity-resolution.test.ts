import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import {
  classifyOutboundCallsInSource,
  type ClassifiedOutboundCall,
} from '../../src/parsers/outbound-call-parser.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type RemoteQueryFact = ClassifiedOutboundCall['fact'];

interface RemoteQueryState {
  calls: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function classifiedCalls(sourceText: string): ClassifiedOutboundCall[] {
  const source = ts.createSourceFile(
    'handler.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  return classifyOutboundCallsInSource(source, 'handler.ts');
}

function remoteQueryCalls(sourceText: string): RemoteQueryFact[] {
  return classifiedCalls(sourceText)
    .map((call) => call.fact)
    .filter((fact) => fact.callType === 'remote_query');
}

function singleRemoteQuery(sourceText: string): RemoteQueryFact {
  const calls = classifiedCalls(sourceText);
  const remote = calls.filter((call) => call.fact.callType === 'remote_query');
  expect(remote).toHaveLength(1);
  expect(calls.filter((call) => call.fact.callType === 'local_db_query')).toHaveLength(0);
  const [call] = remote;
  if (!call) throw new Error('Expected one remote query call');
  expect(call.fact.evidence).toMatchObject({
    classifier: 'service_client_send_object',
  });
  return call.fact;
}

function expectDynamicRemoteQuery(
  sourceText: string,
  reason: string,
): void {
  expect(singleRemoteQuery(sourceText)).toMatchObject({
    callType: 'remote_query',
    queryEntity: undefined,
    confidence: 0.8,
    unresolvedReason: reason,
  });
}

function expectStaticRemoteQuery(sourceText: string, entity: string): void {
  expect(singleRemoteQuery(sourceText)).toMatchObject({
    callType: 'remote_query',
    queryEntity: entity,
    confidence: 0.8,
    unresolvedReason: undefined,
  });
}

function records(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.filter((row): row is Record<string, unknown> =>
    typeof row === 'object' && row !== null && !Array.isArray(row));
}

const remoteHandlerSource = `import { RemoteRows } from '#cds-models/neutral';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class RemoteQueryHandler {
  @Action('inspectRemote')
  async inspectRemote(tableRef: unknown): Promise<void> {
    const remote = await cds.connect.to('RemoteCatalog', { path: '/RemoteCatalog' });
    await remote.send({ query: SELECT.from(tableRef) });
    await remote.send({ query: SELECT.from(RemoteRows) });
  }
}`;

async function createRemoteQueryWorkspace(root: string): Promise<void> {
  const files: Array<[string, string]> = [
    ['remote-app/.git-fixture', ''],
    ['remote-app/package.json', JSON.stringify({
      name: '@neutral/remote-app', version: '1.0.0',
    })],
    ['remote-app/srv/service.cds',
      'service RemoteQueryService { action inspectRemote(); }'],
    ['remote-app/srv/RemoteQueryHandler.ts', remoteHandlerSource],
    ['remote-app/srv/server.ts', `import { createCombinedHandler } from 'cds-routing-handlers';
import { RemoteQueryHandler } from './RemoteQueryHandler.js';
createCombinedHandler({ handler: [RemoteQueryHandler] });`],
  ];
  await Promise.all(files.map(([relative, content]) =>
    writeFixtureFile(root, relative, content)));
}

function remoteQueryState(db: Db): RemoteQueryState {
  const calls = records(db.prepare(`SELECT c.source_line sourceLine,
    c.query_entity queryEntity,c.confidence,c.unresolved_reason unresolvedReason,
    c.source_symbol_id sourceSymbolId,s.qualified_name qualifiedName,
    json_valid(c.evidence_json) evidenceValid,length(c.evidence_json) evidenceLength
    FROM outbound_calls c LEFT JOIN symbols s ON s.id=c.source_symbol_id
    WHERE c.call_type='remote_query' ORDER BY c.source_line`).all());
  const edges = records(db.prepare(`SELECT c.source_line sourceLine,
    e.edge_type edgeType,e.status,e.to_kind toKind,e.to_id toId,e.confidence,
    e.unresolved_reason unresolvedReason,
    json_extract(e.evidence_json,'$.queryTargetKind') queryTargetKind,
    json_extract(e.evidence_json,'$.parserWarning.code') parserWarningCode,
    json_extract(e.evidence_json,'$.parserWarning.message') parserWarningMessage,
    json_extract(e.evidence_json,'$.analysisCompleteness') analysisCompleteness,
    json_valid(e.evidence_json) evidenceValid,length(e.evidence_json) evidenceLength
    FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER)
    WHERE e.from_kind='call' AND c.call_type='remote_query'
    ORDER BY c.source_line`).all());
  return { calls, edges };
}

function expectBoundedEvidence(rows: Array<Record<string, unknown>>): void {
  expect(rows.every((row) => row.evidenceValid === 1
    && typeof row.evidenceLength === 'number'
    && row.evidenceLength < 8_192)).toBe(true);
}

function expectRemoteQueryState(state: RemoteQueryState): void {
  expect(state.calls).toHaveLength(2);
  expect(state.calls.map((row) => row.queryEntity)).toEqual([null, 'RemoteRows']);
  expect(state.calls.map((row) => row.confidence)).toEqual([0.8, 0.8]);
  expect(state.calls.map((row) => row.unresolvedReason)).toEqual([
    'dynamic_entity_expression', null,
  ]);
  expect(state.calls.every((row) => row.sourceSymbolId !== null
    && row.qualifiedName === 'RemoteQueryHandler.inspectRemote')).toBe(true);
  expect(state.edges.map((row) => [row.edgeType, row.status])).toEqual([
    ['HANDLER_RUNS_REMOTE_QUERY', 'terminal'],
    ['HANDLER_RUNS_REMOTE_QUERY', 'terminal'],
  ]);
  expect(state.edges[0]).toMatchObject({
    toKind: 'remote_query', toId: 'unknown', confidence: 0.8,
    unresolvedReason: null, queryTargetKind: 'remote_query_unknown',
    parserWarningCode: 'parser_warning',
    parserWarningMessage: 'dynamic_entity_expression',
    analysisCompleteness: 'partial',
  });
  expect(state.edges[1]).toMatchObject({
    toKind: 'remote_entity', confidence: 0.8, unresolvedReason: null,
    queryTargetKind: 'remote_entity', parserWarningCode: null,
    analysisCompleteness: 'complete',
  });
  expect(String(state.edges[1]?.toId)).toMatch(/RemoteRows$/);
  expectBoundedEvidence(state.calls);
  expectBoundedEvidence(state.edges);
}

async function verifyLinkContract(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-remote-query-'));
  await createRemoteQueryWorkspace(root);
  const { db, workspaceId } = await prepareWorkspace(root);
  try {
    linkWorkspace(db, workspaceId);
    const first = remoteQueryState(db);
    expectRemoteQueryState(first);
    linkWorkspace(db, workspaceId);
    expect(remoteQueryState(db)).toEqual(first);
    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    expect(remoteQueryState(db)).toEqual(first);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
}

describe('remote query lexical entity resolution', () => {
  it('keeps a parameter builder argument dynamic with a stable warning', () => {
    expectDynamicRemoteQuery(`async function run(tableRef: unknown): Promise<void> {
      await srv.send({ query: SELECT.from(tableRef) });
    }`, 'dynamic_entity_expression');
  });

  it('keeps runtime const, destructured, and reassigned targets dynamic', () => {
    const calls = remoteQueryCalls(`import { StableRows } from '#cds-models/neutral';
      async function run(prefix: string, key: string): Promise<void> {
        const runtimeRows = svc.entities(prefix)[key];
        const { stagedRows } = await loadRows();
        let reassignedRows = StableRows;
        reassignedRows = pickRows();
        await srv.send({ query: DELETE.from(runtimeRows) });
        await srv.send({ query: INSERT.into(stagedRows).entries([]) });
        await srv.send({ query: UPDATE.entity(reassignedRows) });
      }`);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.queryEntity)).toEqual([undefined, undefined, undefined]);
    expect(calls.map((call) => call.unresolvedReason)).toEqual(
      Array<string>(3).fill('dynamic_entity_expression'),
    );
    expect(calls.map((call) => call.confidence)).toEqual([0.8, 0.8, 0.8]);
  });
});

describe('remote query static entity compatibility', () => {
  it('preserves imported and model-destructured entities', () => {
    const calls = remoteQueryCalls(`import { Foo } from '#cds-models/neutral';
      const { Bar } = require('#cds-models/legacy');
      async function run(): Promise<void> {
        await srv.send({ query: SELECT.from(Foo) });
        await srv.send({ query: SELECT.one.from(Bar) });
      }`);
    expect(calls.map((call) => call.queryEntity)).toEqual(['Foo', 'Bar']);
    expect(calls.map((call) => call.unresolvedReason)).toEqual([undefined, undefined]);
  });

  it('fails closed when a parameter shadows a model import', () => {
    expectDynamicRemoteQuery(`import { Foo } from '#cds-models/neutral';
      const run = async (Foo: unknown): Promise<void> => {
        await srv.send({ query: SELECT.from(Foo) });
      };`, 'dynamic_entity_expression');
  });

  it('applies the same rules to INSERT and UPDATE builders', () => {
    const calls = remoteQueryCalls(`import { Foo } from '#cds-models/neutral';
      async function run(parameterRows: unknown): Promise<void> {
        await srv.send({ query: INSERT.into(Foo).entries([]) });
        await srv.send({ query: UPDATE.entity(parameterRows) });
      }`);
    expect(calls).toEqual([
      expect.objectContaining({ queryEntity: 'Foo', unresolvedReason: undefined }),
      expect.objectContaining({
        queryEntity: undefined, unresolvedReason: 'dynamic_entity_expression',
      }),
    ]);
  });
});

describe('remote query aliases and wrappers', () => {
  it('resolves a top-level const query alias from the real initializer map', () => {
    expectStaticRemoteQuery(`import { Foo } from '#cds-models/neutral';
      const query = SELECT.from(Foo);
      async function run(): Promise<void> {
        await srv.send({ query });
      }`, 'Foo');
  });

  it('warns for function-local and parameter shorthand query values', () => {
    const calls = remoteQueryCalls(`import { Foo } from '#cds-models/neutral';
      async function localAlias(): Promise<void> {
        const query = SELECT.from(Foo);
        await srv.send({ query });
      }
      async function parameterAlias(query: unknown): Promise<void> {
        await srv.send({ query });
      }`);
    expect(calls.map((call) => call.queryEntity)).toEqual([undefined, undefined]);
    expect(calls.map((call) => call.unresolvedReason)).toEqual([
      'query_variable_without_static_initializer',
      'query_variable_without_static_initializer',
    ]);
  });

  it('resolves fluent and cds.run-wrapped query builders', () => {
    const calls = remoteQueryCalls(`import { Foo } from '#cds-models/neutral';
      async function run(): Promise<void> {
        await srv.send({ query: SELECT.distinct.from(Foo).columns('ID') });
        await srv.send({ query: cds.run(SELECT.from(Foo).where({ active: true })) });
      }`);
    expect(calls.map((call) => call.queryEntity)).toEqual(['Foo', 'Foo']);
    expect(calls.map((call) => call.unresolvedReason)).toEqual([undefined, undefined]);
  });
});

describe('remote query diagnostic and path compatibility', () => {
  it('preserves static strings and CAP entity member forms', () => {
    const calls = remoteQueryCalls(`async function run(): Promise<void> {
      await srv.send({ query: SELECT.from('Namespace.StringRows') });
      await srv.send({ query: SELECT.from(cds.entities.DottedRows) });
      await srv.send({ query: SELECT.from(cds.entities['BracketRows']) });
    }`);
    expect(calls.map((call) => call.queryEntity)).toEqual([
      'Namespace.StringRows', 'DottedRows', 'BracketRows',
    ]);
  });

  it('diagnoses raw CQL and dynamic member query expressions', () => {
    const calls = remoteQueryCalls("async function run(): Promise<void> {\n"
      + "  await srv.send({ query: `SELECT from Books` });\n"
      + "  await srv.send({ query: this.buildQuery });\n"
      + "}");
    expect(calls.map((call) => call.queryEntity)).toEqual([undefined, undefined]);
    expect(calls.map((call) => call.unresolvedReason)).toEqual([
      'raw_sql_or_cql_expression', 'dynamic_entity_expression',
    ]);
  });

  it('preserves the non-query OData entity path branch', () => {
    expectStaticRemoteQuery(`async function run(): Promise<void> {
      await srv.send({ method: 'GET', path: '/RemoteRows?$select=ID' });
    }`, 'RemoteRows');
  });
});

describe('remote query link contract', () => {
  it('links dynamic entities to unknown and static entities by name deterministically', async () => {
    await verifyLinkContract();
  });
});
