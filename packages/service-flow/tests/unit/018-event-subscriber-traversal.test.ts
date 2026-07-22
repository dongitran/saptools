import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import type { ContextBinding } from '../../src/trace/008-contextual-runtime-state.js';
import { TraversalScopeScheduler,
  type TraversalScopeIdentity } from '../../src/trace/010-traversal-scope.js';
import { enqueueCausalScope, type PendingTraceRootScope,
  type TraceQueueScope } from '../../src/trace/013-trace-root-scopes.js';
import { trace } from '../../src/trace/trace-engine.js';
import type { TraceEdge, TraceOptions, TraceResult } from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

interface EventTraceFixture {
  db: Db;
  workspaceId: number;
}

let fixture: EventTraceFixture | undefined;
let asymmetricFixture: EventTraceFixture | undefined;

function fixtureState(): EventTraceFixture {
  if (!fixture) throw new Error('Event trace fixture was not initialized');
  return fixture;
}

function asymmetricFixtureState(): EventTraceFixture {
  if (!asymmetricFixture)
    throw new Error('Asymmetric trace fixture was not initialized');
  return asymmetricFixture;
}

function traceMain(overrides: Partial<TraceOptions> = {}): TraceResult {
  const current = fixtureState();
  return trace(current.db, { repo: 'event-app', handler: 'start' }, {
    depth: 20,
    workspaceId: current.workspaceId,
    includeAsync: true,
    includeDb: true,
    includeExternal: true,
    ...overrides,
  });
}

function traceSubscribeOnly(includeAsync: boolean): TraceResult {
  const current = fixtureState();
  return trace(current.db, { repo: 'event-app', handler: 'subscribeOnly' }, {
    depth: 10,
    workspaceId: current.workspaceId,
    includeAsync,
    includeDb: true,
    includeExternal: true,
  });
}

function traceRepo(overrides: Partial<TraceOptions> = {}): TraceResult {
  const current = fixtureState();
  return trace(current.db, { repo: 'event-app' }, {
    depth: 20,
    workspaceId: current.workspaceId,
    includeAsync: true,
    includeDb: true,
    includeExternal: true,
    ...overrides,
  });
}

function eventBridges(result: TraceResult, eventName: string): TraceEdge[] {
  return result.edges.filter((edge) =>
    edge.type === 'event_name_matches_subscription_handler'
      && edge.evidence.eventName === eventName);
}

function downstreamEntityCount(result: TraceResult, entity: string): number {
  return result.edges.filter((edge) =>
    edge.type === 'local_db_query' && edge.to === `Entity: ${entity}`).length;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventRegistrationSource(index: number): string {
  const registrations = [
    index <= 2 ? `messaging.on('FanoutTwo', fanoutTwo${index});` : '',
    index <= 3 ? `messaging.on('FanoutThree', fanoutThree${index});` : '',
    `messaging.on('FanoutSeven', fanoutSeven${index});`,
  ].filter(Boolean).join('\n');
  return `import { fanoutTwo${index}, fanoutThree${index}, fanoutSeven${index} } from './fanout-handlers.js';
${registrations}
`;
}

function fanoutHandlerSource(): string {
  const handlers: string[] = [];
  for (let index = 1; index <= 7; index += 1) {
    handlers.push(`export async function fanoutSeven${index}(): Promise<void> {
  await cds.run(SELECT.from(FanoutSeven${index}Rows));
}`);
    if (index <= 3) handlers.push(`export async function fanoutThree${index}(): Promise<void> {
  await cds.run(SELECT.from(FanoutThree${index}Rows));
}`);
    if (index <= 2) handlers.push(`export async function fanoutTwo${index}(): Promise<void> {
  await cds.run(SELECT.from(FanoutTwo${index}Rows));
}`);
  }
  return `import cds from '@sap/cds';\n${handlers.join('\n')}\n`;
}

async function writeEventApp(root: string): Promise<void> {
  await writeFixtureFile(root, 'event-app/.git-fixture');
  await writeFixtureFile(root, 'event-app/package.json', JSON.stringify({
    name: 'event-app',
    version: '1.0.0',
    dependencies: { '@neutral/ambiguous-handlers': '1.0.0' },
    cds: { requires: { target: { kind: 'odata-v4',
      credentials: { path: '/TargetService', destination: 'target-destination' } } } },
  }));
  await writeFixtureFile(root, 'event-app/srv/event.cds',
    'service EventService { action start(); action subscribeOnly(); action rootCycle(); action lateEmit(); action depthStart(); action depthSubscriber(); }');
  await writeFixtureFile(root, 'event-app/src/A-EarlySubscriber.ts', earlySubscriberSource);
  await writeFixtureFile(root, 'event-app/src/DepthRootHandler.ts', depthRootHandlerSource);
  await writeFixtureFile(root, 'event-app/src/depth-leaf.ts', depthLeafSource);
  await writeFixtureFile(root, 'event-app/src/EntryHandler.ts', entryHandlerSource);
  await writeFixtureFile(root, 'event-app/src/RootCycleHandler.ts', rootCycleHandlerSource);
  await writeFixtureFile(root, 'event-app/src/Z-LateEmitterHandler.ts', lateEmitterSource);
  await writeFixtureFile(root, 'event-app/src/subscribers.ts', subscriberSource);
  await writeFixtureFile(root, 'event-app/src/context-emitter.ts', contextEmitterSource);
  await writeFixtureFile(root, 'event-app/src/register-base.ts', registrationSource);
  await writeFixtureFile(root, 'event-app/src/register-root-cycle.ts', rootCycleRegistrationSource);
  await writeFixtureFile(root, 'event-app/src/register-depth.ts', depthRegistrationSource);
  await writeFixtureFile(root, 'event-app/src/register-late.ts', lateRegistrationSource);
  await writeFixtureFile(root, 'event-app/src/fanout-handlers.ts', fanoutHandlerSource());
  await writeFixtureFile(root, 'event-app/src/server.ts', serverSource);
  await writeFixtureFile(root, 'event-app/src/unowned.ts', unownedCallSource);
  for (let index = 1; index <= 7; index += 1)
    await writeFixtureFile(root, `event-app/src/register-fanout-${index}.ts`,
      eventRegistrationSource(index));
}

async function writeAmbiguousHandlers(root: string): Promise<void> {
  await writeFixtureFile(root, 'ambiguous-handlers/.git-fixture');
  await writeFixtureFile(root, 'ambiguous-handlers/package.json', JSON.stringify({
    name: '@neutral/ambiguous-handlers', version: '1.0.0',
  }));
  for (const suffix of ['a', 'b'])
    await writeFixtureFile(root, `ambiguous-handlers/src/${suffix}.ts`,
      `export function ambiguousHandler(): void { void '${suffix}'; }\n`);
}

async function writeTargetService(root: string): Promise<void> {
  await writeFixtureFile(root, 'target-service/.git-fixture');
  await writeFixtureFile(root, 'target-service/package.json', JSON.stringify({
    name: 'target-service', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'target-service/srv/target.cds',
    "@path:'/TargetService' service TargetService { action consume(); }");
  await writeFixtureFile(root, 'target-service/src/TargetHandler.ts', `
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class TargetHandler {
  @Action('consume')
  consume(): void {}
}
`);
  await writeFixtureFile(root, 'target-service/src/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { TargetHandler } from './TargetHandler.js';
createCombinedHandler({ handler: [TargetHandler] });
`);
}

async function createEventTraceFixture(root: string): Promise<void> {
  await writeEventApp(root);
  await writeAmbiguousHandlers(root);
  await writeTargetService(root);
}

async function writeAsymmetricApp(root: string): Promise<void> {
  await writeFixtureFile(root, 'asymmetric-app/.git-fixture');
  await writeFixtureFile(root, 'asymmetric-app/package.json', JSON.stringify({
    name: 'asymmetric-app', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'asymmetric-app/srv/event.cds',
    'service AsymmetricService { action asymmetricLong(); action asymmetricShort(); }');
  await writeFixtureFile(root, 'asymmetric-app/src/AsymmetricRootHandler.ts',
    asymmetricRootHandlerSource);
  await writeFixtureFile(root, 'asymmetric-app/src/asymmetric-shared.ts',
    asymmetricSharedSource);
  await writeFixtureFile(root, 'asymmetric-app/src/register.ts', `
import { triggerSubscriber } from './asymmetric-shared.js';
messaging.on('AsymmetricTrigger', triggerSubscriber);
`);
  await writeFixtureFile(root, 'asymmetric-app/src/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { AsymmetricRootHandler } from './AsymmetricRootHandler.js';
createCombinedHandler({ handler: [AsymmetricRootHandler] });
`);
}

const entryHandlerSource = `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
import { emitWithContext } from './context-emitter.js';
import { reverseHandler } from './subscribers.js';

@Handler()
export class EntryHandler {
  @Action('start')
  async start(): Promise<void> {
    const messaging = await cds.connect.to('messaging');
    await messaging.emit('FunctionEvent', {});
    await messaging.emit('StaticEvent', {});
    await messaging.emit('FanoutTwo', {});
    await messaging.emit('FanoutThree', {});
    await messaging.emit('FanoutSeven', {});
    await messaging.emit('DuplicateEvent', {});
    await messaging.emit('NoSubscriber', {});
    await messaging.emit('OrderFailed', {});
    await messaging.emit('UnresolvedEvent', {});
    await messaging.emit('AmbiguousEvent', {});
    await messaging.emit('MissingEvent', {});
    await messaging.emit('LoopSelf', {});
    await messaging.emit('LoopA', {});
    const client = await cds.connect.to('target');
    await emitWithContext(client);
  }

  @Action('subscribeOnly')
  async subscribeOnly(): Promise<void> {
    const queue = await cds.connect.to('messaging');
    queue.on('ReverseEvent', reverseHandler);
  }
}
`;

const subscriberSource = `
import cds from '@sap/cds';

export async function functionSubscriber(): Promise<void> {
  await cds.run(SELECT.from(FunctionRows));
  await fetch('https://example.invalid/function');
}

export class StaticSubscriber {
  static async handle(): Promise<void> {
    await cds.run(SELECT.from(StaticRows));
  }
}

export async function duplicateSubscriber(): Promise<void> {
  await cds.run(SELECT.from(DuplicateRows));
}

export async function caseSubscriber(): Promise<void> {
  await cds.run(SELECT.from(CaseMismatchRows));
}

export async function reverseHandler(): Promise<void> {
  await cds.run(SELECT.from(ReverseRows));
}

export async function selfSubscriber(): Promise<void> {
  await cds.run(SELECT.from(SelfRows));
  await messaging.emit('LoopSelf', {});
}

export async function loopA(): Promise<void> {
  await cds.run(SELECT.from(LoopARows));
  await messaging.emit('LoopB', {});
}

export async function loopB(): Promise<void> {
  await cds.run(SELECT.from(LoopBRows));
  await messaging.emit('LoopA', {});
}

export async function contextSubscriber(client: { send(input: unknown): Promise<unknown> }): Promise<void> {
  await client.send({ method: 'POST', path: '/consume' });
}
`;

const contextEmitterSource = `
export async function emitWithContext(client: unknown): Promise<void> {
  void client;
  await messaging.emit('ContextEvent', {});
}
`;

const rootCycleHandlerSource = `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';

@Handler()
export class RootCycleHandler {
  @Action('rootCycle')
  async rootCycle(): Promise<void> {
    await cds.run(SELECT.from(RootCycleRows));
    await messaging.emit('RootCycle', {});
  }
}
`;

const rootCycleRegistrationSource = `
import { RootCycleHandler } from './RootCycleHandler.js';
messaging.on('RootCycle', RootCycleHandler.rootCycle);
`;

const depthRootHandlerSource = `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
import { depthLeaf } from './depth-leaf.js';

@Handler()
export class DepthRootHandler {
  @Action('depthStart')
  async depthStart(): Promise<void> {
    await messaging.emit('DepthRoot', {});
  }

  @Action('depthSubscriber')
  async depthSubscriber(): Promise<void> {
    await cds.run(SELECT.from(DepthSubscriberRows));
    await depthLeaf();
  }
}
`;

const depthLeafSource = `
import cds from '@sap/cds';
export async function depthLeaf(): Promise<void> {
  await cds.run(SELECT.from(DepthLeafRows));
}
`;

const asymmetricRootHandlerSource = `
import { Action, Handler } from 'cds-routing-handlers';
import { longMid, sharedTarget } from './asymmetric-shared.js';

@Handler()
export class AsymmetricRootHandler {
  @Action('asymmetricLong')
  async asymmetricLong(): Promise<void> {
    await longMid();
    await messaging.emit('AsymmetricTrigger', {});
  }

  @Action('asymmetricShort')
  async asymmetricShort(): Promise<void> {
    await sharedTarget();
  }
}
`;

const asymmetricSharedSource = `
import cds from '@sap/cds';

export async function longMid(): Promise<void> {
  await sharedTarget();
}

export async function sharedTarget(): Promise<void> {
  await sharedLeaf();
}

export async function sharedLeaf(): Promise<void> {
  await cds.run(SELECT.from(AsymmetricLeafRows));
}

export async function triggerSubscriber(): Promise<void> {
  await cds.run(SELECT.from(AsymmetricTriggerRows));
}
`;

const depthRegistrationSource = `
import { DepthRootHandler } from './DepthRootHandler.js';
messaging.on('DepthRoot', DepthRootHandler.depthSubscriber);
`;

const earlySubscriberSource = `
import cds from '@sap/cds';
export async function earlySubscriber(): Promise<void> {
  await cds.run(SELECT.from(EarlyRows));
}
`;

const lateEmitterSource = `
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class LateEmitterHandler {
  @Action('lateEmit')
  async lateEmit(): Promise<void> {
    await messaging.emit('LateEvent', {});
  }
}
`;

const lateRegistrationSource = `
import { earlySubscriber } from './A-EarlySubscriber.js';
messaging.on('LateEvent', earlySubscriber);
`;

const unownedCallSource = `
void fetch('https://example.invalid/unowned');
`;

const registrationSource = `
import { ambiguousHandler } from '@neutral/ambiguous-handlers';
import { missingHandler } from './missing-handler.js';
import {
  StaticSubscriber, caseSubscriber, contextSubscriber, duplicateSubscriber,
  functionSubscriber, loopA, loopB, selfSubscriber,
} from './subscribers.js';

messaging.on('FunctionEvent', functionSubscriber);
messaging.on('StaticEvent', StaticSubscriber.handle);
messaging.on('DuplicateEvent', duplicateSubscriber);
messaging.on('DuplicateEvent', duplicateSubscriber);
messaging.on('Orderfailed', caseSubscriber);
messaging.on('UnresolvedEvent', missingHandler);
messaging.on('AmbiguousEvent', ambiguousHandler);
messaging.on('MissingEvent', () => undefined);
messaging.on('LoopSelf', selfSubscriber);
messaging.on('LoopA', loopA);
messaging.on('LoopB', loopB);
messaging.on('ContextEvent', contextSubscriber);
`;

const serverSource = `
import { createCombinedHandler } from 'cds-routing-handlers';
import { DepthRootHandler } from './DepthRootHandler.js';
import { EntryHandler } from './EntryHandler.js';
import { RootCycleHandler } from './RootCycleHandler.js';
import { LateEmitterHandler } from './Z-LateEmitterHandler.js';
createCombinedHandler({ handler: [DepthRootHandler, EntryHandler, RootCycleHandler, LateEmitterHandler] });
`;

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-event-trace-'));
  const asymmetricRoot = await mkdtemp(path.join(
    os.tmpdir(), 'service-flow-asymmetric-trace-',
  ));
  await createEventTraceFixture(root);
  await writeAsymmetricApp(asymmetricRoot);
  const prepared = await prepareWorkspace(root);
  const asymmetricPrepared = await prepareWorkspace(asymmetricRoot);
  linkWorkspace(prepared.db, prepared.workspaceId);
  linkWorkspace(asymmetricPrepared.db, asymmetricPrepared.workspaceId);
  fixture = prepared;
  asymmetricFixture = asymmetricPrepared;
}, 30_000);

afterAll(() => {
  fixture?.db.close();
  asymmetricFixture?.db.close();
});

describe('event subscriber trace traversal', () => {
  it('excludes handler-role calls from synchronous traversal and never reverses subscriptions', () => {
    const withoutAsync = traceSubscribeOnly(false);
    expect(withoutAsync.edges.some((edge) =>
      edge.type === 'local_symbol_call' && edge.to.includes('reverseHandler'))).toBe(false);
    expect(downstreamEntityCount(withoutAsync, 'ReverseRows')).toBe(0);

    const withAsync = traceSubscribeOnly(true);
    expect(withAsync.edges.some((edge) => edge.type === 'async_subscribe')).toBe(true);
    expect(withAsync.edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler')).toBe(false);
    expect(downstreamEntityCount(withAsync, 'ReverseRows')).toBe(0);
  });

  it('traverses exact events into generic function and static-method symbols and downstream calls', () => {
    const result = traceMain();
    expect(eventBridges(result, 'FunctionEvent')).toHaveLength(1);
    expect(eventBridges(result, 'StaticEvent')).toHaveLength(1);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'symbol', symbolName: 'functionSubscriber' }),
      expect.objectContaining({ kind: 'symbol', symbolName: 'StaticSubscriber.handle' }),
    ]));
    expect(downstreamEntityCount(result, 'FunctionRows')).toBe(1);
    expect(downstreamEntityCount(result, 'StaticRows')).toBe(1);
    expect(result.edges.some((edge) => edge.type === 'external_http'
      && String(edge.evidence.sourceFile).endsWith('subscribers.ts'))).toBe(true);
  });

  it('orders two-, three-, and seven-way fan-out deterministically', () => {
    const first = traceMain();
    const second = traceMain();
    for (const [eventName, count] of [
      ['FanoutTwo', 2], ['FanoutThree', 3], ['FanoutSeven', 7],
    ] as const) {
      const firstFiles = eventBridges(first, eventName).map((edge) =>
        String(edge.evidence.sourceFile));
      const secondFiles = eventBridges(second, eventName).map((edge) =>
        String(edge.evidence.sourceFile));
      expect(firstFiles).toHaveLength(count);
      expect(firstFiles).toEqual(secondFiles);
      expect(firstFiles).toEqual([...firstFiles].sort());
    }
  });

  it('preserves duplicate registration bridges while expanding a converged body once', () => {
    const result = traceMain();
    const bridges = eventBridges(result, 'DuplicateEvent');
    expect(bridges).toHaveLength(2);
    expect(new Set(bridges.map((edge) => edge.evidence.subscribeCallId)).size).toBe(2);
    expect(bridges.map((edge) => edge.evidence.bodyExpansion)).toEqual([
      'scheduled', 'already_scheduled',
    ]);
    expect(downstreamEntityCount(result, 'DuplicateRows')).toBe(1);
    expect(result.edges.some((edge) => edge.type === 'cycle'
      && bridges.some((bridge) => edge.from === bridge.to))).toBe(false);
  });

  it('leaves missing and case-only subscribers terminal without fabricated diagnostics', () => {
    const result = traceMain();
    expect(eventBridges(result, 'NoSubscriber')).toEqual([]);
    expect(eventBridges(result, 'OrderFailed')).toEqual([]);
    expect(downstreamEntityCount(result, 'CaseMismatchRows')).toBe(0);
    expect(result.diagnostics.some((diagnostic) =>
      JSON.stringify(diagnostic).includes('NoSubscriber'))).toBe(false);
  });

  it('renders unresolved, ambiguous, and missing associations without descending', () => {
    const result = traceMain();
    const expected = [
      ['UnresolvedEvent', 'unresolved'],
      ['AmbiguousEvent', 'ambiguous'],
      ['MissingEvent', 'unresolved'],
    ] as const;
    for (const [eventName, status] of expected) {
      const bridges = eventBridges(result, eventName);
      expect(bridges).toHaveLength(1);
      expect(bridges[0]?.evidence.resolutionStatus).toBe(status);
      expect(bridges[0]?.evidence.bodyExpansion).toBe('not_resolved');
      expect(bridges[0]?.unresolvedReason).toEqual(expect.any(String));
    }
    expect(result.nodes.some((node) => node.symbolName === 'ambiguousHandler')).toBe(false);
  });

  it('terminates self and mutual event cycles while retaining every bridge', () => {
    const result = traceMain();
    const self = eventBridges(result, 'LoopSelf');
    const loopA = eventBridges(result, 'LoopA');
    const loopB = eventBridges(result, 'LoopB');
    expect(self.map((edge) => edge.evidence.bodyExpansion)).toEqual([
      'scheduled', 'cycle_blocked',
    ]);
    expect(loopA.map((edge) => edge.evidence.bodyExpansion)).toEqual([
      'scheduled', 'cycle_blocked',
    ]);
    expect(loopB.map((edge) => edge.evidence.bodyExpansion)).toEqual(['scheduled']);
    expect(result.edges.filter((edge) => edge.type === 'cycle')).toHaveLength(2);
    expect(downstreamEntityCount(result, 'SelfRows')).toBe(1);
    expect(downstreamEntityCount(result, 'LoopARows')).toBe(1);
    expect(downstreamEntityCount(result, 'LoopBRows')).toBe(1);
  });

  it('uses the selected concrete workspace for root-cycle scheduling when no workspace option is supplied', () => {
    const current = fixtureState();
    const start = { repo: 'event-app', handler: 'rootCycle' };
    const options = {
      depth: 10, includeAsync: true, includeDb: true, includeExternal: true,
    };
    const omitted = trace(current.db, start, options);
    const explicit = trace(current.db, start, {
      ...options, workspaceId: current.workspaceId,
    });
    const bridges = eventBridges(omitted, 'RootCycle');
    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.evidence.bodyExpansion).toBe('cycle_blocked');
    expect(downstreamEntityCount(omitted, 'RootCycleRows')).toBe(1);
    expect(omitted.edges.filter((edge) => edge.type === 'async_emit')).toHaveLength(1);
    expect(omitted.edges.filter((edge) => edge.type === 'cycle')).toHaveLength(1);
    expect(renderTraceJson(omitted)).toBe(renderTraceJson(explicit));
  });

  it('decomposes a repo-wide async root without duplicate bodies or masked cycles', () => {
    const result = traceRepo();
    expect(downstreamEntityCount(result, 'FunctionRows')).toBe(1);
    expect(downstreamEntityCount(result, 'DuplicateRows')).toBe(1);
    expect(downstreamEntityCount(result, 'SelfRows')).toBe(1);
    expect(downstreamEntityCount(result, 'LoopARows')).toBe(1);
    expect(downstreamEntityCount(result, 'LoopBRows')).toBe(1);
    expect(downstreamEntityCount(result, 'RootCycleRows')).toBe(1);
    expect(eventBridges(result, 'LoopSelf').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['scheduled', 'cycle_blocked']);
    expect(eventBridges(result, 'LoopA').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['scheduled', 'already_scheduled']);
    expect(eventBridges(result, 'LoopB').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['cycle_blocked']);
    expect(eventBridges(result, 'RootCycle').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['cycle_blocked']);
    expect(eventBridges(result, 'LateEvent').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['already_expanded']);
    expect(result.edges.filter((edge) => edge.type === 'cycle')).toHaveLength(3);
    expect(result.edges.filter((edge) => edge.type === 'external_http'
      && String(edge.evidence.sourceFile).endsWith('unowned.ts'))).toHaveLength(1);
  });

  it('keeps class-wide event traversal causal and observes each subscriber body once', () => {
    const current = fixtureState();
    const result = trace(current.db, { repo: 'event-app', handler: 'EntryHandler' }, {
      depth: 20,
      workspaceId: current.workspaceId,
      includeAsync: true,
      includeDb: true,
      includeExternal: true,
    });
    expect(downstreamEntityCount(result, 'FunctionRows')).toBe(1);
    expect(downstreamEntityCount(result, 'DuplicateRows')).toBe(1);
    expect(downstreamEntityCount(result, 'ReverseRows')).toBe(0);
    expect(eventBridges(result, 'LoopSelf').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['scheduled', 'cycle_blocked']);
    expect(eventBridges(result, 'LoopA').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['scheduled', 'cycle_blocked']);
    expect(result.edges.filter((edge) => edge.type === 'cycle')).toHaveLength(2);
  });

  it('keeps repo-wide depth observations deterministic without event-body duplication', () => {
    const result = traceRepo({ depth: 1 });
    expect(eventBridges(result, 'FunctionEvent').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['depth_limited']);
    expect(downstreamEntityCount(result, 'FunctionRows')).toBe(1);
    expect(result.edges.filter((edge) => edge.type === 'local_db_query'
      && edge.to === 'Entity: FunctionRows').map((edge) => edge.step)).toEqual([1]);
    expect(eventBridges(result, 'LateEvent').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['depth_limited']);
  });

  it('keeps a claimed selected root at its exact causal depth', () => {
    const current = fixtureState();
    const depthTwo = trace(current.db, {
      repo: 'event-app', handler: 'DepthRootHandler',
    }, {
      depth: 2,
      workspaceId: current.workspaceId,
      includeAsync: true,
      includeDb: true,
      includeExternal: true,
    });
    expect(eventBridges(depthTwo, 'DepthRoot').map((edge) =>
      edge.evidence.bodyExpansion)).toEqual(['scheduled']);
    expect(downstreamEntityCount(depthTwo, 'DepthSubscriberRows')).toBe(1);
    expect(downstreamEntityCount(depthTwo, 'DepthLeafRows')).toBe(0);
    expect(depthTwo.edges.filter((edge) => edge.type === 'local_db_query'
      && edge.to === 'Entity: DepthSubscriberRows').map((edge) => edge.step))
      .toEqual([2]);

    const depthThree = trace(current.db, {
      repo: 'event-app', handler: 'DepthRootHandler',
    }, {
      depth: 3,
      workspaceId: current.workspaceId,
      includeAsync: true,
      includeDb: true,
      includeExternal: true,
    });
    expect(depthThree.edges.filter((edge) => edge.type === 'local_db_query'
      && edge.to === 'Entity: DepthLeafRows').map((edge) => edge.step))
      .toEqual([3]);
  });

  it('uses the shortest lazy-root path before applying the depth boundary', () => {
    const current = asymmetricFixtureState();
    const result = trace(current.db, {
      repo: 'asymmetric-app', handler: 'AsymmetricRootHandler',
    }, {
      depth: 3,
      workspaceId: current.workspaceId,
      includeAsync: true,
      includeDb: true,
      includeExternal: true,
    });
    expect(result.edges.filter((edge) => edge.type === 'local_db_query'
      && edge.to === 'Entity: AsymmetricLeafRows').map((edge) => edge.step))
      .toEqual([3]);
    expect(result.edges.filter((edge) => edge.type === 'local_symbol_call'
      && String(edge.to).includes('sharedTarget'))).toHaveLength(2);
  });

  it('claims an empty-context root without rewriting its causal depth', () => {
    const scheduler = new TraversalScopeScheduler();
    const files = new Set(['src/claimed.ts']);
    const symbolIds = new Set([42]);
    const context = new Map<string, ContextBinding>();
    const scheduled = scheduler.schedule({
      workspaceId: 7, repoId: 11, files, symbolIds, context,
    });
    if (scheduled.kind !== 'scheduled')
      throw new Error('Expected empty-context scope to schedule');
    const pendingRoots: PendingTraceRootScope[] = [{
      repoId: 11, files, symbolIds, unownedOnly: false,
      rootObservationOnly: false,
    }];
    const queue: TraceQueueScope[] = [];
    enqueueCausalScope(queue, pendingRoots, {
      repoId: 11, files, symbolIds, depth: 3, context,
      state: scheduled.state,
    });
    expect(queue.map((scope) => scope.depth)).toEqual([3]);
    expect(pendingRoots).toHaveLength(0);
  });

  it('detects observed cycles by evaluation path without splicing contexts', () => {
    const empty = new Map<string, ContextBinding>();
    const scheduler = new TraversalScopeScheduler();
    const scope = (
      symbolId: number,
      context = empty,
    ): TraversalScopeIdentity => ({
      workspaceId: 7, repoId: 11, files: new Set(['src/cycle.ts']),
      symbolIds: new Set([symbolId]), context,
    });
    const a = scheduler.schedule(scope(1));
    const b = scheduler.schedule(scope(2));
    if (a.kind !== 'scheduled' || b.kind !== 'scheduled')
      throw new Error('Expected independent roots to schedule');
    expect(scheduler.schedule(scope(1), b.state).kind).toBe('converged');
    expect(scheduler.schedule(scope(2), a.state).kind).toBe('cycle');

    const diamond = new TraversalScopeScheduler();
    const left = diamond.schedule(scope(3));
    const right = diamond.schedule(scope(4));
    if (left.kind !== 'scheduled' || right.kind !== 'scheduled')
      throw new Error('Expected diamond roots to schedule');
    expect(diamond.schedule(scope(5), left.state).kind).toBe('scheduled');
    expect(diamond.schedule(scope(5), right.state).kind).toBe('converged');

    const contextual = new TraversalScopeScheduler();
    const aEmpty = contextual.schedule(scope(1));
    const bEmpty = contextual.schedule(scope(2));
    const bContext = contextual.schedule(scope(2, new Map([['client', {
      source: 'runtime', calleeReceiver: 'client',
    }]])));
    if (aEmpty.kind !== 'scheduled' || bEmpty.kind !== 'scheduled'
      || bContext.kind !== 'scheduled')
      throw new Error('Expected context-distinct roots to schedule');
    expect(contextual.schedule(scope(1), bContext.state).kind).toBe('converged');
    expect(contextual.schedule(scope(2), aEmpty.state).kind).toBe('converged');

    const active = new TraversalScopeScheduler();
    const activeA = active.schedule(scope(1));
    if (activeA.kind !== 'scheduled')
      throw new Error('Expected active root to schedule');
    const activeB = active.schedule(scope(2, new Map([['first', {
      source: 'runtime', calleeReceiver: 'first',
    }]])), activeA.state);
    if (activeB.kind !== 'scheduled')
      throw new Error('Expected contextual child to schedule');
    expect(active.schedule(scope(1, new Map([['second', {
      source: 'runtime', calleeReceiver: 'second',
    }]])), activeB.state).kind).toBe('cycle');
  });

  it('does not consume an empty-context root with a distinct contextual evaluation', () => {
    const scheduler = new TraversalScopeScheduler();
    const files = new Set(['src/contextual.ts']);
    const symbolIds = new Set([41]);
    const context = new Map([['client', {
      source: 'local_symbol_argument', calleeReceiver: 'client',
    }]]);
    const scheduled = scheduler.schedule({
      workspaceId: 7, repoId: 11, files, symbolIds, context,
    });
    if (scheduled.kind !== 'scheduled')
      throw new Error('Expected contextual scope to schedule');
    const pendingRoots: PendingTraceRootScope[] = [{
      repoId: 11, files, symbolIds, unownedOnly: false,
      rootObservationOnly: false,
    }];
    const queue: TraceQueueScope[] = [];
    enqueueCausalScope(queue, pendingRoots, {
      repoId: 11, files, symbolIds, depth: 3, context,
      state: scheduled.state,
    });
    expect(queue.map((scope) => scope.depth)).toEqual([3]);
    expect(pendingRoots).toHaveLength(1);
  });

  it('derives a sole selector-less workspace and rejects an ambiguous one before stale siblings leak in', () => {
    const current = fixtureState();
    const options = {
      depth: 20, includeAsync: true, includeDb: true, includeExternal: true,
    };
    const omitted = trace(current.db, {}, options);
    const explicit = trace(current.db, {}, {
      ...options, workspaceId: current.workspaceId,
    });
    expect(renderTraceJson(omitted)).toBe(renderTraceJson(explicit));

    current.db.exec('BEGIN');
    try {
      const now = new Date(0).toISOString();
      current.db.prepare(`INSERT INTO workspaces(
        root_path,db_path,created_at,updated_at) VALUES(?,?,?,?)`).run(
        '/fixture/stale-sibling', '/fixture/stale-sibling/graph.db', now, now,
      );
      const siblingWorkspaceId = Number(current.db.prepare(
        'SELECT id FROM workspaces WHERE root_path=?',
      ).get('/fixture/stale-sibling')?.id);
      current.db.prepare(`INSERT INTO repositories(
        workspace_id,name,absolute_path,relative_path,kind,is_git_repo,
        index_status,fact_analyzer_version,graph_stale_reason)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        siblingWorkspaceId, 'stale-sibling', '/fixture/stale-sibling/repo',
        'repo', 'node', 1, 'indexed', '0.1.65', 'analyzer_changed',
      );

      const ambiguous = trace(current.db, {}, options);
      expect(ambiguous.nodes).toEqual([]);
      expect(ambiguous.edges).toEqual([]);
      expect(ambiguous.diagnostics).toEqual([
        expect.objectContaining({ code: 'trace_workspace_ambiguous',
          workspaceCount: 2, omittedWorkspaceCount: 0 }),
      ]);
      const scoped = trace(current.db, { repo: 'event-app', handler: 'start' },
        options);
      expect(eventBridges(scoped, 'FunctionEvent')).toHaveLength(1);
      expect(scoped.diagnostics.some((diagnostic) =>
        diagnostic.code === 'reindex_required')).toBe(false);

      current.db.prepare(`UPDATE repositories SET fact_analyzer_version='legacy'
        WHERE workspace_id=? AND name='event-app'`).run(current.workspaceId);
      const invalidSelector = trace(current.db, {
        repo: 'event-app', handler: 'notIndexed',
      }, { ...options, workspaceId: current.workspaceId });
      expect(invalidSelector.diagnostics).toEqual([
        expect.objectContaining({ code: 'reindex_required' }),
      ]);
    } finally {
      current.db.exec('ROLLBACK');
    }
  });

  it('locks non-async repo-wide detailed output and ordering', () => {
    const result = traceRepo({ includeAsync: false });
    expect({
      table: sha256(renderTraceTable(result)),
      json: sha256(renderTraceJson(result)),
      mermaid: sha256(renderMermaid(result)),
    }).toEqual({
      table: '9c1f98848c06f449abc626f31d62c2d66e1ef6d25dfa89561ab94e5f7464730c',
      json: '0d33c074f9d3c89dcbc966af97280e9e6dffca8f89c362becac0833380bfdeb1',
      mermaid: '2d36a809da6e00301c83e1b0d601984f953eb771402de9df864d1df5bdea4906',
    });
  });

  it('renders a bridge at the depth boundary without expanding the subscriber body', () => {
    const result = traceMain({ depth: 1 });
    const bridge = eventBridges(result, 'FunctionEvent');
    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.evidence.bodyExpansion).toBe('depth_limited');
    expect(downstreamEntityCount(result, 'FunctionRows')).toBe(0);
  });

  it('starts subscriber evaluation with empty emitter binding and payload context', () => {
    const result = traceMain();
    const bridge = eventBridges(result, 'ContextEvent');
    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.evidence.bodyExpansion).toBe('scheduled');
    expect(JSON.stringify(bridge[0]?.evidence)).not.toMatch(
      /target-destination|bindingCandidates|payload|callArguments/,
    );
    expect(result.nodes.some((node) => node.kind === 'handler_method'
      && node.className === 'TargetHandler')).toBe(false);
  });

  it('keeps bridge evidence bounded and exposes the relation in every detailed renderer', () => {
    const result = traceMain();
    const bridge = eventBridges(result, 'FunctionEvent')[0];
    if (!bridge) throw new Error('Missing FunctionEvent bridge');
    expect(bridge.evidence).toMatchObject({
      matchStrategy: 'workspace_exact_event_name',
      dispatchCertainty: 'static_name_only',
      associationBasis: 'exact_subscription_call_span',
      dispatchScope: 'workspace_event_name_only',
      callRole: 'event_subscribe_handler',
      factOrigin: 'event_subscribe_handler_reference',
      associationStatus: 'resolved',
      symbolCallResolutionStatus: 'resolved',
      resolutionStatus: 'resolved',
    });
    const serializedEvidence = JSON.stringify(bridge.evidence);
    for (const forbidden of [
      'outboundEvidence', 'candidates', 'candidateScores', 'callArguments',
      'payloadSummary', 'dynamicTargetCandidates', 'effectiveResolution',
    ]) expect(serializedEvidence).not.toContain(forbidden);
    expect(renderTraceTable(result)).toContain(
      'event_name_matches_subscription_handler',
    );
    expect(renderTraceJson(result)).toContain(
      '"type": "event_name_matches_subscription_handler"',
    );
    expect(renderMermaid(result)).toContain(
      '|event_name_matches_subscription_handler|',
    );
  });

  it('locks the accepted Gate-A detailed renderer topology', () => {
    const result = traceMain();
    expect({
      table: sha256(renderTraceTable(result)),
      json: sha256(renderTraceJson(result)),
      mermaid: sha256(renderMermaid(result)),
    }).toEqual({
      table: '67638027e82560a029add5f5521a3cfc8187450a406bf2f8911785e675c93169',
      json: 'c58a2dcf486d4705b41d8bb6891cc04e0f973c315e547500da178f4550737ae2',
      mermaid: 'eda933d82cf8c3503873e4900fdd9a42b67312062a0d78d87cedc19eefe15537',
    });
  });
});
