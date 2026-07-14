import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { parseOutboundCalls } from '../../src/parsers/outbound-call-parser.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type OutboundCall = Awaited<ReturnType<typeof parseOutboundCalls>>[number];

interface QueryState {
  calls: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  traceTargets: string[];
  rendered: string;
}

const dynamicBindingSource = `import { ImportedRows } from '#cds-models/neutral';
class QueryWorker {
  async run(
    parameterRows: unknown,
    { parameterItems }: { parameterItems: unknown },
    config: { tableName: string },
  ): Promise<void> {
    let mutableRows = ImportedRows;
    const runtimeRows = await loadRows();
    const dynamicKeyRows = db.entities('neutral')[parameterRows];
    await SELECT.from(parameterRows);
    await SELECT.from(mutableRows);
    await SELECT.from(runtimeRows);
    await SELECT.from(dynamicKeyRows);
    await SELECT.from(parameterItems);
    await SELECT.from(this.entityField);
    await SELECT.from(config.tableName);
    await cds.run(SELECT.from(parameterRows));
  }
}`;

const staticBindingSource = `import { ImportedRows } from '#cds-models/neutral';
async function run(): Promise<void> {
  const importedAlias = ImportedRows;
  const nestedAlias = importedAlias;
  const dottedAlias = cds.entities.AliasRows;
  const assertedAlias = (ImportedRows as unknown);
  await SELECT.from(ImportedRows);
  await SELECT.from(importedAlias);
  await SELECT.from(nestedAlias);
  await SELECT.from(dottedAlias);
  await SELECT.from(assertedAlias);
  await SELECT.from('Namespace.StringRows');
  await SELECT.from(cds.entities.DottedRows);
  await SELECT.from(cds.entities['BracketRows']);
  await SELECT.from(this.model['LegacyLiteralRows']);
}`;

const genuineDestructuringSource = `import * as GeneratedModels from '#cds-models/generated';
import LegacyModels = require('#cds-models/legacy');
async function run(): Promise<void> {
  const { EntityRows: EntityAlias } = cds.entities;
  let { MutableEntityRows } = service.entities;
  const { CalledEntityRows } = cds.entities('neutral');
  const [ArrayEntityRows] = service.entities;
  const { RequiredRows } = require('#cds-models/required');
  const { NamespaceRows } = GeneratedModels;
  const { LegacyRows } = LegacyModels;
  await SELECT.from(EntityAlias);
  await SELECT.from(MutableEntityRows);
  await SELECT.from(CalledEntityRows);
  await SELECT.from(ArrayEntityRows);
  await SELECT.from(RequiredRows);
  await SELECT.from(NamespaceRows);
  await SELECT.from(LegacyRows);
}`;

const runtimeDestructuringSource = `import * as RuntimeNamespace from '@neutral/runtime';
import type * as TypeModels from '#cds-models/types';
async function run({ parameterItems }: { parameterItems: unknown }): Promise<void> {
  const { RuntimeRequiredRows } = require('@neutral/runtime');
  const { RuntimeNamespaceRows } = RuntimeNamespace;
  const { RuntimeRows } = await loadRows();
  const { TypeOnlyRows } = TypeModels;
  const { FallbackRows = parameterItems } = cds.entities;
  let { ReassignedRows } = service.entities;
  ReassignedRows = parameterItems;
  await SELECT.from(parameterItems);
  await SELECT.from(RuntimeRequiredRows);
  await SELECT.from(RuntimeNamespaceRows);
  await SELECT.from(RuntimeRows);
  await SELECT.from(TypeOnlyRows);
  await SELECT.from(FallbackRows);
  await SELECT.from(ReassignedRows);
}
async function defaultedParameter({ DefaultRows } = cds.entities): Promise<void> {
  await SELECT.from(DefaultRows);
}`;

const lexicalShadowSource = `import { SharedRows } from '#cds-models/shared';
import * as GeneratedModels from '#cds-models/generated';
import { shim as require } from '@neutral/runtime';
const { TrustedRows } = cds.entities;
const sharedQuery = SELECT.from(GlobalQueryRows);
const stableQuery = SELECT.from(StableQueryRows);
async function shadowImport(SharedRows: unknown): Promise<void> {
  await SELECT.from(SharedRows);
}
async function shadowTrusted(TrustedRows: unknown): Promise<void> {
  await SELECT.from(TrustedRows);
}
async function shadowNamespace(GeneratedModels: unknown): Promise<void> {
  const { NamespaceRows } = GeneratedModels;
  await SELECT.from(NamespaceRows);
}
async function shadowQueryAlias(sharedQuery: unknown): Promise<void> {
  await cds.run(sharedQuery);
}
async function forwardAliasCycle(): Promise<void> {
  const FirstRows = SecondRows;
  const SecondRows = FirstRows;
  await SELECT.from(FirstRows);
}
async function functionNamespaceShadow(): Promise<void> {
  function GeneratedModels(): void {}
  const { FunctionShadowRows } = GeneratedModels;
  await SELECT.from(FunctionShadowRows);
}
async function importedRequireShadow(): Promise<void> {
  const { ImportedRequireRows } = require('#cds-models/import-shadow');
  await SELECT.from(ImportedRequireRows);
}
async function innerStaticAlias(): Promise<void> {
  const { SharedRows } = await loadRows();
  {
    const SharedRows = ImportedStaticRows;
    await SELECT.from(SharedRows);
  }
}
async function useStableQuery(): Promise<void> {
  await cds.run(stableQuery);
}`;

const advancedShadowSource = `import * as GeneratedModels from '#cds-models/generated';
const EntityRows = ImportedRows;
const { ItemRows } = cds.entities;
const sharedQuery = SELECT.from(GlobalQueryRows);
async function destructuredQueryShadow({ sharedQuery }: { sharedQuery: unknown }): Promise<void> {
  await cds.run(sharedQuery);
}
async function functionQueryShadow(): Promise<void> {
  function sharedQuery(): void {}
  await cds.run(sharedQuery);
}
async function classEntityShadow(): Promise<void> {
  class EntityRows {}
  await SELECT.from(EntityRows);
}
async function functionEntityShadow(): Promise<void> {
  function ItemRows(): void {}
  await SELECT.from(ItemRows);
}
async function destructuringWrites(runtime: unknown): Promise<void> {
  let { ReassignedRows } = cds.entities;
  ({ ReassignedRows } = runtime);
  await SELECT.from(ReassignedRows);
  let [ArrayRows] = service.entities;
  [ArrayRows] = runtime;
  await SELECT.from(ArrayRows);
}
const namespaceWorker = async function GeneratedModels(): Promise<void> {
  const { NamespaceRows } = GeneratedModels;
  await SELECT.from(NamespaceRows);
};
const requireWorker = async function require(): Promise<void> {
  const { RequiredRows } = require('#cds-models/generated');
  await SELECT.from(RequiredRows);
};`;

const aliasDepthSource = `import { ImportedRows } from '#cds-models/neutral';
async function run(): Promise<void> {
  const One = ImportedRows;
  const Two = One;
  const Three = Two;
  const Four = Three;
  const Five = Four;
  await SELECT.from(Four);
  await SELECT.from(Five);
}`;

const distinctSource = `async function run(): Promise<void> {
  await SELECT.distinct.from(DistinctRows).columns('ID');
  await SELECT.distinct.one.from(DistinctOneRows).where({ active: true });
  await cds.run(SELECT.distinct.from(WrappedDistinctRows));
  await cds.run(SELECT.distinct.one.from(WrappedDistinctOneRows));
}`;

const remoteThisSource = `async function run(): Promise<void> {
  const remote = await cds.connect.to('remote-service');
  await remote.send({ query: SELECT.from(this.entityField) });
}`;

const fixtureHandlerSource = `import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class QueryEntityHandler {
  @Action('inspectEntities')
  async inspectEntities(runtimeRows: unknown): Promise<void> {
    const { TrustedRows: TrustedAlias } = cds.entities;
    const { stagedRows } = await loadRows();
    await SELECT.from(TrustedAlias);
    await SELECT.from(runtimeRows);
    await INSERT.into(stagedRows);
    await SELECT.distinct.from(DistinctRows).columns('ID');
    await cds.run(SELECT.distinct.one.from(WrappedDistinctRows));
  }
}`;

async function databaseCallsFor(source: string): Promise<OutboundCall[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-query-entity-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'handler.ts'), source);
  const calls = await parseOutboundCalls(root, 'src/handler.ts');
  return calls.filter((call) => call.callType === 'local_db_query');
}

function expectResolvedEntities(calls: OutboundCall[], entities: string[]): void {
  expect(calls.map((call) => call.queryEntity)).toEqual(entities);
  expect(calls.every((call) => call.callType === 'local_db_query'
    && call.confidence === 0.9
    && call.unresolvedReason === undefined)).toBe(true);
}

function expectDynamicEntities(
  calls: OutboundCall[],
  reasons = Array(calls.length).fill('dynamic_entity_expression'),
): void {
  expect(calls.map((call) => call.queryEntity)).toEqual(Array(calls.length).fill(undefined));
  expect(calls.map((call) => call.confidence)).toEqual(Array(calls.length).fill(0.55));
  expect(calls.map((call) => call.unresolvedReason)).toEqual(reasons);
}

async function createQueryEntityWorkspace(root: string): Promise<void> {
  const files: Array<[string, string]> = [
    ['entity-app/.git-fixture', ''],
    ['entity-app/package.json', JSON.stringify({ name: '@neutral/entity-app', version: '1.0.0' })],
    ['entity-app/srv/service.cds', 'service EntityService { action inspectEntities(); }'],
    ['entity-app/srv/QueryEntityHandler.ts', fixtureHandlerSource],
    ['entity-app/srv/server.ts', `import { createCombinedHandler } from 'cds-routing-handlers';
import { QueryEntityHandler } from './QueryEntityHandler.js';
createCombinedHandler({ handler: [QueryEntityHandler] });`],
  ];
  await Promise.all(files.map(([relative, content]) =>
    writeFixtureFile(root, relative, content)));
}

function queryState(db: Db, workspaceId: number): QueryState {
  const calls = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,
    c.query_entity queryEntity,c.confidence,c.unresolved_reason unresolvedReason,
    json_extract(c.evidence_json,'$.queryRoot') queryRoot,
    json_valid(c.evidence_json) evidenceValid,length(c.evidence_json) evidenceLength,
    s.qualified_name qualifiedName FROM outbound_calls c
    LEFT JOIN symbols s ON s.id=c.source_symbol_id WHERE c.call_type='local_db_query'
    ORDER BY c.source_file,c.source_line`).all();
  const edges = db.prepare(`SELECT c.source_file sourceFile,c.source_line sourceLine,
    e.edge_type edgeType,e.status,e.to_kind toKind,e.to_id toId,e.confidence,
    json_extract(e.evidence_json,'$.parserWarning.message') parserWarning,
    json_valid(e.evidence_json) evidenceValid,length(e.evidence_json) evidenceLength
    FROM graph_edges e JOIN outbound_calls c ON c.id=CAST(e.from_id AS INTEGER)
    WHERE e.from_kind='call' AND c.call_type='local_db_query'
    ORDER BY c.source_file,c.source_line`).all();
  const result = trace(db, { repo: 'entity-app', handler: 'QueryEntityHandler' },
    { workspaceId, depth: 5, includeDb: true });
  return {
    calls,
    edges,
    traceTargets: result.edges.filter((edge) => edge.type === 'local_db_query')
      .map((edge) => edge.to),
    rendered: `${renderTraceTable(result)}\n${renderTraceJson(result)}\n${renderMermaid(result)}`,
  };
}

function expectBoundedEvidence(rows: Array<Record<string, unknown>>): void {
  expect(rows.every((row) => row.evidenceValid === 1
    && typeof row.evidenceLength === 'number'
    && row.evidenceLength < 8_192)).toBe(true);
}

function expectPersistedContract(state: QueryState): void {
  expect(state.calls.map((row) => row.queryEntity)).toEqual([
    'TrustedRows', null, null, 'DistinctRows', 'WrappedDistinctRows',
  ]);
  expect(state.calls.map((row) => row.confidence)).toEqual([0.9, 0.55, 0.55, 0.9, 0.9]);
  expect(state.calls.map((row) => row.unresolvedReason)).toEqual([
    null, 'dynamic_entity_expression', 'dynamic_entity_expression', null, null,
  ]);
  expect(state.calls.map((row) => row.queryRoot)).toEqual([
    'SELECT.from', 'SELECT.from', 'INSERT.into',
    'SELECT.distinct.from', 'SELECT.distinct.one.from',
  ]);
  expect(state.calls.map((row) => row.qualifiedName)).toEqual(
    Array(5).fill('QueryEntityHandler.inspectEntities'),
  );
  expect(state.edges.map((row) => row.toId)).toEqual([
    'TrustedRows', 'unknown', 'unknown', 'DistinctRows', 'WrappedDistinctRows',
  ]);
  expect(state.edges.map((row) => row.parserWarning)).toEqual([
    null, 'dynamic_entity_expression', 'dynamic_entity_expression', null, null,
  ]);
  expect(state.traceTargets).toEqual([
    'Entity: TrustedRows', 'Entity: unknown', 'Entity: unknown',
    'Entity: DistinctRows', 'Entity: WrappedDistinctRows',
  ]);
  expectBoundedEvidence(state.calls);
  expectBoundedEvidence(state.edges);
}

async function verifyIntegrationContract(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-query-entity-workspace-'));
  await createQueryEntityWorkspace(root);
  const { db, workspaceId } = await prepareWorkspace(root);
  try {
    linkWorkspace(db, workspaceId);
    const first = queryState(db, workspaceId);
    expectPersistedContract(first);
    expect(first.rendered).not.toMatch(/Entity: (runtimeRows|stagedRows|TrustedAlias)/);
    linkWorkspace(db, workspaceId);
    expect(queryState(db, workspaceId)).toEqual(first);
    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    expect(queryState(db, workspaceId)).toEqual(first);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
}

describe('local DB query entity binding resolution', () => {
  it('makes parameters and local runtime values dynamic', async () => {
    const calls = await databaseCallsFor(dynamicBindingSource);
    expect(calls).toHaveLength(8);
    expectDynamicEntities(calls);
  });

  it('preserves imports, literals, entity members, and immutable aliases', async () => {
    const calls = await databaseCallsFor(staticBindingSource);
    expectResolvedEntities(calls, [
      'ImportedRows', 'ImportedRows', 'ImportedRows', 'AliasRows', 'ImportedRows',
      'Namespace.StringRows', 'DottedRows', 'BracketRows', 'LegacyLiteralRows',
    ]);
  });
});

describe('local DB query destructured entity sources', () => {
  it('preserves entities, model require, and model namespace sources', async () => {
    const calls = await databaseCallsFor(genuineDestructuringSource);
    expectResolvedEntities(calls, [
      'EntityRows', 'MutableEntityRows', 'CalledEntityRows', 'ArrayEntityRows',
      'RequiredRows', 'NamespaceRows', 'LegacyRows',
    ]);
  });

  it('rejects runtime, type-only, defaulted, and reassigned bindings', async () => {
    const calls = await databaseCallsFor(runtimeDestructuringSource);
    expect(calls).toHaveLength(8);
    expectDynamicEntities(calls);
  });
});

describe('local DB query lexical exactness', () => {
  it('fails closed for shadows and cycles while keeping the inner static alias', async () => {
    const calls = await databaseCallsFor(lexicalShadowSource);
    expect(calls.map((call) => call.queryEntity)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'ImportedStaticRows', 'StableQueryRows',
    ]);
    expect(calls.slice(0, 7).map((call) => call.unresolvedReason)).toEqual([
      'dynamic_entity_expression', 'dynamic_entity_expression',
      'dynamic_entity_expression', 'query_variable_without_static_initializer',
      'dynamic_entity_expression', 'dynamic_entity_expression',
      'dynamic_entity_expression',
    ]);
    expect(calls.slice(7)).toEqual([
      expect.objectContaining({ queryEntity: 'ImportedStaticRows', confidence: 0.9 }),
      expect.objectContaining({ queryEntity: 'StableQueryRows', confidence: 0.9 }),
    ]);
  });

  it('bounds immutable alias traversal', async () => {
    const calls = await databaseCallsFor(aliasDepthSource);
    expect(calls).toEqual([
      expect.objectContaining({ queryEntity: 'ImportedRows', confidence: 0.9 }),
      expect.objectContaining({ queryEntity: undefined, confidence: 0.55 }),
    ]);
  });
});

describe('local DB query shadow and write arbitration', () => {
  it('rejects nearer value declarations and destructuring assignments', async () => {
    const calls = await databaseCallsFor(advancedShadowSource);
    expect(calls).toHaveLength(8);
    expectDynamicEntities(calls, [
      'query_variable_without_static_initializer',
      'query_variable_without_static_initializer',
      ...Array<string>(6).fill('dynamic_entity_expression'),
    ]);
  });
});

describe('SELECT distinct query roots', () => {
  it('emits one correctly classified fact for each direct and wrapped statement', async () => {
    const calls = await databaseCallsFor(distinctSource);
    expectResolvedEntities(calls, [
      'DistinctRows', 'DistinctOneRows', 'WrappedDistinctRows', 'WrappedDistinctOneRows',
    ]);
    expect(calls.map((call) => call.evidence?.queryRoot)).toEqual([
      'SELECT.distinct.from', 'SELECT.distinct.one.from',
      'SELECT.distinct.from', 'SELECT.distinct.one.from',
    ]);
    expect(calls.map((call) => call.evidence?.classifier)).toEqual([
      'cap_query_builder_direct', 'cap_query_builder_direct',
      'cap_query_run_wrapper', 'cap_query_run_wrapper',
    ]);
    expect(calls.map((call) => call.evidence?.queryExecutionContext)).toEqual([
      'await', 'await', undefined, undefined,
    ]);
  });
});

describe('remote query compatibility boundary', () => {
  it('does not treat an instance field as a static remote entity hint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-remote-query-entity-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'handler.ts'), remoteThisSource);
    const calls = await parseOutboundCalls(root, 'src/handler.ts');
    expect(calls.filter((call) => call.callType === 'remote_query')).toEqual([
      expect.objectContaining({ queryEntity: undefined }),
    ]);
  });
});

describe('query entity SQLite and trace integration', () => {
  it('persists fail-closed facts and stays deterministic across relinking', async () => {
    await verifyIntegrationContract();
  });
});
