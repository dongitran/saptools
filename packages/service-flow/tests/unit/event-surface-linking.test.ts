import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { traceAndCompact } from '../../src/trace/compact-trace.js';
import { trace } from '../../src/trace/trace-engine.js';
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
import { TOPICS } from '@neutral/event-topics';
function buildThing(): { emit(name: string, payload: unknown): void } {
  return { emit(): void {} };
}
export async function publishJob(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  await bus.emit(TOPICS.FLOW_READY, {});
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

async function writeEnvironmentLibrary(root: string): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, 'subscriber-lib/.git-fixture'),
    writeFixtureFile(root, 'subscriber-lib/package.json',
      packageJson('@neutral/environment-subscriber')),
    writeFixtureFile(root, 'subscriber-lib/src/env.ts',
      'export const envCode = process.env.SHARD_CODE;\n'),
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
): Promise<void> {
  await Promise.all([
    writeFixtureFile(root, `${name}/.git-fixture`),
    writeFixtureFile(root, `${name}/package.json`, packageJson(
      `@neutral/${name}`,
      { dependencies: { '@neutral/environment-subscriber': '1.0.0' } },
    )),
    writeFixtureFile(root, `${name}/nodemon.json`, JSON.stringify({
      env: {
        SHARD_CODE: value,
        PRIVATE_TOKEN: `must-not-persist-${name}`,
      },
    })),
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
    expect(eventEdges(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'DYNAMIC_EDGE_CANDIDATE',
        status: 'dynamic',
        toKind: 'event_candidate',
        toId: 'Event: NotCap',
        reason: 'event_receiver_not_cap_client',
      }),
    ]));
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
      proven: 2,
      nameFallback: 0,
      unproven: 1,
      questionable: 1,
    });
    await writeFixtureFile(root, 'topics/src/index.ts', `
export const TOPICS = { FLOW_READY: 'NeutralFlowRestarted' } as const;
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
    expect(strict.edges.some((edge) =>
      edge.type === 'event_shape_candidate_subscriber')).toBe(false);
    expect(diagnostic(
      strict.diagnostics, 'trace_runtime_variables_missing',
    ).missingVariables).toEqual(expect.arrayContaining([
      'publishCode', 'subscribeCode', canonicalKey,
    ]));

    const candidates = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    });
    const shapeEdges = candidates.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber');
    expect(shapeEdges).toHaveLength(1);
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
      quality, 'strict_event_name_resolution_quality',
    )).toMatchObject({
      publicationTotal: 2,
      unresolvedPublicationCount: 2,
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
    expect(subscriptionEdges(db)).toHaveLength(2);
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
    const { db, workspaceId } = await prepareWorkspace(root);
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
    expect(ambiguousTransitions).toHaveLength(2);
    for (const edge of ambiguousTransitions)
      expect(edge.evidence).toMatchObject({
        resolutionStatus: 'ambiguous',
        bodyExpansion: 'not_resolved',
      });
    const candidateTrace = trace(db, { repo: 'publisher' }, {
      depth: 8, workspaceId, includeAsync: true,
      dynamicMode: 'candidates', maxDynamicCandidates: 5,
    });
    expect(candidateTrace.edges.filter((edge) =>
      edge.type === 'event_shape_candidate_subscriber')
      .map((edge) => String(
        edge.evidence.subscriptionConsumerRepositoryName,
      ))).toEqual(['consumer-a', 'consumer-b', 'consumer-c']);

    await writeFixtureFile(root, 'consumer-a/nodemon.json', JSON.stringify({
      env: {
        SHARD_CODE: 'neutralthree',
        PRIVATE_TOKEN: 'still-never-store-this',
      },
    }));
    const indexed = await indexWorkspace(db, workspaceId, {
      repo: 'consumer-a', force: false,
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
});
