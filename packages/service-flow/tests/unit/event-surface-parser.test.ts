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
import type { OutboundCallFact } from '../../src/types.js';

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

  it('records property receivers and a proven non-CAP receiver honestly', () => {
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

    expect(facts).toHaveLength(3);
    expect(facts.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventNameExpr: 'PropertyParameter',
        unresolvedReason: 'event_receiver_unproven_propagation',
      }),
      expect.objectContaining({
        eventNameExpr: 'PropertyThis',
        unresolvedReason: 'event_receiver_unproven_propagation',
      }),
    ]));
    expect(facts[2]).toMatchObject({
      eventNameExpr: 'NotCap',
      unresolvedReason: 'event_receiver_not_cap_client',
      evidence: { receiverClassification: 'unproven' },
    });
  });

  it('keeps the compatibility receiver names as explicit fallbacks', () => {
    const [fact] = eventFacts(`
declare const messaging: { emit(name: string, payload: unknown): void };
messaging.emit('Fallback', {});
`);
    expect(fact).toMatchObject({
      eventNameExpr: 'Fallback',
      evidence: {
        receiverClassification: 'name_fallback',
        receiverProof: 'compatibility_name_fallback',
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
      unresolvedReason: 'event_name_constant_container_mutable',
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
    const facts = collectEnvironmentDeclarations(sources);

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
    }));
    expect(dynamic).toMatchObject({
      status: 'not_applicable',
      total: 0,
      declarations: [],
    });
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
          context, eventSource, 'events.ts',
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
});
