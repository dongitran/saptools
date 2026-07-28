import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  classifyOutboundCallsInSource,
} from '../../src/parsers/outbound-call-classifier.js';
import {
  createImportedEventNameResolver,
} from '../../src/parsers/event-name-import-resolution.js';
import type {
  RepositorySourceContext,
  SourceFileSnapshot,
} from '../../src/parsers/ts-project.js';
import {
  deriveEventSkeleton,
  eventTemplateVariables,
} from '../../src/utils/event-skeleton.js';
import {
  collectEnvironmentDeclarations,
} from '../../src/parsers/environment-declarations.js';
import {
  createEventEnvironmentReferenceResolver,
} from '../../src/parsers/event-environment-reference.js';
import {
  reconcileEventSubscriptions,
} from '../../src/parsers/event-subscription-facts.js';
import {
  createEventReceiverIndex,
  proveEventReceiver,
} from '../../src/parsers/event-receiver-analysis.js';
import type { OutboundCallFact } from '../../src/types.js';
import { parseServiceBindings } from '../../src/parsers/service-binding-parser.js';

function source(text: string): ts.SourceFile {
  return ts.createSourceFile(
    'events.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
}

function eventFacts(text: string): OutboundCallFact[] {
  return classifyOutboundCallsInSource(source(text), 'events.ts')
    .map((item) => item.fact)
    .filter((fact) =>
      fact.callType === 'async_emit' || fact.callType === 'async_subscribe');
}

function repositoryContext(
  files: Record<string, string>,
): RepositorySourceContext {
  const snapshots = new Map<string, SourceFileSnapshot>();
  for (const [filePath, text] of Object.entries(files)) {
    const file = ts.createSourceFile(
      filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
    snapshots.set(filePath, {
      repoPath: '/neutral',
      filePath,
      text,
      sizeBytes: Buffer.byteLength(text),
      sourceFile: () => file,
    });
  }
  return {
    get: (filePath) => snapshots.get(filePath),
    entries: () => [...snapshots.values()],
  };
}

describe('event surface parser', () => {
  it('proves structurally connected receivers across declaration shapes', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
async function run(clientName: string): Promise<void> {
  let busA, busB;
  try {
    busA = await cds.connect.to(clientName);
    busB = await cds.connect.messaging(clientName);
  } catch (error) {
    report(error);
  }
  busA.emit('CaseQOne', {});
  busB.emit('CaseQTwo', {});

  let busT;
  try { busT = await cds.connect.to(clientName); } catch {}
  busT.emit('CaseT', {});

  let busV;
  busV = await cds.connect.to(clientName);
  busV.emit('CaseV', {});

  const split = await cds
    .connect
    .to(clientName);
  split.emit('CaseXOne', {});

  let later;
  later = await cds
    .connect
    .to(clientName);
  later.emit('CaseXTwo', {});

  const { destructured } = {
    destructured: await cds.connect.to(clientName),
  };
  destructured.emit('CaseObjectDeclaration', {});

  let assigned;
  ({ assigned } = { assigned: await cds.connect.messaging(clientName) });
  assigned.emit('CaseObjectAssignment', {});
}
`);

    expect(facts.map((fact) => fact.eventNameExpr)).toEqual([
      'CaseQOne', 'CaseQTwo', 'CaseT', 'CaseV', 'CaseXOne', 'CaseXTwo',
      'CaseObjectDeclaration', 'CaseObjectAssignment',
    ]);
    for (const fact of facts)
      expect(fact.evidence).toMatchObject({
        receiverClassification: 'cap_evidence',
        receiverProof: 'lexical_connect_assignment',
      });
  });

  it('proves a single connect binding consistently across control flow', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
async function run(flag: boolean): Promise<void> {
  if (flag) {
    const inIf = await cds.connect.to('primary');
    inIf.emit('InsideIf', {});
  }
  for (const item of [1]) {
    const inFor = await cds.connect.messaging(String(item));
    inFor.emit('InsideFor', {});
  }
  switch (flag) {
    case true: {
      const inSwitch = await cds.connect.to('primary');
      inSwitch.emit('InsideSwitch', {});
      break;
    }
  }
  try {
    const inTry = await cds.connect.to('primary');
    inTry.emit('InsideTry', {});
  } catch {}
}
`);

    expect(facts.map((fact) => fact.eventNameExpr)).toEqual([
      'InsideIf', 'InsideFor', 'InsideSwitch', 'InsideTry',
    ]);
    for (const fact of facts)
      expect(fact.evidence).toMatchObject({
        receiverClassification: 'cap_evidence',
        receiverProof: 'lexical_connect_assignment',
      });
  });

  it('proves helper-return clients for initializers and later assignments', async () => {
    const files = {
      'helper.ts': `
import cds from '@sap/cds';
interface Service {
  emit(name: string, payload: unknown): void;
}
export async function connectBus(name: string): Promise<Service> {
  let client: Service;
  try {
    client = await cds.connect.to(name);
  } catch (error) {
    throw error;
  }
  return client;
}
`,
      'events.ts': `
import { connectBus } from './helper';
async function run(name: string): Promise<void> {
  const initialized = await connectBus(name);
  initialized.emit('InitializedHelperClient', {});
  let assigned;
  assigned = await connectBus(name);
  assigned.emit('AssignedHelperClient', {});
}
`,
    };
    const context = repositoryContext(files);
    const eventSource = context.get('events.ts')?.sourceFile();
    if (!eventSource) throw new Error('event_source_missing');
    const bindings = await parseServiceBindings(
      '/neutral', 'events.ts', context,
    );
    const facts = classifyOutboundCallsInSource(
      eventSource, 'events.ts', { serviceBindings: bindings },
    ).map((item) => item.fact).filter((fact) =>
      fact.callType === 'async_emit');

    expect(facts.map((fact) => fact.eventNameExpr)).toEqual([
      'InitializedHelperClient', 'AssignedHelperClient',
    ]);
    for (const fact of facts)
      expect(fact.evidence).toMatchObject({
        receiverClassification: 'cap_evidence',
        receiverProof: 'single_hop_helper_return',
      });
  });

  it('keeps mixed reaching assignments unproven', () => {
    const [fact] = eventFacts(`
import cds from '@sap/cds';
async function run(flag: boolean, other: unknown): Promise<void> {
  let bus = await cds.connect.to('primary');
  if (flag) bus = other;
  bus.emit('MixedReceiver', {});
}
`);

    expect(fact).toMatchObject({
      eventNameExpr: 'MixedReceiver',
      unresolvedReason: undefined,
      evidence: {
        receiverClassification: 'unproven',
        receiverUnresolvedReason: 'event_receiver_unproven_binding',
        receiverProof: 'mixed_or_missing_assignment',
      },
    });
  });

  it('records statically enumerable and unknown loop registrations honestly', () => {
    const file = source(`
declare const messaging: { on(name: string, handler: unknown): void };
declare const guard: { wrap(handler: unknown): unknown };
declare class Handler { static handle(): void }
const TOPICS = ['NeutralStored', 'NeutralUpdated', 'NeutralDeleted'] as const;
TOPICS.forEach((topic) => {
  messaging.on(topic, guard.wrap(Handler.handle));
});
declare const runtimeTopics: string[];
runtimeTopics.forEach((topic) => {
  messaging.on(topic, guard.wrap(Handler.handle));
});
`);
    const classified = classifyOutboundCallsInSource(file, 'events.ts');
    const reconciled = reconcileEventSubscriptions(
      file, classified, [], [],
    ).classifications.map((item) => item.fact);

    expect(reconciled[0]?.evidence).toMatchObject({
      handlerReferenceStatus: 'role_required',
      handlerReferenceShape: 'wrapped_static_member',
      subscriptionRegisteredInLoop: true,
      subscriptionLoopRegistrationStatus: 'enumerated',
      subscriptionLoopRegistrationCount: 3,
      subscriptionLoopValues: [
        'NeutralStored', 'NeutralUpdated', 'NeutralDeleted',
      ],
      shownSubscriptionLoopValueCount: 3,
      omittedSubscriptionLoopValueCount: 0,
    });
    expect(reconciled[1]?.evidence).toMatchObject({
      handlerReferenceStatus: 'role_required',
      subscriptionRegisteredInLoop: true,
      subscriptionLoopRegistrationStatus: 'unresolved',
      subscriptionLoopUnresolvedReason:
        'subscription_loop_collection_not_statically_enumerable',
    });
    expect(reconciled[1]?.evidence)
      .not.toHaveProperty('subscriptionLoopRegistrationCount');
  });

  it('records property receivers and excludes a proven non-CAP receiver', () => {
    const facts = eventFacts(`
interface Params { messaging: { emit(name: string, payload: unknown): void } }
class Publisher {
  messaging: Params['messaging'];
  publish(p: Params): void {
    p.messaging.emit('PropertyParameter', {});
    this.messaging.emit('PropertyThis', {});
  }
}
function buildThing(): { emit(name: string, payload: unknown): void } {
  return { emit() {} };
}
const notAClient = buildThing();
notAClient.emit('NotCap', {});
`);

    expect(facts).toHaveLength(2);
    expect(facts.find((fact) => fact.eventNameExpr === 'PropertyParameter'))
      .toMatchObject({
        unresolvedReason: undefined,
        evidence: {
          receiverUnresolvedReason: 'event_receiver_unproven_propagation',
        },
      });
    expect(facts.find((fact) => fact.eventNameExpr === 'PropertyThis'))
      .toMatchObject({
        unresolvedReason: undefined,
        evidence: {
          receiverUnresolvedReason: 'event_receiver_unproven_propagation',
        },
      });
  });

  it('does not let compatibility names override a visible declaration', () => {
    const [fact] = eventFacts(`
declare const messaging: { emit(name: string, payload: unknown): void };
messaging.emit('Fallback', {});
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'Fallback',
      evidence: {
        receiverClassification: 'unproven',
        receiverProof: 'mixed_or_missing_assignment',
        receiverUnresolvedReason: 'event_receiver_unproven_binding',
      },
    });
  });

  it('uses compatibility names only when no declaration can be resolved', () => {
    const [fact] = eventFacts(`
messaging.emit('Fallback', {});
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'Fallback',
      evidence: {
        receiverClassification: 'name_fallback',
        receiverProof: 'compatibility_name_fallback',
        receiverFallbackRefusedReason: 'binding_not_found',
        consideredBindingSites: [
          expect.objectContaining({ flow: 'reference', connect: false }),
        ],
      },
    });
  });

  it('retains an unknown receiver as unproven instead of excluding it', () => {
    const [fact] = eventFacts(`
bus.emit('UnknownBinding', {});
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'UnknownBinding',
      evidence: {
        receiverClassification: 'unproven',
        receiverProof: 'binding_not_found',
        receiverUnresolvedReason: 'event_receiver_unproven_binding',
      },
    });
  });

  it('does not infer event receivers from comments or string contents', () => {
    const facts = eventFacts(`
function buildThing(..._args: unknown[]): {
  emit(name: string, payload: unknown): void
} {
  return { emit(): void {} };
}
const gateway = buildThing(/* cds.connect.to("primary") */);
const relay = buildThing('cds.connect.to(');
const conduit = buildThing();
gateway.emit('CommentFalsePositive', {});
relay.emit('StringFalsePositive', {});
conduit.emit('ControlNonClient', {});
`);
    expect(facts).toEqual([]);
  });

  it('excludes non-messaging emitters and service CRUD handlers only', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
declare const io: { emit(name: string): void; on(name: string): void };
declare const socket: {
  broadcast: { emit(name: string): void };
  on(name: string): void;
};
declare const writeStream: { on(name: string): void };
declare const file: { on(name: string): void };
declare const req: {
  pipe(value: unknown): {
    on(name: string): { on(nextName: string): void }
  }
};
declare const sink: unknown;
declare const win: { on(name: string): void };
declare const app: { on(name: string): void };
io.emit('connection');
socket.broadcast.emit('message');
socket.on('event');
writeStream.on('finish');
file.on('end');
req.pipe(sink).on('finish');
req.pipe(sink).on('error').on('finish');
win.on('close');
app.on('window-all-closed');
class Service {
  register(): void { this.on('READ', (): void => {}); }
  on(_name: string, _handler: () => void): void {}
}
async function subscribe(): Promise<void> {
  const messaging = await cds.connect.messaging('primary');
  messaging.on('READ', (): void => {});
}
`);
    expect(facts).toEqual([
      expect.objectContaining({
        callType: 'async_subscribe',
        eventNameExpr: 'READ',
        unresolvedReason: undefined,
      }),
    ]);
  });

  it('uses imported Node stream provenance consistently for every event name', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
import { createReadStream } from 'node:fs';
const stream = createReadStream('neutral-input.txt');
stream.on('data', (): void => {});
stream.on('end', (): void => {});
stream.on('error', (): void => {});
async function subscribe(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.on('data', (): void => {});
}
`);
    expect(facts).toEqual([
      expect.objectContaining({
        callType: 'async_subscribe',
        eventNameExpr: 'data',
      }),
    ]);
  });

  it('proves a Node stream parameter before generic parameter flow', () => {
    const file = source(`
import { Readable } from 'node:stream';
function consume(stream: Readable): void {
  stream.on('data', (): void => {});
  stream.on('end', (): void => {});
  stream.on('error', (): void => {});
}
`);
    expect(classifyOutboundCallsInSource(file, 'events.ts')
      .map((item) => item.fact)
      .filter((fact) =>
        fact.callType === 'async_emit'
        || fact.callType === 'async_subscribe')).toEqual([]);
    let call: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (call) return;
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'on') call = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!call || !ts.isPropertyAccessExpression(call.expression))
      throw new Error('node_stream_listener_fixture_missing');
    expect(proveEventReceiver(
      call.expression.expression,
      call,
      createEventReceiverIndex(file),
    )).toMatchObject({
      receiverClassification: 'unproven',
      receiverProof: 'node_event_parameter_type',
      unresolvedReason: 'event_receiver_not_cap_client',
    });
  });

  it('records the root receiver for this-property event calls', () => {
    const [fact] = eventFacts(`
class Publisher {
  bus: { emit(name: string, payload: unknown): void };
  publish(): void {
    this.bus.emit('ThisTopic', {});
  }
}
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'ThisTopic',
      evidence: {
        receiverClassification: 'unproven',
        rootReceiver: 'this',
      },
    });
  });

  it('folds stable local enum and const-object topics only', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
enum LOCAL_TOPIC { FIRST = 'EnumTopic' }
const TOPICS = { SECOND: 'ObjectTopic' } as const;
const MUTABLE = { THIRD: 'MutableTopic' };
MUTABLE.THIRD = 'ChangedTopic';
declare const prefix: string;
const DYNAMIC = { FOURTH: \`\${prefix}Suffix\` } as const;
const SHADOWED = { FIFTH: 'WrongShadowedTopic' } as const;
async function run(
  SHADOWED: { FIFTH: string },
): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.emit(LOCAL_TOPIC.FIRST, {});
  bus.emit(TOPICS.SECOND, {});
  bus.emit(MUTABLE.THIRD, {});
  bus.emit(DYNAMIC.FOURTH, {});
  bus.emit(TOPICS['SECOND'], {});
  bus.emit(SHADOWED.FIFTH, {});
}
`);

    expect(facts[0]).toMatchObject({
      eventNameExpr: 'EnumTopic',
      confidence: 0.8,
      evidence: {
        eventNameConstant: { sourceKind: 'enum_member' },
      },
    });
    expect(facts[1]).toMatchObject({
      eventNameExpr: 'ObjectTopic',
      confidence: 0.8,
      evidence: {
        eventNameConstant: { sourceKind: 'const_object_property' },
      },
    });
    expect(facts[2]).toMatchObject({
      eventNameExpr: 'MUTABLE.THIRD',
      unresolvedReason: 'event_name_constant_container_unsafe_reference',
    });
    expect(facts[3]).toMatchObject({
      eventNameExpr: 'DYNAMIC.FOURTH',
      unresolvedReason: 'event_name_constant_member_not_string',
    });
    expect(facts[4]).toMatchObject({
      eventNameExpr: "TOPICS['SECOND']",
      unresolvedReason: 'event_name_constant_container_ambiguous',
    });
    expect(facts[5]).toMatchObject({
      eventNameExpr: 'SHADOWED.FIFTH',
      unresolvedReason: 'event_name_constant_container_ambiguous',
    });
  });

  it('folds unique exported constants from an exact relative module', () => {
    const files = {
      'topics.ts': `
export enum EVENT_KIND { CREATED = 'ImportedEnumTopic' }
export const TOPICS = { UPDATED: 'ImportedObjectTopic' } as const;
const HIDDEN = { VALUE: 'HiddenTopic' } as const;
`,
      'events.ts': `
import cds from '@sap/cds';
import { EVENT_KIND as Kind, TOPICS, HIDDEN } from './topics';
import * as topicModule from './topics';
async function run(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  const alias = TOPICS;
  bus.emit(Kind.CREATED, {});
  bus.emit(TOPICS.UPDATED, {});
  bus.emit(topicModule.TOPICS.UPDATED, {});
  bus.emit(HIDDEN.VALUE, {});
  bus.emit(TOPICS['UPDATED'], {});
  bus.emit(alias.UPDATED, {});
}
`,
    };
    const context = repositoryContext(files);
    const eventSource = context.get('events.ts')?.sourceFile();
    if (!eventSource) throw new Error('event_source_missing');
    const facts = classifyOutboundCallsInSource(
      eventSource,
      'events.ts',
      {
        importedEventNameResolver: createImportedEventNameResolver(
          context, eventSource, 'events.ts',
        ),
      },
    ).map((item) => item.fact).filter((fact) =>
      fact.callType === 'async_emit');

    expect(facts.slice(0, 3).map((fact) => fact.eventNameExpr)).toEqual([
      'ImportedEnumTopic',
      'ImportedObjectTopic',
      'ImportedObjectTopic',
    ]);
    expect(facts[3]).toMatchObject({
      eventNameExpr: 'HIDDEN.VALUE',
      unresolvedReason: 'event_name_constant_container_not_exported',
    });
    expect(facts.slice(4)).toEqual([
      expect.objectContaining({
        eventNameExpr: "TOPICS['UPDATED']",
        unresolvedReason: 'event_name_constant_container_ambiguous',
      }),
      expect.objectContaining({
        eventNameExpr: 'alias.UPDATED',
        unresolvedReason: 'event_name_constant_container_ambiguous',
      }),
    ]);
  });

  it('refuses partial object folding and accepts type-only references', () => {
    const facts = eventFacts(`
import cds from '@sap/cds';
const BASE = { A: 'SpreadOverride' } as const;
const SPREAD = { A: 'WrongOwnValue', ...BASE } as const;
const KEY = 'A';
const COMPUTED = { A: 'WrongComputedValue', [KEY]: 'ComputedOverride' };
const GETTER = { get A(): string { return 'GetterValue'; } };
const shorthandValue = 'ShorthandValue';
const SHORTHAND = { shorthandValue };
const SAFE = { READY: 'TypeSafeObject' } as const;
type SafeKey = keyof typeof SAFE;
enum SAFE_ENUM { READY = 'TypeSafeEnum' }
function acceptsEnum(_value: SAFE_ENUM): void {}
async function run(_key: SafeKey): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.emit(SPREAD.A, {});
  bus.emit(COMPUTED.A, {});
  bus.emit(GETTER.A, {});
  bus.emit(SHORTHAND.shorthandValue, {});
  bus.emit(SAFE.READY, {});
  bus.emit(SAFE_ENUM.READY, {});
  acceptsEnum(SAFE_ENUM.READY);
}
`);

    expect(facts).toEqual([
      expect.objectContaining({
        eventNameExpr: 'SPREAD.A',
        unresolvedReason: 'event_name_constant_container_unsupported_shape',
      }),
      expect.objectContaining({
        eventNameExpr: 'COMPUTED.A',
        unresolvedReason: 'event_name_constant_container_unsupported_shape',
      }),
      expect.objectContaining({
        eventNameExpr: 'GETTER.A',
        unresolvedReason: 'event_name_constant_container_unsupported_shape',
      }),
      expect.objectContaining({
        eventNameExpr: 'SHORTHAND.shorthandValue',
        unresolvedReason: 'event_name_constant_container_unsupported_shape',
      }),
      expect.objectContaining({
        eventNameExpr: 'TypeSafeObject',
        unresolvedReason: undefined,
      }),
      expect.objectContaining({
        eventNameExpr: 'TypeSafeEnum',
        unresolvedReason: undefined,
      }),
    ]);
  });

  it('refuses authoritative loop enumeration for partial object shapes', () => {
    const file = source(`
declare const messaging: { on(name: string, handler: unknown): void };
declare const handler: unknown;
const BASE = { A: 'SpreadOverride' } as const;
const TOPICS = { A: 'WrongOwnValue', ...BASE } as const;
Object.values(TOPICS).forEach((topic) => {
  messaging.on(topic, handler);
});
`);
    const classified = classifyOutboundCallsInSource(file, 'events.ts');
    const [fact] = reconcileEventSubscriptions(
      file, classified, [], [],
    ).classifications.map((item) => item.fact);
    expect(fact?.evidence).toMatchObject({
      subscriptionRegisteredInLoop: true,
      subscriptionLoopRegistrationStatus: 'unresolved',
      subscriptionLoopUnresolvedReason:
        'subscription_loop_collection_not_statically_enumerable',
    });
  });

  it('keeps empty constants legal but refuses them as event names', () => {
    const [fact] = eventFacts(`
import cds from '@sap/cds';
const EMPTY_TOPIC = '';
async function run(): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.emit(EMPTY_TOPIC, {});
}
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'EMPTY_TOPIC',
      unresolvedReason: 'event_name_constant_value_empty',
      evidence: {
        eventNameUnresolvedReason: 'event_name_constant_value_empty',
      },
    });
  });

  it('derives skeletons after const-alias resolution', () => {
    const [fact] = eventFacts(`
import cds from '@sap/cds';
async function run(payload: { code: string }): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  const eventName = \`\${payload.code.toUpperCase()}SetStatus\`;
  bus.emit(eventName, {});
}
`);
    expect(fact).toMatchObject({
      eventNameExpr: '${payload.code.toUpperCase()}SetStatus',
      unresolvedReason: 'dynamic_event_name_identifier',
      eventSkeleton: {
        status: 'complete',
        literalSpans: ['', 'SetStatus'],
        sourceKeys: ['payload.code.toUpperCase()'],
        holeCount: 1,
      },
    });
    expect(fact?.eventSkeleton?.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('folds static template holes before deriving a shape', () => {
    const [fact] = eventFacts(`
import cds from '@sap/cds';
const TOPICS = { START: 'JobStarted' } as const;
async function run(code: string): Promise<void> {
  const bus = await cds.connect.messaging('primary');
  bus.emit(\`\${code}\${TOPICS.START}\`, {});
}
`);
    expect(fact).toMatchObject({
      eventNameExpr: '${code}JobStarted',
      unresolvedReason: 'dynamic_event_name_identifier',
      eventSkeleton: {
        literalSpans: ['', 'JobStarted'],
        sourceKeys: ['code'],
        candidateEligible: true,
      },
    });
  });

  it('derives name-independent skeletons and canonical hole keys', () => {
    const published = deriveEventSkeleton('${publisherCode}Stored');
    const subscribed = deriveEventSkeleton('${subscriberCode}Stored');
    expect(published?.signature).toBe(subscribed?.signature);
    expect(published).toMatchObject({
      literalSpans: ['', 'Stored'],
      holeCount: 1,
      candidateEligible: false,
    });

    const longPublished = deriveEventSkeleton('${publisherCode}RecordStored');
    const longSubscribed = deriveEventSkeleton('${subscriberCode}RecordStored');
    expect(longPublished?.signature).toBe(longSubscribed?.signature);
    expect(longPublished?.candidateEligible).toBe(true);
    const key = longPublished?.canonicalKeys[0];
    if (!key) throw new Error('canonical_event_key_missing');
    expect(eventTemplateVariables(longSubscribed, { [key]: 'NEUTRAL' }))
      .toMatchObject({ subscriberCode: 'NEUTRAL' });

    expect(deriveEventSkeleton('${first}${second}')?.candidateEligible)
      .toBe(false);
  });

  it('retains only allowlisted environment declarations and detects conflicts', () => {
    const nodemon = JSON.stringify({
      env: {
        SHARD_CODE: 'neutralone',
        PRIVATE_TOKEN: 'must-not-persist',
      },
    });
    const manifest = `
applications:
  - name: neutral
    env:
      SHARD_CODE: "neutraltwo"
      PRIVATE_TOKEN: "also-must-not-persist"
`;
    const dotenv =
      'SHARD_CODE=neutralone\nPRIVATE_TOKEN=never-store-this\n';
    const sources = repositoryContext({
      'nodemon.json': nodemon,
      'manifest.yml': manifest,
      '.env': dotenv,
    });
    const facts = collectEnvironmentDeclarations(sources, ['SHARD_CODE']);

    expect(facts).toMatchObject({
      status: 'ambiguous',
      reason: 'environment_declaration_values_conflict',
    });
    expect(facts.declarations.map((item) => item.key))
      .toEqual(['SHARD_CODE', 'SHARD_CODE', 'SHARD_CODE']);
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(facts)).not.toContain('must-not-persist');
    expect(JSON.stringify(facts)).not.toContain('never-store-this');
    for (const declaration of facts.declarations) {
      const text = declaration.sourceFile === 'nodemon.json'
        ? nodemon : declaration.sourceFile === 'manifest.yml'
          ? manifest : dotenv;
      expect(text.slice(
        declaration.startOffset, declaration.endOffset,
      )).toBe(declaration.value);
    }
    const dynamic = collectEnvironmentDeclarations(repositoryContext({
      'nodemon.json': JSON.stringify({
        env: { SHARD_CODE: '${RUNTIME_SHARD}' },
      }),
    }), ['SHARD_CODE']);
    expect(dynamic).toMatchObject({
      status: 'not_applicable',
      total: 0,
      declarations: [],
    });
  });

  it('uses a configured environment-key allowlist without retaining neighbours', () => {
    const facts = collectEnvironmentDeclarations(repositoryContext({
      'nodemon.json': JSON.stringify({
        env: {
          TENANT_CODE: 'neutral',
          PRIVATE_TOKEN: 'must-never-persist',
        },
      }),
    }), ['TENANT_CODE']);
    expect(facts).toMatchObject({
      allowedKeys: ['TENANT_CODE'],
      status: 'complete',
      declarations: [{
        key: 'TENANT_CODE',
        value: 'neutral',
      }],
    });
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(facts)).not.toContain('must-never-persist');
  });

  it('records one-hop process.env provenance and allowlisted transforms', () => {
    const files = {
      'env.ts': `
export const environmentCode = process.env.SHARD_CODE;
`,
      'events.ts': `
import cds from '@sap/cds';
import { environmentCode } from './env';
const subscriptionCode = environmentCode.toUpperCase();
async function run(handler: () => void): Promise<void> {
  const messaging = await cds.connect.messaging('primary');
  messaging.on(\`\${subscriptionCode}RecordStored\`, handler);
  messaging.on(\`\${environmentCode.slice(0, 3)}RecordSliced\`, handler);
}
`,
    };
    const context = repositoryContext(files);
    const eventSource = context.get('events.ts')?.sourceFile();
    if (!eventSource) throw new Error('event_source_missing');
    const facts = classifyOutboundCallsInSource(eventSource, 'events.ts', {
      importedEventNameResolver: createImportedEventNameResolver(
        context, eventSource, 'events.ts',
      ),
      eventEnvironmentReferenceResolver:
        createEventEnvironmentReferenceResolver(
          context, eventSource, 'events.ts', ['SHARD_CODE'],
        ),
    }).map((item) => item.fact).filter((fact) =>
      fact.callType === 'async_subscribe');

    expect(facts[0]?.eventSkeleton?.environmentBindings[0]).toMatchObject({
      status: 'resolved',
      sourceKey: 'subscriptionCode',
      environmentKey: 'SHARD_CODE',
      transforms: ['toUpperCase'],
      sourceFile: 'env.ts',
    });
    expect(facts[1]?.eventSkeleton?.environmentBindings[0]).toMatchObject({
      status: 'refused',
      reason: 'event_environment_transform_unsupported',
    });
  });

  it('binds configured keys and labels unsupported package indirection', () => {
    const files = {
      'env.ts': 'export const envCode = process.env.TENANT_CODE;\n',
      'events.ts': `
import cds from '@sap/cds';
import { envCode } from './env';
import { packageCode } from '@neutral/environment';
async function run(handler: () => void): Promise<void> {
  const messaging = await cds.connect.messaging('primary');
  messaging.on(\`\${envCode.toUpperCase()}RecordStored\`, handler);
  messaging.on(\`\${packageCode}RecordStored\`, handler);
}
`,
    };
    const context = repositoryContext(files);
    const eventSource = context.get('events.ts')?.sourceFile();
    if (!eventSource) throw new Error('event_source_missing');
    const facts = classifyOutboundCallsInSource(eventSource, 'events.ts', {
      importedEventNameResolver: createImportedEventNameResolver(
        context, eventSource, 'events.ts',
      ),
      eventEnvironmentReferenceResolver:
        createEventEnvironmentReferenceResolver(
          context, eventSource, 'events.ts', ['TENANT_CODE'],
        ),
    }).map((item) => item.fact).filter((fact) =>
      fact.callType === 'async_subscribe');

    expect(facts[0]?.eventSkeleton?.environmentBindings[0]).toMatchObject({
      status: 'resolved',
      environmentKey: 'TENANT_CODE',
      transforms: ['toUpperCase'],
      sourceFile: 'env.ts',
    });
    expect(facts[1]?.eventSkeleton?.environmentBindings[0]).toMatchObject({
      status: 'refused',
      reason: 'event_environment_package_import_unsupported',
    });
  });
});
