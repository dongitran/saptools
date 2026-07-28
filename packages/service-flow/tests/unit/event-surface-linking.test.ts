import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { traceAndCompact } from '../../src/trace/compact-trace.js';
import {
  recordHiddenEventShapeCandidates,
} from '../../src/trace/event-shape-candidate-trace.js';
import type {
  TraceGraphEdgeRow,
} from '../../src/trace/trace-graph-lookups.js';
import { trace } from '../../src/trace/trace-engine.js';
import type { TraceResult } from '../../src/types.js';
import {
  parseEventSkeletonFact,
} from '../../src/utils/event-skeleton.js';
import {
  prepareWorkspace,
  writeFixtureFile,
} from './test-workspace.js';

interface OutboundEventRow extends Record<string, unknown> {
  id: number;
  eventName: string;
  reason?: string | null;
  signature?: string | null;
  skeletonJson?: string | null;
  evidenceJson: string;
}

interface GraphEventRow extends Record<string, unknown> {
  edgeType: string;
  status: string;
  fromId: string;
  toKind: string;
  toId: string;
  reason?: string | null;
  evidenceJson: string;
}

function expectEveryEdgeTargetRegistered(result: TraceResult): void {
  const nodeIds = new Set(result.nodes.flatMap((node) =>
    typeof node.id === 'string' ? [node.id] : []));
  expect(result.edges.filter((edge) =>
    !nodeIds.has(edge.toNodeId ?? edge.to))).toEqual([]);
}

function shapeCandidateRow(id: number): TraceGraphEdgeRow {
  return {
    id,
    edge_type: 'EVENT_SHAPE_CANDIDATE_SUBSCRIBER',
    from_kind: 'call',
    from_id: String(id),
    to_kind: 'symbol',
    to_id: String(id),
    status: 'dynamic',
    confidence: 0.2,
    evidence_json: '{}',
  };
}

function packageJson(
  name: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ name, version: '1.0.0', ...extra });
}

async function writePackageConstantFixture(root: string): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, 'publisher/.git-fixture'),
    writeFixtureFile(root, 'publisher/package.json', packageJson(
      '@neutral/event-publisher',
      { dependencies: { '@neutral/event-topics': '1.0.0' } },
    )),
    writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
import { TOPICS, UNSAFE_TOPICS } from '@neutral/event-topics';
function buildThing(): { emit(name: string, payload: unknown): void } {
  return { emit(): void {} };
}
export async function publishJob(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(TOPICS.FLOW_READY, {});
  await bus.emit(UNSAFE_TOPICS.UNSAFE, {});
  const notAClient = buildThing();
  notAClient.emit('NotCap', {});
}
`),
    writeFixtureFile(root, 'topics/.git-fixture'),
    writeFixtureFile(root, 'topics/package.json', packageJson(
      '@neutral/event-topics',
      { exports: { '.': './src/index.ts' } },
    )),
    writeFixtureFile(root, 'topics/src/index.ts', `
export const TOPICS = { FLOW_READY: 'NeutralFlowReady' } as const;
const BASE = { OVERRIDE: 'NeutralOverride' } as const;
export const UNSAFE_TOPICS = { UNSAFE: 'UnsafeValue', ...BASE } as const;
`),
    writeFixtureFile(root, 'subscriber/.git-fixture'),
    writeFixtureFile(root, 'subscriber/package.json', packageJson(
      '@neutral/event-subscriber',
    )),
    writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
import cds from '@sap/cds';
export function handleNeutralFlowReady(): void {}
export async function subscribe(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.on('NeutralFlowReady', handleNeutralFlowReady);
}
`),
  ]);
}

function eventCalls(db: Db): OutboundEventRow[] {
  return db.prepare(`SELECT c.id,c.event_name_expr eventName,
    c.unresolved_reason reason,
    c.event_skeleton_signature signature,
    c.event_skeleton_json skeletonJson,c.evidence_json evidenceJson
    FROM outbound_calls c
    WHERE c.call_type IN ('async_emit','async_subscribe')
    ORDER BY c.id`).all() as OutboundEventRow[];
}

function eventEdges(db: Db): GraphEventRow[] {
  return db.prepare(`SELECT edge_type edgeType,status,from_id fromId,
    to_kind toKind,to_id toId,unresolved_reason reason,
    evidence_json evidenceJson
    FROM graph_edges
    WHERE edge_type IN (
      'HANDLER_EMITS_EVENT','EVENT_SUBSCRIPTION_HANDLED_BY',
      'DYNAMIC_EDGE_CANDIDATE','EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
    )
    ORDER BY edge_type COLLATE BINARY,from_id COLLATE BINARY,
      to_id COLLATE BINARY,id`).all() as GraphEventRow[];
}

async function writeShapeFixture(root: string): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, 'publisher/.git-fixture'),
    writeFixtureFile(root, 'publisher/package.json',
      packageJson('@neutral/shape-publisher')),
    writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export async function publish(
  publishCode: string, first: string, second: string,
): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${publishCode}RecordStored\`, {});
  await bus.emit(\`\${first}\${second}\`, {});
}
`),
    writeFixtureFile(root, 'subscriber/.git-fixture'),
    writeFixtureFile(root, 'subscriber/package.json',
      packageJson('@neutral/shape-subscriber')),
    writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
import cds from '@sap/cds';
export function handleRecordStored(): void {}
export function handleAllHoles(): void {}
export async function subscribe(
  subscribeCode: string, first: string, second: string,
): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.on(\`\${subscribeCode}RecordStored\`, handleRecordStored);
  bus.on(\`\${first}\${second}\`, handleAllHoles);
}
`),
  ]);
}

async function writePayloadSplitFixture(root: string): Promise<void> {
  const subscriber = (): string => `
import cds from '@sap/cds';
export function handleOutcome(): void {}
export async function subscribe(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.on(\`\${code}StoredOutcome\`, handleOutcome);
}
`;
  await Promise.all([
    writeFixtureFile(root, 'publisher/.git-fixture'),
    writeFixtureFile(root, 'publisher/package.json',
      packageJson('@neutral/payload-publisher')),
    writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
async function publish(mode: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${mode}StoredOutcome\`, {});
}
export async function start(): Promise<void> {
  await publish('X');
  await publish('Y');
}
`),
    writeFixtureFile(root, 'subscriber-x/.git-fixture'),
    writeFixtureFile(root, 'subscriber-x/package.json',
      packageJson('@neutral/payload-subscriber-x')),
    writeFixtureFile(root, 'subscriber-x/src/subscribe.ts',
      subscriber()),
    writeFixtureFile(root, 'subscriber-y/.git-fixture'),
    writeFixtureFile(root, 'subscriber-y/package.json',
      packageJson('@neutral/payload-subscriber-y')),
    writeFixtureFile(root, 'subscriber-y/src/subscribe.ts',
      subscriber()),
  ]);
}

async function writeLoopSubscriptionFixture(root: string): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, 'subscriber/.git-fixture'),
    writeFixtureFile(root, 'subscriber/package.json',
      packageJson('@neutral/loop-subscriber')),
    writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
import cds from '@sap/cds';
declare const guard: { wrap(handler: unknown): unknown };
declare const runtimeTopics: string[];
const TOPICS = ['NeutralStored', 'NeutralUpdated', 'NeutralDeleted'] as const;
export class Handler {
  static handle(): void {}
}
export async function subscribe(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  TOPICS.forEach((topic) => {
    bus.on(topic, guard.wrap(Handler.handle));
  });
  runtimeTopics.forEach((topic) => {
    bus.on(topic, guard.wrap(Handler.handle));
  });
}
`),
  ]);
}

function diagnostic(
  values: Record<string, unknown>[],
  code: string,
): Record<string, unknown> {
  return values.find((item) => item.code === code) ?? {};
}

function parsedRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('fixture_json_record_required');
  return parsed as Record<string, unknown>;
}

function shapeCall(
  calls: OutboundEventRow[],
  prefix: string,
): OutboundEventRow {
  const value = calls.find((call) => call.eventName.startsWith(prefix));
  if (!value) throw new Error(`shape_call_missing:${prefix}`);
  return value;
}

async function writeEnvironmentLibrary(
  root: string,
  key = 'SHARD_CODE',
): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, 'subscriber-lib/.git-fixture'),
    writeFixtureFile(root, 'subscriber-lib/package.json',
      packageJson('@neutral/environment-subscriber')),
    writeFixtureFile(root, 'subscriber-lib/src/env.ts',
      `export const envCode = process.env.${key};\n`),
    writeFixtureFile(root, 'subscriber-lib/src/subscribe.ts', `
import cds from '@sap/cds';
import { envCode } from './env';
const subscriptionCode = envCode.toUpperCase();
export function handleRecordStored(): void {}
export async function subscribe(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.on(\`\${subscriptionCode}RecordStored\`, handleRecordStored);
}
`),
  ]);
}

async function writeEnvironmentConsumer(
  root: string,
  name: string,
  value: string,
  key = 'SHARD_CODE',
): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, `${name}/.git-fixture`),
    writeFixtureFile(root, `${name}/package.json`, packageJson(
      `@neutral/${name}`,
      { dependencies: { '@neutral/environment-subscriber': '1.0.0' } },
    )),
    writeFixtureFile(root, `${name}/nodemon.json`, JSON.stringify({
      env: {
        [key]: value,
        PRIVATE_TOKEN: `must-not-persist-${name}`,
      },
    })),
    writeFixtureFile(root, `${name}/src/index.ts`,
      'export const consumer = true;\n'),
  ]);
}

async function writeEnvironmentConsumerWithoutDeclaration(
  root: string,
  name: string,
): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, `${name}/.git-fixture`),
    writeFixtureFile(root, `${name}/package.json`, packageJson(
      `@neutral/${name}`,
      { dependencies: { '@neutral/environment-subscriber': '1.0.0' } },
    )),
    writeFixtureFile(root, `${name}/src/index.ts`,
      'export const consumer = true;\n'),
  ]);
}

async function writeEnvironmentFixture(root: string): Promise<void> {
  await writeEnvironmentLibrary(root);
  await Promise.all([
    writeEnvironmentConsumer(root, 'consumer-a', 'neutralone'),
    writeEnvironmentConsumer(root, 'consumer-b', 'neutraltwo'),
    writeEnvironmentConsumer(root, 'consumer-c', 'neutraltwo'),
    writeFixtureFile(root, 'publisher/.git-fixture'),
    writeFixtureFile(root, 'publisher/package.json',
      packageJson('@neutral/environment-publisher')),
    writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export async function publishCollision(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit('NEUTRALTWORecordStored', {});
  await bus.emit(\`\${code}RecordStored\`, {});
}
`),
  ]);
}

function subscriptionEdges(db: Db): GraphEventRow[] {
  return eventEdges(db).filter((edge) =>
    edge.edgeType === 'EVENT_SUBSCRIPTION_HANDLED_BY');
}

function semanticEventEdges(db: Db): Record<string, unknown>[] {
  return db.prepare(`SELECT e.edge_type edgeType,e.status,
    COALESCE(c.source_file,e.from_id) source,
    c.source_line sourceLine,e.to_kind targetKind,
    CASE WHEN e.to_kind='symbol'
      THEN target_repo.name || ':' || target.source_file || ':'
        || target.qualified_name ELSE e.to_id END target,
    e.unresolved_reason reason
    FROM graph_edges e
    LEFT JOIN outbound_calls c
      ON e.from_kind='call' AND c.id=CAST(e.from_id AS INTEGER)
    LEFT JOIN symbols target
      ON e.to_kind='symbol' AND target.id=CAST(e.to_id AS INTEGER)
    LEFT JOIN repositories target_repo ON target_repo.id=target.repo_id
    WHERE e.edge_type IN (
      'HANDLER_EMITS_EVENT','EVENT_SUBSCRIPTION_HANDLED_BY',
      'DYNAMIC_EDGE_CANDIDATE','EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
    )
    ORDER BY edgeType COLLATE BINARY,source COLLATE BINARY,
      sourceLine,targetKind COLLATE BINARY,target COLLATE BINARY,
      reason COLLATE BINARY`).all();
}

describe('event surface linking', () => {
  it('counts uncapped scopes when a later candidate scope is capped', () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const options = {
      depth: 8,
      includeAsync: true,
      dynamicMode: 'candidates' as const,
      maxDynamicCandidates: 1,
    };
    recordHiddenEventShapeCandidates(
      diagnostics,
      [shapeCandidateRow(1)],
      [shapeCandidateRow(1)],
      options,
    );
    expect(diagnostics).toEqual([]);
    recordHiddenEventShapeCandidates(
      diagnostics,
      [shapeCandidateRow(2), shapeCandidateRow(3)],
      [shapeCandidateRow(2)],
      options,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'event_shape_candidates_omitted',
        candidateCount: 3,
        shownCandidateCount: 2,
        omittedCandidateCount: 1,
        maxDynamicCandidates: 1,
      }),
    ]);
  });

  it('accepts empty constants but refuses an empty value as an event name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-empty-'));
    await Promise.all([
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/empty-publisher')),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export const UNUSED_EMPTY = '';
const EMPTY_TOPIC = '';
export async function publish(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(EMPTY_TOPIC, {});
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(root);
    expect(db.prepare(`SELECT name,value,resolution_status status,
      unresolved_reason reason FROM generated_constants
      WHERE value='' ORDER BY name COLLATE BINARY`).all()).toEqual([
      {
        name: 'EMPTY_TOPIC', value: '', status: 'resolved', reason: null,
      },
      {
        name: 'UNUSED_EMPTY', value: '', status: 'resolved', reason: null,
      },
    ]);

    expect(() => linkWorkspace(db, workspaceId)).not.toThrow();
    expect(eventCalls(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: 'EMPTY_TOPIC',
        reason: 'event_name_constant_value_empty',
      }),
    ]));
    expect(eventEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'DYNAMIC_EDGE_CANDIDATE',
        toKind: 'event_candidate',
        reason: 'event_name_constant_value_empty',
      }),
    ]));
    db.close();
  });

  it('keeps a static unproven-receiver publication terminal and disclosed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-axes-'));
    await Promise.all([
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/axis-publisher')),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
interface Params {
  messaging: { emit(name: string, payload: unknown): Promise<void> };
}
export async function publish(params: Params): Promise<void> {
  await params.messaging.emit('StaticThroughProperty', {});
}
`),
      writeFixtureFile(root, 'subscriber/.git-fixture'),
      writeFixtureFile(root, 'subscriber/package.json',
        packageJson('@neutral/axis-subscriber')),
      writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
import cds from '@sap/cds';
export function handleStatic(): void {}
export async function subscribe(): Promise<void> {
  const messaging = await cds.connect.messaging('primary');
  messaging.on('StaticThroughProperty', handleStatic);
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(root);
    const publication = eventCalls(db).find((call) =>
      call.eventName === 'StaticThroughProperty'
      && parsedRecord(call.evidenceJson).classifier
        === 'cap_service_event_emit');
    expect(publication).toMatchObject({ reason: null });
    expect(parsedRecord(publication?.evidenceJson ?? '')).toMatchObject({
      receiverClassification: 'unproven',
      receiverUnresolvedReason: 'event_receiver_unproven_propagation',
    });
    expect(parsedRecord(publication?.evidenceJson ?? ''))
      .not.toHaveProperty('eventNameUnresolvedReason');

    linkWorkspace(db, workspaceId);
    expect(eventEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'HANDLER_EMITS_EVENT',
        status: 'terminal',
        toKind: 'event',
        toId: 'StaticThroughProperty',
        reason: 'event_receiver_unproven_propagation',
      }),
      expect.objectContaining({
        edgeType: 'EVENT_SUBSCRIPTION_HANDLED_BY',
        status: 'resolved',
        fromId: 'StaticThroughProperty',
      }),
    ]));
    const result = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    });
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event_name_matches_subscription_handler',
        from: 'StaticThroughProperty',
      }),
    ]));
    expect(parsedRecord(eventEdges(db).find((edge) =>
      edge.edgeType === 'HANDLER_EMITS_EVENT')?.evidenceJson ?? '')).toMatchObject({
      dispatchCertainty: 'receiver_unproven',
    });
    const quality = diagnostic(
      doctorDiagnostics(db, true, { workspaceId }),
      'strict_event_receiver_classification_quality',
    );
    expect(quality.publicationDispatchCertaintyBuckets).toContainEqual({
      certainty: 'receiver_unproven',
      count: 1,
    });
    db.close();
  });

  it('keeps an unproven subscription receiver non-terminal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-sub-axis-'));
    await Promise.all([
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/sub-axis-publisher')),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export async function publish(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit('StaticUnprovenSubscription', {});
}
`),
      writeFixtureFile(root, 'subscriber/.git-fixture'),
      writeFixtureFile(root, 'subscriber/package.json',
        packageJson('@neutral/sub-axis-subscriber')),
      writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
interface Params {
  messaging: { on(name: string, handler: () => void): void };
}
export function handleStatic(): void {}
export function subscribe(params: Params): void {
  params.messaging.on('StaticUnprovenSubscription', handleStatic);
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(root);
    const subscription = eventCalls(db).find((call) =>
      call.eventName === 'StaticUnprovenSubscription'
      && parsedRecord(call.evidenceJson).classifier
        === 'cap_service_event_subscription');
    expect(subscription).toBeDefined();
    expect(parsedRecord(subscription?.evidenceJson ?? '')).toMatchObject({
      receiverClassification: 'unproven',
      receiverUnresolvedReason: 'event_receiver_unproven_propagation',
    });

    linkWorkspace(db, workspaceId);
    const association = eventEdges(db).find((edge) =>
      edge.edgeType === 'EVENT_SUBSCRIPTION_HANDLED_BY');
    expect(association).toMatchObject({
      status: 'unresolved',
      fromId: 'Event: StaticUnprovenSubscription',
      reason: 'event_receiver_unproven_propagation',
    });
    expect(parsedRecord(association?.evidenceJson ?? '')).toMatchObject({
      dispatchCertainty: 'receiver_unproven',
    });
    expect(trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    }).edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler')).toBe(false);
    db.close();
  });

  it('resolves a uniquely public package constant and traverses its subscriber', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-constant-'));
    await writePackageConstantFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const pending = eventCalls(db).find((call) =>
      call.eventName === 'TOPICS.FLOW_READY');
    expect(pending).toMatchObject({
      reason: 'event_name_constant_resolution_pending',
    });

    linkWorkspace(db, workspaceId);
    const resolved = eventCalls(db).find((call) =>
      call.eventName === 'NeutralFlowReady' && call.reason == null
      && call.evidenceJson.includes('eventNamePackageConstantResolution'));
    expect(resolved).toBeDefined();
    const evidence = parsedRecord(String(resolved?.evidenceJson));
    expect(evidence).toMatchObject({
      eventNameConstant: { sourceKind: 'package_static_string' },
      eventNamePackageConstantResolution: {
        status: 'resolved',
        candidateCount: 1,
        eligibleCandidateCount: 1,
        selectedCandidateCount: 1,
        candidateSetComplete: true,
        requestedPackageName: '@neutral/event-topics',
        requestedModuleSubpath: '.',
        requestedPublicName: 'TOPICS.FLOW_READY',
        resolvedModulePath: 'src/index',
      },
    });
    expect(eventEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'HANDLER_EMITS_EVENT',
        status: 'terminal',
        toKind: 'event',
        toId: 'NeutralFlowReady',
      }),
      expect.objectContaining({
        edgeType: 'EVENT_SUBSCRIPTION_HANDLED_BY',
        status: 'resolved',
        fromId: 'NeutralFlowReady',
      }),
    ]));
    const result = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    });
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event_name_matches_subscription_handler',
        from: 'NeutralFlowReady',
      }),
    ]));
    expect(eventEdges(db).some((edge) =>
      edge.reason === 'event_template_variables_missing')).toBe(false);
    expect(eventCalls(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: 'UNSAFE_TOPICS.UNSAFE',
        reason: 'event_name_constant_container_unsupported_shape',
      }),
    ]));
    expect(eventEdges(db).some((edge) =>
      edge.toId === 'Event: NotCap')).toBe(false);
    const execution = traceAndCompact(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    });
    expect(renderTraceTable(execution.trace)).toContain(
      '[scope=workspace_event_name_only,certainty=static_name_only]',
    );
    const compactBridge = execution.compact.edges.find((edge) =>
      edge[3] === 'event_name_matches_subscription_handler');
    expect(compactBridge?.[9]?.decision).toMatchObject({
      dispatchCertainty: 'static_name_only',
      eventScope: 'workspace_event_name_only',
    });
    expect(diagnostic(
      doctorDiagnostics(db, true, { workspaceId }),
      'strict_event_receiver_classification_quality',
    )).toMatchObject({
      eventTotal: 3,
      proven: 3,
      nameFallback: 0,
      unproven: 0,
      questionable: 0,
    });
    expect(diagnostic(
      doctorDiagnostics(db, true, { workspaceId }),
      'strict_analysis_branch_reachability',
    )).toMatchObject({
      branchPopulations: {
        eventReceiverProvenNotCapExcluded: 1,
        eventReceiverKnownNonCapExcluded: 0,
        nodeEventParameterTypeExcluded: 0,
        methodNameFallbackSiblingRefused: 0,
      },
    });
    await writeFixtureFile(root, 'topics/src/index.ts', `
export const TOPICS = { FLOW_READY: 'NeutralFlowRestarted' } as const;
const BASE = { OVERRIDE: 'NeutralOverride' } as const;
export const UNSAFE_TOPICS = { UNSAFE: 'UnsafeValue', ...BASE } as const;
`);
    const indexed = await indexWorkspace(db, workspaceId, {
      repo: 'topics', force: false,
    });
    expect(indexed.skippedCount).toBe(0);
    expect(eventCalls(db).find((call) =>
      call.eventName === 'TOPICS.FLOW_READY')).toMatchObject({
      reason: 'event_name_constant_resolution_pending',
    });
    linkWorkspace(db, workspaceId);
    expect(eventEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'HANDLER_EMITS_EVENT',
        toId: 'NeutralFlowRestarted',
      }),
    ]));
    expect(db.pragma('integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('keeps skeleton matches opt-in and resolves both sides from one canonical key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-shape-'));
    await writeShapeFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.eventShapeCandidateCount).toBe(1);
    const calls = eventCalls(db);
    const publication = shapeCall(calls, '${publishCode}');
    const subscription = shapeCall(calls, '${subscribeCode}');
    expect(publication.signature).toBe(subscription.signature);
    const skeleton = parseEventSkeletonFact(publication.skeletonJson);
    const canonicalKey = skeleton?.canonicalKeys[0];
    if (!canonicalKey) throw new Error('fixture_canonical_key_missing');

    const strict = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    });
    expectEveryEdgeTargetRegistered(strict);
    expect(strict.edges.some((edge) =>
      edge.type === 'event_shape_candidate_subscriber')).toBe(false);
    expect(diagnostic(
      strict.diagnostics, 'event_shape_candidates_hidden',
    )).toMatchObject({
      candidateCount: 1,
      shownCandidateCount: 0,
      omittedCandidateCount: 1,
      maxDynamicCandidates: 5,
      remediation:
        'Use --dynamic-mode candidates to inspect bounded subscriber candidates.',
    });
    expect(renderTraceTable(strict)).toContain(
      '--dynamic-mode candidates',
    );
    expect(diagnostic(
      strict.diagnostics, 'trace_runtime_variables_missing',
    ).missingVariables).toEqual(expect.arrayContaining([
      'publishCode', 'subscribeCode', canonicalKey,
    ]));

    const candidates = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    });
    expectEveryEdgeTargetRegistered(candidates);
    const shapeEdges = candidates.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber');
    expect(shapeEdges).toHaveLength(1);
    expect(shapeEdges[0]?.to).toBe(
      'subscriber:src/subscribe.ts:handleRecordStored',
    );
    expect(candidates.nodes.find((node) =>
      node.id === (shapeEdges[0]?.toNodeId ?? shapeEdges[0]?.to))?.label).toMatch(
      /^subscriber:subscribe\.ts:handleRecordStored$/,
    );
    expect(shapeEdges[0]?.evidence).toMatchObject({
      dispatchCertainty: 'skeleton_equivalent',
      subscriptionRepositoryName: 'subscriber',
    });
    const strictProjected = traceAndCompact(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    }).compact;
    const projected = traceAndCompact(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    }).compact;
    expect(strictProjected.diagnostics.some((row) =>
      row[2] === 'event_shape_candidates_hidden')).toBe(true);
    expect(projected.edges.filter((edge) =>
      edge[3] === 'event_shape_candidate_subscriber')).toHaveLength(1);
    const { dynamic: strictDynamic, ...strictCounts } =
      strictProjected.summary.statusCounts;
    const { dynamic: candidateDynamic, ...candidateCounts } =
      projected.summary.statusCounts;
    expect(candidateCounts).toEqual(strictCounts);
    expect(candidateDynamic).toBe(strictDynamic + 1);

    const canonical = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      vars: { [canonicalKey]: 'NEUTRAL' },
    });
    expectEveryEdgeTargetRegistered(canonical);
    expect(canonical.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event_name_matches_subscription_handler',
        from: 'NEUTRALRecordStored',
      }),
    ]));
    const legacy = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      vars: { publishCode: 'NEUTRAL', subscribeCode: 'NEUTRAL' },
    });
    expect(legacy.edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler'
      && edge.from === 'NEUTRALRecordStored')).toBe(true);
    const quality = doctorDiagnostics(db, true, { workspaceId });
    expect(diagnostic(
      quality, 'strict_graph_evidence_quality',
    )).toMatchObject({ severity: 'info' });
    expect(diagnostic(
      quality, 'strict_event_name_resolution_quality',
    )).toMatchObject({
      publicationTotal: 2,
      unresolvedPublicationCount: 2,
      reasonBucketCount: 1,
      shownReasonBucketCount: 1,
      omittedReasonBucketCount: 0,
    });
    expect(diagnostic(
      quality, 'strict_event_dynamic_candidate_quality',
    )).toMatchObject({
      eventCandidateNodeCount: 3,
      dynamicEventEdgeCount: 4,
      variableRecoverableCount: 4,
      nonVariableRecoverableCount: 0,
    });
    expect(diagnostic(
      quality, 'strict_event_publication_without_subscription_quality',
    )).toMatchObject({ unmatchedPublicationCount: 0 });
    expect(diagnostic(
      quality, 'strict_event_subscription_without_publication_quality',
    )).toMatchObject({ unmatchedSubscriptionCount: 2 });
    expect(diagnostic(
      quality, 'strict_event_receiver_classification_quality',
    )).toMatchObject({
      eventTotal: 4,
      proven: 4,
      questionable: 0,
      reasonBucketCount: 0,
      shownReasonBucketCount: 0,
      omittedReasonBucketCount: 0,
    });
    expect(diagnostic(
      quality, 'strict_event_shape_environment_quality',
    )).toMatchObject({
      skeletonCandidateCount: 1,
      environmentBindingAmbiguityCount: 0,
    });
    const before = semanticEventEdges(db);
    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    expect(semanticEventEdges(db)).toEqual(before);
    db.close();
  });

  it('refuses excessive link-time shape fan-out without truncating', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-shape-cap-'));
    const registrations = Array.from({ length: 101 }, () =>
      "  bus.on(`${code}RecordStored`, handleRecordStored);").join('\n');
    await Promise.all([
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/shape-cap-publisher')),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export async function publish(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${code}RecordStored\`, {});
}
`),
      writeFixtureFile(root, 'subscriber/.git-fixture'),
      writeFixtureFile(root, 'subscriber/package.json',
        packageJson('@neutral/shape-cap-subscriber')),
      writeFixtureFile(root, 'subscriber/src/subscribe.ts', `
import cds from '@sap/cds';
export function handleRecordStored(): void {}
export async function subscribe(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
${registrations}
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked).toMatchObject({
      eventShapeCandidateCount: 0,
      eventShapeCandidateOmittedCount: 101,
    });
    const candidates = db.prepare(`SELECT evidence_json evidence
      FROM graph_edges
      WHERE edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
      ORDER BY id`).all();
    expect(candidates).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) count FROM diagnostics
      WHERE code='event_shape_candidate_expansion_refused'`).get())
      .toEqual({ count: 1 });
    db.close();
  });

  it('keeps one payload-routed site dynamic and exposes every shape destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-payload-'));
    await writePayloadSplitFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.eventShapeCandidateCount).toBe(2);
    const publication = eventCalls(db).find((call) =>
      call.eventName === '${mode}StoredOutcome');
    expect(publication).toMatchObject({
      reason: 'dynamic_event_name_identifier',
    });
    const result = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    });
    const destinations = result.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber')
      .map((edge) => String(edge.evidence?.subscriptionRepositoryName));
    expect(destinations).toEqual(['subscriber-x', 'subscriber-y']);
    expect(result.edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler')).toBe(false);
    const capped = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 1,
    });
    expect(capped.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber')).toHaveLength(1);
    expect(diagnostic(
      capped.diagnostics, 'event_shape_candidates_omitted',
    )).toMatchObject({
      candidateCount: 2,
      shownCandidateCount: 1,
      omittedCandidateCount: 1,
      maxDynamicCandidates: 1,
    });
    expect(renderTraceTable(capped)).toContain(
      'candidates: 1 shown, 1 omitted, 2 total; effective cap 1',
    );
    const compact = traceAndCompact(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 1,
    }).compact;
    expect(compact.diagnostics.find((row) =>
      row[2] === 'event_shape_candidates_omitted')?.[6]).toMatchObject({
      candidateCount: 2,
      shownCandidateCount: 1,
      omittedCandidateCount: 1,
      maxDynamicCandidates: 1,
    });
    db.close();
  });

  it('reports loop registration multiplicity without inventing unknown counts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-loop-'));
    await writeLoopSubscriptionFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const subscriptions = eventCalls(db).filter((call) =>
      parsedRecord(call.evidenceJson).handlerReferenceStatus === 'role_required');
    expect(subscriptions).toHaveLength(2);
    expect(parsedRecord(subscriptions[0]?.evidenceJson ?? '')).toMatchObject({
      subscriptionLoopRegistrationStatus: 'enumerated',
      subscriptionLoopRegistrationCount: 3,
    });
    expect(parsedRecord(subscriptions[1]?.evidenceJson ?? '')).toMatchObject({
      subscriptionLoopRegistrationStatus: 'unresolved',
    });

    linkWorkspace(db, workspaceId);
    expect(subscriptionEdges(db)).toHaveLength(4);
    expect(diagnostic(
      doctorDiagnostics(db, true, { workspaceId }),
      'strict_event_subscription_without_publication_quality',
    )).toMatchObject({
      unmatchedSubscriptionCount: 3,
      unmatchedSubscriptionSiteCount: 2,
      unknownMultiplicitySiteCount: 1,
      exampleCount: 2,
    });
    db.close();
  });

  it('refuses duplicated package constant containers without choosing one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-duplicate-'));
    await writePackageConstantFixture(root);
    await Promise.all([
      writeFixtureFile(root, 'topics-duplicate/.git-fixture'),
      writeFixtureFile(root, 'topics-duplicate/package.json', packageJson(
        '@neutral/event-topics',
        { exports: { '.': './src/index.ts' } },
      )),
      writeFixtureFile(root, 'topics-duplicate/src/index.ts', `
export const TOPICS = { FLOW_READY: 'WrongNeutralFlowReady' } as const;
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    expect(eventCalls(db).find((call) =>
      call.eventName === 'TOPICS.FLOW_READY')).toMatchObject({
      reason: 'event_name_constant_container_ambiguous',
    });
    expect(eventEdges(db).some((edge) =>
      edge.edgeType === 'HANDLER_EMITS_EVENT'
      && edge.toId === 'NeutralFlowReady')).toBe(false);
    db.close();
  });

  it('binds allowlisted environment values per consumer and rejects collisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-env-'));
    await writeEnvironmentFixture(root);
    const { db, workspaceId } = await prepareWorkspace(
      root, ['SHARD_CODE'],
    );
    linkWorkspace(db, workspaceId);
    const edges = subscriptionEdges(db);
    expect(edges.filter((edge) =>
      edge.fromId === 'NEUTRALONERecordStored'))
      .toEqual([
        expect.objectContaining({ status: 'resolved' }),
      ]);
    expect(edges.filter((edge) =>
      edge.fromId === 'NEUTRALTWORecordStored'))
      .toHaveLength(2);
    for (const edge of edges.filter((item) =>
      item.fromId === 'NEUTRALTWORecordStored')) {
      expect(edge).toMatchObject({
        status: 'ambiguous',
        reason: 'event_environment_value_collision',
      });
    }
    const serializedFacts = JSON.stringify(db.prepare(`SELECT
      environment_declarations_json environmentJson FROM repositories
      ORDER BY id`).all());
    expect(serializedFacts).not.toContain('PRIVATE_TOKEN');
    expect(serializedFacts).not.toContain('must-not-persist');

    const quality = doctorDiagnostics(db, true, { workspaceId });
    expect(diagnostic(
      quality, 'strict_event_subscription_without_publication_quality',
    )).toMatchObject({ unmatchedSubscriptionCount: 1 });
    expect(diagnostic(
      quality, 'strict_event_shape_environment_quality',
    )).toMatchObject({ environmentBindingAmbiguityCount: 2 });
    const collisionTrace = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
    });
    const ambiguousTransitions = collisionTrace.edges.filter((edge) =>
      edge.type === 'event_name_matches_subscription_handler'
      && edge.from === 'NEUTRALTWORecordStored');
    expect(ambiguousTransitions).toHaveLength(1);
    for (const edge of ambiguousTransitions)
      expect(edge.evidence).toMatchObject({
        resolutionStatus: 'ambiguous',
        bodyExpansion: 'not_resolved',
        dispatchProvenanceCount: 2,
        shownDispatchProvenanceCount: 2,
        omittedDispatchProvenanceCount: 0,
      });
    const candidateTrace = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    });
    const shapeCandidates = candidateTrace.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber');
    expect(shapeCandidates).toHaveLength(1);
    expect(shapeCandidates[0]?.evidence).toMatchObject({
      deploymentScope: 'environment_key_unshared',
      deploymentComparisonStatus: 'not_possible',
      deploymentComparisonReasons: [
        'publisher_and_subscriber_environment_keys_unshared',
      ],
      deploymentCount: 3,
      shownDeploymentCount: 3,
      omittedDeploymentCount: 0,
      deploymentRepositories: [
        expect.objectContaining({ repositoryName: 'consumer-a' }),
        expect.objectContaining({ repositoryName: 'consumer-b' }),
        expect.objectContaining({ repositoryName: 'consumer-c' }),
      ],
    });

    await writeFixtureFile(root, 'consumer-a/nodemon.json', JSON.stringify({
      env: {
        SHARD_CODE: 'neutralthree',
        PRIVATE_TOKEN: 'still-never-store-this',
      },
    }));
    const indexed = await indexWorkspace(db, workspaceId, {
      repo: 'consumer-a', force: false,
      eventEnvironmentKeys: ['SHARD_CODE'],
    });
    expect(indexed.skippedCount).toBe(0);
    expect(db.prepare(`SELECT graph_stale_reason reason FROM repositories
      WHERE name='consumer-a'`).get()).toMatchObject({
      reason: 'facts_changed',
    });
    linkWorkspace(db, workspaceId);
    const updated = subscriptionEdges(db);
    expect(updated.some((edge) =>
      edge.fromId === 'NEUTRALONERecordStored'))
      .toBe(false);
    expect(updated.some((edge) =>
      edge.fromId === 'NEUTRALTHREERecordStored'
      && edge.status === 'resolved'))
      .toBe(true);
    db.close();
  });

  it('does not treat development declarations as deployment containment proof', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'sf-event-env-scope-'),
    );
    await writeEnvironmentFixture(root);
    await writeFixtureFile(root, 'publisher/nodemon.json', JSON.stringify({
      env: { SHARD_CODE: 'neutralone' },
    }));
    await writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
const publishCode = process.env.SHARD_CODE;
export async function publish(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${publishCode.toUpperCase()}RecordStored\`, {});
}
`);
    const { db, workspaceId } = await prepareWorkspace(
      root, ['SHARD_CODE'],
    );
    const linked = linkWorkspace(db, workspaceId);

    expect(linked.eventShapeCandidateCount).toBe(1);
    const consumers = db.prepare(`SELECT
      json_extract(evidence_json,
        '$.deploymentRepositories[0].repositoryName') consumer,
      json_extract(evidence_json,'$.deploymentScope') deploymentScope
      FROM graph_edges
      WHERE edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
      ORDER BY consumer COLLATE BINARY`).all();
    expect(consumers).toEqual([
      {
        consumer: 'consumer-a',
        deploymentScope: 'mixed_environment_scope',
      },
    ]);
    const deployments = db.prepare(`SELECT
      json_extract(json_each.value,'$.repositoryName') consumer,
      json_extract(json_each.value,'$.scope') deploymentScope,
      json_extract(json_each.value,'$.comparisonStatus') comparisonStatus,
      json_extract(json_each.value,'$.comparisonReason') comparisonReason
      FROM graph_edges,
      json_each(graph_edges.evidence_json,'$.deploymentRepositories')
      WHERE edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
      ORDER BY consumer COLLATE BINARY`).all();
    expect(deployments).toEqual([
      {
        consumer: 'consumer-a',
        deploymentScope:
          'shared_environment_value_equal_non_authoritative',
        comparisonStatus: 'compared_non_authoritative_equal',
        comparisonReason: 'development_environment_is_not_deployment_proof',
      },
      {
        consumer: 'consumer-b',
        deploymentScope:
          'shared_environment_value_mismatch_non_authoritative',
        comparisonStatus: 'compared_non_authoritative_mismatch',
        comparisonReason: 'development_environment_is_not_deployment_proof',
      },
      {
        consumer: 'consumer-c',
        deploymentScope:
          'shared_environment_value_mismatch_non_authoritative',
        comparisonStatus: 'compared_non_authoritative_mismatch',
        comparisonReason: 'development_environment_is_not_deployment_proof',
      },
    ]);
    expect(db.prepare(`SELECT COUNT(*) count FROM diagnostics
      WHERE code='event_shape_candidate_expansion_refused'`).get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('rejects a mismatch proven by deployment descriptors on both sides', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'sf-event-env-deployment-scope-'),
    );
    await writeEnvironmentLibrary(root);
    await writeEnvironmentConsumerWithoutDeclaration(root, 'consumer-a');
    await Promise.all([
      writeFixtureFile(root, 'consumer-a/manifest.yml', `
applications:
  - name: neutral-consumer
    env:
      SHARD_CODE: neutraltwo
`),
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/environment-publisher')),
      writeFixtureFile(root, 'publisher/manifest.yml', `
applications:
  - name: neutral-publisher
    env:
      SHARD_CODE: neutralone
`),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
const publishCode = process.env.SHARD_CODE;
export async function publish(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${publishCode.toUpperCase()}RecordStored\`, {});
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(
      root, ['SHARD_CODE'],
    );
    const linked = linkWorkspace(db, workspaceId);

    expect(linked.eventShapeCandidateCount).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'`).get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('collapses missing deployment bindings instead of multiplying unresolved handlers', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'sf-event-env-refusal-'),
    );
    await writeEnvironmentLibrary(root);
    await Promise.all([
      writeEnvironmentConsumer(root, 'consumer-a', 'neutralone'),
      writeEnvironmentConsumer(root, 'consumer-b', 'neutraltwo'),
      writeEnvironmentConsumerWithoutDeclaration(root, 'consumer-missing-a'),
      writeEnvironmentConsumerWithoutDeclaration(root, 'consumer-missing-b'),
      writeEnvironmentConsumerWithoutDeclaration(root, 'consumer-missing-c'),
      writeFixtureFile(root, 'publisher/.git-fixture'),
      writeFixtureFile(root, 'publisher/package.json',
        packageJson('@neutral/environment-publisher')),
      writeFixtureFile(root, 'publisher/src/publish.ts', `
import cds from '@sap/cds';
export async function publish(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(\`\${code}RecordStored\`, {});
}
`),
    ]);
    const { db, workspaceId } = await prepareWorkspace(
      root, ['SHARD_CODE'],
    );
    const linked = linkWorkspace(db, workspaceId);

    expect(linked).toMatchObject({
      subscriptionHandlerResolvedCount: 2,
      subscriptionHandlerUnresolvedCount: 1,
      eventShapeCandidateCount: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
        AND unresolved_reason=
          'event_environment_consumer_expansion_incomplete'`).get())
      .toEqual({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) count FROM diagnostics
      WHERE code=
        'event_environment_consumer_expansion_incomplete'`).get())
      .toEqual({ count: 1 });
    const consumers = db.prepare(`SELECT json_extract(json_each.value,
      '$.repositoryName') consumer FROM graph_edges,
      json_each(graph_edges.evidence_json,'$.deploymentRepositories')
      WHERE edge_type='EVENT_SHAPE_CANDIDATE_SUBSCRIBER'
      ORDER BY consumer COLLATE BINARY`).all();
    expect(consumers).toEqual([
      { consumer: null },
      { consumer: 'consumer-a' },
      { consumer: 'consumer-b' },
    ]);
    db.close();
  });

  it('reindexes environment facts with a workspace-configured key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-env-key-'));
    await writeEnvironmentLibrary(root, 'TENANT_CODE');
    await writeEnvironmentConsumer(
      root, 'consumer-a', 'neutralcustom', 'TENANT_CODE',
    );
    const { db, workspaceId } = await prepareWorkspace(root);
    expect(eventCalls(db).find((call) =>
      call.eventName.includes('RecordStored'))?.skeletonJson)
      .not.toContain('TENANT_CODE');

    const indexed = await indexWorkspace(db, workspaceId, {
      force: false,
      eventEnvironmentKeys: ['TENANT_CODE', 'UNUSED_CODE'],
    });
    expect(indexed.failedCount).toBe(0);
    expect(indexed.skippedCount).toBe(0);
    linkWorkspace(db, workspaceId);
    expect(subscriptionEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromId: 'NEUTRALCUSTOMRecordStored',
        status: 'resolved',
      }),
    ]));
    const environmentRows = db.prepare(`SELECT
      environment_declarations_json value FROM repositories
      ORDER BY name COLLATE BINARY`).all();
    expect(JSON.stringify(environmentRows)).toContain('TENANT_CODE');
    expect(JSON.stringify(environmentRows)).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(environmentRows))
      .not.toContain('must-not-persist-consumer-a');
    const rawEnvironment = await readFile(
      path.join(root, 'consumer-a/nodemon.json'), 'utf8',
    );
    const rawHash = createHash('sha256').update(rawEnvironment).digest('hex');
    const storedFile = db.prepare(`SELECT f.sha256
      FROM files f JOIN repositories r ON r.id=f.repo_id
      WHERE r.name='consumer-a' AND f.relative_path='nodemon.json'`).get();
    expect(storedFile?.sha256).not.toBe(rawHash);
    expect(diagnostic(
      doctorDiagnostics(db, true, { workspaceId }),
      'strict_event_environment_configuration_quality',
    )).toMatchObject({
      severity: 'warning',
      configuredKeys: ['TENANT_CODE', 'UNUSED_CODE'],
      unmatchedKeys: ['UNUSED_CODE'],
      unmatchedKeyCount: 1,
      matches: [
        { key: 'TENANT_CODE', declarationCount: 1 },
        { key: 'UNUSED_CODE', declarationCount: 0 },
      ],
    });
    db.close();
  });
});
