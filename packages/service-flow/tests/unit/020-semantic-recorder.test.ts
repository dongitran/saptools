import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import {
  CompactObservationCollector,
  type CompactEdgeObservation,
} from '../../src/trace/014-compact-contract.js';
import {
  compactDecisionFromEvidence,
  compactRefs,
  TraceEdgeRecorder,
} from '../../src/trace/015-trace-edge-recorder.js';
import { projectCompactGraph } from '../../src/trace/016-compact-projector.js';
import {
  compactSourceContext,
  traceAndCompact,
} from '../../src/trace/018-compact-trace.js';
import { trace, traceWithObserver } from '../../src/trace/trace-engine.js';
import type { TraceOptions, TraceResult, TraceStart } from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

interface RecorderFixture {
  db: Db;
  workspaceId: number;
}

let fixture: RecorderFixture | undefined;

function fixtureState(): RecorderFixture {
  if (!fixture) throw new Error('Semantic recorder fixture was not initialized');
  return fixture;
}

const start: TraceStart = {
  repo: 'semantic-a',
  servicePath: '/SemanticService',
  operation: 'start',
};

function traceOptions(workspaceId: number): TraceOptions {
  return { depth: 10, workspaceId, includeAsync: true,
    includeDb: true, includeExternal: true };
}

async function writeSemanticRepositoryA(root: string): Promise<void> {
  await writeFixtureFile(root, 'semantic-a/.git-fixture');
  await writeFixtureFile(root, 'semantic-a/package.json', JSON.stringify({
    name: 'semantic-a', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'semantic-a/srv/semantic.cds',
    'service SemanticService { action start(); }');
  await writeFixtureFile(root, 'semantic-a/src/EntryHandler.ts', `
import { Action, Handler } from 'cds-routing-handlers';
import { localEntry } from './local.js';
@Handler()
export class EntryHandler {
  @Action('start')
  async start(): Promise<void> {
    await localEntry();
    await messaging.emit('SemanticEvent', {});
  }
}
`);
  await writeFixtureFile(root, 'semantic-a/src/local.ts', `
import cds from '@sap/cds';
export async function localEntry(): Promise<void> {
  await cds.run(SELECT.from(LocalRows));
  await recurse();
}
export async function recurse(): Promise<void> { await recurse(); }
`);
  await writeFixtureFile(root, 'semantic-a/src/subscriber.ts', `
import cds from '@sap/cds';
export async function eventSubscriber(): Promise<void> {
  await cds.run(SELECT.from(SubscriberRows));
}
export async function duplicateLabel(): Promise<void> {
  await cds.run(SELECT.from(DuplicateRows));
}
`);
  await writeFixtureFile(root, 'semantic-a/src/register.ts', `
import { eventSubscriber } from './subscriber.js';
messaging.on('SemanticEvent', eventSubscriber);
`);
  await writeFixtureFile(root, 'semantic-a/src/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { EntryHandler } from './EntryHandler.js';
createCombinedHandler({ handler: [EntryHandler] });
`);
  await writeFixtureFile(root, 'semantic-a/src/unowned.ts',
    "void fetch('https://example.invalid/unowned');\n");
}

async function writeSemanticRepositoryB(root: string): Promise<void> {
  await writeFixtureFile(root, 'semantic-b/.git-fixture');
  await writeFixtureFile(root, 'semantic-b/package.json', JSON.stringify({
    name: 'semantic-b', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'semantic-b/src/subscriber.ts', `
import cds from '@sap/cds';
export async function duplicateLabel(): Promise<void> {
  await cds.run(SELECT.from(DuplicateRows));
}
`);
}

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-semantic-'));
  await writeSemanticRepositoryA(root);
  await writeSemanticRepositoryB(root);
  const prepared = await prepareWorkspace(root);
  linkWorkspace(prepared.db, prepared.workspaceId);
  fixture = prepared;
}, 30_000);

afterAll(() => fixture?.db.close());

  it('partitions detailed edge ordinals and records every semantic relation', () => {
    const { db, workspaceId } = fixtureState();
    const collector = new CompactObservationCollector();
    const result = traceWithObserver(
      db, start, traceOptions(workspaceId), collector,
    );
    expect(collector.observations).toHaveLength(result.edges.length);
    expect(collector.observations.map((item) => item.ordinal)).toEqual(
      result.edges.map((_, index) => index),
    );
    expect(collector.workspaceId).toBe(workspaceId);
    expectSemanticCoverage(collector.observations);
  });

  it('keeps the authoritative detailed JSON byte-identical with observation enabled', () => {
    const { db, workspaceId } = fixtureState();
    const options = traceOptions(workspaceId);
    const expected = renderTraceJson(trace(db, start, options));
    const observed = renderTraceJson(traceWithObserver(
      db, start, options, new CompactObservationCollector(),
    ));
    expect(observed).toBe(expected);
    expect(sha256(observed)).toBe(sha256(expected));
  });

  it('uses exact call-site sources and keeps colliding labels repository-scoped', () => {
    const { db, workspaceId } = fixtureState();
    const broadStart: TraceStart = {};
    const options = traceOptions(workspaceId);
    const collector = new CompactObservationCollector();
    traceWithObserver(db, broadStart, options, collector);
    const unowned = collector.observations.find((item) =>
      item.type === 'external_http' && item.source.kind === 'call_site');
    expect(unowned?.source).toMatchObject({
      kind: 'call_site', sourceFile: 'src/unowned.ts',
      repositoryName: 'semantic-a',
    });
    if (unowned?.source.kind === 'call_site') {
      expect(unowned.source.startOffset).toBeTypeOf('number');
      expect(unowned.source.endOffset).toBeGreaterThan(
        unowned.source.startOffset ?? -1,
      );
    }
    const { compact } = traceAndCompact(db, broadStart, options);
    const duplicateRows = compact.nodes.filter((node) =>
      node[2].includes('DuplicateRows'));
    expect(duplicateRows).toHaveLength(2);
    expect(new Set(duplicateRows.map((node) => node[3])).size).toBe(2);
  });

  it('projects explicit side-specific unavailable endpoints without merging them', () => {
    const { db, workspaceId } = fixtureState();
    const edges: TraceResult['edges'] = [];
    const collector = new CompactObservationCollector();
    const recorder = new TraceEdgeRecorder(edges, collector);
    for (const line of [7, 8]) {
      const edge = { step: 1, type: 'unknown_relation', from: 'same', to: 'same',
        evidence: {}, confidence: 0, unresolvedReason: 'unknown' };
      recorder.record(edge, {
        source: recorder.unavailable('source', 'unknown_source'),
        target: recorder.unavailable('target', 'unknown_target'),
        status: 'unresolved',
        decision: { reasonCode: 'structured_identity_unavailable' },
        site: { repository: 'semantic-a', sourceFile: 'src/unknown.ts',
          sourceLine: line },
      });
    }
    const traceResult: TraceResult = {
      start: {}, nodes: [], edges, diagnostics: [],
    };
    const compact = projectCompactGraph({
      db, start: {}, options: traceOptions(workspaceId),
      source: compactSourceContext(db, traceOptions(workspaceId), workspaceId),
      trace: traceResult, observations: collector.observations,
    });
    expect(compact.summary.projection.syntheticEndpoints).toBe(4);
    expect(compact.nodes).toHaveLength(4);
    expect(compact.edges.flatMap((edge) => edge[1])).toEqual([0, 1]);
  });

  it('preserves resolved, terminal, inferred, and cycle decisions', () => {
    const { db, workspaceId } = fixtureState();
    const compact = traceAndCompact(
      db, start, traceOptions(workspaceId),
    ).compact;
    const expectedGeneration = Number(db.prepare(`SELECT graph_generation generation
      FROM repositories WHERE workspace_id=? LIMIT 1`).get(workspaceId)?.generation);
    expect(compact.source.graphGeneration).toBe(expectedGeneration);
    expect(compact.summary.statusCounts.resolved).toBeGreaterThan(0);
    expect(compact.summary.statusCounts.terminal).toBeGreaterThan(0);
    expect(compact.summary.statusCounts.inferred).toBeGreaterThan(0);
    expect(compact.summary.statusCounts.cycle).toBeGreaterThan(0);
    expect(compact.edges.flatMap((edge) => edge[1]).sort((a, b) => a - b))
      .toEqual(Array.from({ length: compact.summary.fullTraceEdges },
        (_, index) => index));
  });

  it('uses authoritative implementation counts and normalizes numeric references', () => {
    const decision = compactDecisionFromEvidence({
      implementationSelection: {
        status: 'tied', candidateCount: 17,
        candidates: [{ private: 'must-not-be-copied' }],
      },
    });
    expect(decision.candidateCount).toBe(17);
    expect(JSON.stringify(decision)).not.toContain('must-not-be-copied');
    expect(compactRefs({ graphEdgeId: '123' }).graphEdgeIds).toEqual([123]);
    expect(compactRefs({ graphEdgeId: '-1' }).graphEdgeIds).toBeUndefined();
  });

function expectSemanticCoverage(observations: CompactEdgeObservation[]): void {
  expectOperationAndLocalCoverage(observations);
  expectOutboundAndEventCoverage(observations);
  expect(observations.some((item) => item.status === 'cycle')).toBe(true);
}

function expectOperationAndLocalCoverage(
  observations: CompactEdgeObservation[],
): void {
  const operation = observations.find((item) =>
    item.type === 'operation_implemented_by_handler');
  expect(operation?.source.kind).toBe('operation');
  expect(operation?.target.kind).toBe('symbol');
  const local = observations.find((item) => item.type === 'local_symbol_call');
  expect(local?.source.kind).toBe('symbol');
  expect(local?.target.kind).toBe('symbol');
  expect(local?.source).not.toEqual(local?.target);
}

function expectOutboundAndEventCoverage(
  observations: CompactEdgeObservation[],
): void {
  const outbound = observations.find((item) => item.type === 'local_db_query');
  expect(outbound?.source.kind).toBe('symbol');
  expect(outbound?.target.kind).toBe('target');
  const bridge = observations.find((item) =>
    item.type === 'event_name_matches_subscription_handler');
  expect(bridge?.source).toMatchObject({ kind: 'event',
    eventName: 'SemanticEvent' });
  expect(bridge?.target.kind).toBe('symbol');
  expect(bridge?.status).toBe('inferred');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
