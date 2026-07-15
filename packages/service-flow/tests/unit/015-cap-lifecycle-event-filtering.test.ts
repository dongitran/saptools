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
import { parseExecutableSymbols } from '../../src/parsers/symbol-parser.js';
import { trace } from '../../src/trace/trace-engine.js';
import type { ExecutableSymbolFact } from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type OutboundFact = ClassifiedOutboundCall['fact'];

interface StoredEventCall {
  callType: string;
  eventName: string | null;
  classifier: string | null;
  receiverClassification: string | null;
  ownerKind: string | null;
  evidenceValid: number;
  evidenceLength: number;
}

interface StoredMethodCall {
  path: string | null;
  method: string | null;
  dynamicMethodDefaulted: number | null;
  evidenceValid: number;
  evidenceLength: number;
}

interface StoredEventEdge {
  edgeType: string;
  target: string;
  status: string;
  targetKind: string;
  evidenceValid: number;
  evidenceLength: number;
}

interface LifecycleWorkspaceState {
  events: StoredEventCall[];
  methods: StoredMethodCall[];
  eventEdges: StoredEventEdge[];
  eventRegistrationCount: number;
  unownedBootstrapRegistrationCount: number;
  defaultTraceAsyncCount: number;
  asyncTraceEdges: Array<{ type: string; from: string; to: string }>;
}

const lifecycleEvents = [
  'bootstrap',
  'loaded',
  'connect',
  'serving',
  'served',
  'listening',
  'shutdown',
] as const;

function classifiedFacts(sourceText: string): OutboundFact[] {
  const source = ts.createSourceFile(
    'handler.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  return classifyOutboundCallsInSource(source, 'handler.ts')
    .map((call) => call.fact);
}

function eventFacts(sourceText: string): OutboundFact[] {
  return classifiedFacts(sourceText).filter((fact) =>
    fact.callType === 'async_emit' || fact.callType === 'async_subscribe');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.filter(isRecord);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numeric(value: unknown): number {
  return Number(value ?? 0);
}

function count(value: unknown): number {
  if (!isRecord(value)) return 0;
  return numeric(value.count);
}

async function executableSymbols(sourceText: string): Promise<ExecutableSymbolFact[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-lifecycle-symbols-'));
  await writeFixtureFile(root, 'src/handler.ts', sourceText);
  return (await parseExecutableSymbols(root, 'src/handler.ts')).symbols;
}

async function createLifecycleWorkspace(root: string): Promise<void> {
  await writeFixtureFile(root, 'event-app/.git-fixture');
  await writeFixtureFile(root, 'event-app/package.json', JSON.stringify({
    name: '@neutral/event-app',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, 'event-app/src/events.ts', `
    cds.on('bootstrap', () => undefined);
    cds.emit('listening');
    cds.publish('served');
    srv.on('error', () => undefined);
    messaging.on('error', () => undefined);
    messaging.emit('error', {});
    messaging.on('OrderCreated', () => undefined);
    messaging.emit('OrderCreated', {});
    messaging.publish('OrderShipped', {});
    cds.on('FacadeCustom', () => undefined);
    srv.on('listening', () => undefined);

    async function dynamicMethod(client: unknown, method: string): Promise<void> {
      await client.send({ method, path: '/dynamic' });
    }
    async function staticMethod(client: unknown): Promise<void> {
      await client.send({ method: 'PATCH', path: '/static' });
    }
    async function defaultMethod(client: unknown): Promise<void> {
      await client.send({ path: '/default' });
    }
  `);
}

function workspaceState(db: Db): LifecycleWorkspaceState {
  const events = records(db.prepare(`SELECT c.call_type callType,c.event_name_expr eventName,
    json_extract(c.evidence_json,'$.classifier') classifier,
    json_extract(c.evidence_json,'$.receiverClassification') receiverClassification,
    s.kind ownerKind,json_valid(c.evidence_json) evidenceValid,
    length(c.evidence_json) evidenceLength
    FROM outbound_calls c LEFT JOIN symbols s ON s.id=c.source_symbol_id
    WHERE c.call_type IN ('async_emit','async_subscribe')
    ORDER BY c.source_line,c.id`).all()).map((row): StoredEventCall => ({
    callType: String(row.callType ?? ''),
    eventName: nullableString(row.eventName),
    classifier: nullableString(row.classifier),
    receiverClassification: nullableString(row.receiverClassification),
    ownerKind: nullableString(row.ownerKind),
    evidenceValid: numeric(row.evidenceValid),
    evidenceLength: numeric(row.evidenceLength),
  }));
  const methods = records(db.prepare(`SELECT operation_path_expr path,method,
    json_extract(evidence_json,'$.dynamicMethodDefaulted') dynamicMethodDefaulted,
    json_valid(evidence_json) evidenceValid,length(evidence_json) evidenceLength
    FROM outbound_calls WHERE call_type='remote_action'
    ORDER BY source_line,id`).all()).map((row): StoredMethodCall => ({
    path: nullableString(row.path),
    method: nullableString(row.method),
    dynamicMethodDefaulted: row.dynamicMethodDefaulted === null
      || row.dynamicMethodDefaulted === undefined
      ? null
      : numeric(row.dynamicMethodDefaulted),
    evidenceValid: numeric(row.evidenceValid),
    evidenceLength: numeric(row.evidenceLength),
  }));
  const eventEdges = records(db.prepare(`SELECT edge_type edgeType,to_id target,status,
    to_kind targetKind,json_valid(evidence_json) evidenceValid,
    length(evidence_json) evidenceLength
    FROM graph_edges
    WHERE edge_type IN ('EVENT_CONSUMED_BY_HANDLER','HANDLER_EMITS_EVENT')
    ORDER BY edge_type,to_id`).all()).map((row): StoredEventEdge => ({
    edgeType: String(row.edgeType ?? ''),
    target: String(row.target ?? ''),
    status: String(row.status ?? ''),
    targetKind: String(row.targetKind ?? ''),
    evidenceValid: numeric(row.evidenceValid),
    evidenceLength: numeric(row.evidenceLength),
  }));
  const registration = db.prepare(
    "SELECT COUNT(*) count FROM symbols WHERE kind='event_registration'",
  ).get();
  const unownedBootstrap = db.prepare(`SELECT COUNT(*) count FROM symbols s
    WHERE s.kind='event_registration'
      AND json_extract(s.evidence_json,'$.eventName')='bootstrap'
      AND NOT EXISTS (
        SELECT 1 FROM outbound_calls c WHERE c.source_symbol_id=s.id
      )`).get();
  const defaultTrace = trace(db, { repo: 'event-app' }, { depth: 5 });
  const asyncTrace = trace(
    db, { repo: 'event-app' }, { depth: 5, includeAsync: true },
  );
  return {
    events,
    methods,
    eventEdges,
    eventRegistrationCount: count(registration),
    unownedBootstrapRegistrationCount: count(unownedBootstrap),
    defaultTraceAsyncCount: defaultTrace.edges
      .filter((edge) => edge.type.startsWith('async_')).length,
    asyncTraceEdges: asyncTrace.edges
      .filter((edge) => edge.type.startsWith('async_'))
      .map((edge) => ({ type: edge.type, from: edge.from, to: edge.to })),
  };
}

function expectLifecycleWorkspaceState(state: LifecycleWorkspaceState): void {
  expect(state.events.map((event) => ({
    callType: event.callType,
    eventName: event.eventName,
    classifier: event.classifier,
    receiverClassification: event.receiverClassification,
  }))).toEqual([
    {
      callType: 'async_emit',
      eventName: 'error',
      classifier: 'cap_service_event_emit',
      receiverClassification: 'cap_evidence',
    },
    {
      callType: 'async_subscribe',
      eventName: 'OrderCreated',
      classifier: 'cap_service_event_subscription',
      receiverClassification: 'cap_evidence',
    },
    {
      callType: 'async_emit',
      eventName: 'OrderCreated',
      classifier: 'cap_service_event_emit',
      receiverClassification: 'cap_evidence',
    },
    {
      callType: 'async_emit',
      eventName: 'OrderShipped',
      classifier: 'cap_service_event_emit',
      receiverClassification: 'cap_evidence',
    },
    {
      callType: 'async_subscribe',
      eventName: 'FacadeCustom',
      classifier: 'cap_service_event_subscription',
      receiverClassification: 'cap_evidence',
    },
    {
      callType: 'async_subscribe',
      eventName: 'listening',
      classifier: 'cap_service_event_subscription',
      receiverClassification: 'cap_evidence',
    },
  ]);
  expect(state.events.every((event) => event.evidenceValid === 1
    && event.evidenceLength < 8_192)).toBe(true);
  expect(state.events.filter((event) => event.callType === 'async_subscribe')
    .every((event) => event.ownerKind === 'event_registration')).toBe(true);
  expect(state.methods.map((row) => ({
    path: row.path,
    method: row.method,
    dynamicMethodDefaulted: row.dynamicMethodDefaulted,
    evidenceValid: row.evidenceValid,
  }))).toEqual([
    {
      path: '/dynamic', method: 'POST', dynamicMethodDefaulted: 1,
      evidenceValid: 1,
    },
    {
      path: '/static', method: 'PATCH', dynamicMethodDefaulted: null,
      evidenceValid: 1,
    },
    {
      path: '/default', method: 'POST', dynamicMethodDefaulted: null,
      evidenceValid: 1,
    },
  ]);
  expect(state.methods.every((row) => row.evidenceLength < 8_192)).toBe(true);
  expect(state.eventEdges.map((edge) => ({
    edgeType: edge.edgeType,
    target: edge.target,
  }))).toEqual([
    { edgeType: 'EVENT_CONSUMED_BY_HANDLER', target: 'FacadeCustom' },
    { edgeType: 'EVENT_CONSUMED_BY_HANDLER', target: 'OrderCreated' },
    { edgeType: 'EVENT_CONSUMED_BY_HANDLER', target: 'listening' },
    { edgeType: 'HANDLER_EMITS_EVENT', target: 'OrderCreated' },
    { edgeType: 'HANDLER_EMITS_EVENT', target: 'OrderShipped' },
    { edgeType: 'HANDLER_EMITS_EVENT', target: 'error' },
  ]);
  expect(state.eventEdges.every((edge) => edge.status === 'terminal'
    && edge.targetKind === 'event'
    && edge.evidenceValid === 1
    && edge.evidenceLength < 8_192)).toBe(true);
  expect(state.eventRegistrationCount).toBe(6);
  expect(state.unownedBootstrapRegistrationCount).toBe(1);
  expect(state.defaultTraceAsyncCount).toBe(0);
  expect(state.asyncTraceEdges).toHaveLength(6);
  expect(state.asyncTraceEdges.map((edge) => edge.type).sort()).toEqual([
    'async_emit', 'async_emit', 'async_emit',
    'async_subscribe', 'async_subscribe', 'async_subscribe',
  ]);
}

describe('CAP lifecycle and error hook event filtering', () => {
  it('omits every cds lifecycle subscription while preserving registration symbols', async () => {
    const sourceText = lifecycleEvents
      .map((eventName) => `cds.on('${eventName}', () => undefined);`)
      .join('\n');
    expect(eventFacts(sourceText)).toHaveLength(0);
    const registrations = (await executableSymbols(sourceText))
      .filter((symbol) => symbol.kind === 'event_registration');
    expect(registrations).toHaveLength(lifecycleEvents.length);
    expect(registrations.map((symbol) => symbol.importExportEvidence?.eventName).sort())
      .toEqual([...lifecycleEvents].sort());
  });

  it('omits facade lifecycle emits and publishes', () => {
    const sourceText = lifecycleEvents
      .flatMap((eventName) => [
        `cds.emit('${eventName}');`,
        `cds.publish('${eventName}');`,
      ])
      .join('\n');
    expect(eventFacts(sourceText)).toHaveLength(0);
  });

  it('omits error subscriptions but keeps error emission', () => {
    expect(eventFacts(`
      cds.on('error', () => undefined);
      srv.on('error', () => undefined);
      messaging.on('error', () => undefined);
      messaging.emit('error', {});
    `)).toEqual([
      expect.objectContaining({ callType: 'async_emit', eventNameExpr: 'error' }),
    ]);
  });

  it('preserves domain events and receiver-scoped boundary cases', () => {
    const events = eventFacts(`
      messaging.on('OrderCreated', () => undefined);
      messaging.emit('OrderCreated', {});
      messaging.publish('OrderShipped', {});
      cds.on('FacadeCustom', () => undefined);
      srv.on('listening', () => undefined);
    `);
    expect(events.map((event) => [event.callType, event.eventNameExpr])).toEqual([
      ['async_subscribe', 'OrderCreated'],
      ['async_emit', 'OrderCreated'],
      ['async_emit', 'OrderShipped'],
      ['async_subscribe', 'FacadeCustom'],
      ['async_subscribe', 'listening'],
    ]);
    expect(events.every((event) =>
      event.evidence?.receiverClassification === 'cap_evidence')).toBe(true);
  });
});

describe('object send method fallback evidence', () => {
  it('defaults only present dynamic methods with explicit evidence', () => {
    const calls = classifiedFacts(`
      async function run(client: unknown, method: string): Promise<void> {
        await client.send({ method, path: '/dynamic' });
        await client.send({ method: chooseMethod(), path: '/expression' });
        await client.send({ method: 'PATCH', path: '/static' });
        await client.send({ path: '/default' });
      }
    `).filter((fact) => fact.callType === 'remote_action');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'PATCH', 'POST']);
    expect(calls.map((call) => call.evidence?.dynamicMethodDefaulted))
      .toEqual([true, true, undefined, undefined]);
    expect(calls.every((call) => call.method !== 'method'
      && call.method !== 'chooseMethod()')).toBe(true);
  });
});

describe('lifecycle filtering SQLite and edge contract', () => {
  it('keeps facts, edges, symbols, and method evidence deterministic', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'service-flow-lifecycle-workspace-'));
    await createLifecycleWorkspace(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      linkWorkspace(db, workspaceId);
      const first = workspaceState(db);
      expectLifecycleWorkspaceState(first);
      linkWorkspace(db, workspaceId);
      expect(workspaceState(db)).toEqual(first);
      await indexWorkspace(db, workspaceId, { force: true });
      linkWorkspace(db, workspaceId);
      expect(workspaceState(db)).toEqual(first);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
