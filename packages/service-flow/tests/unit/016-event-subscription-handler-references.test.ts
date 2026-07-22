import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { parseExecutableSymbols } from '../../src/parsers/symbol-parser.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const sourceFile = 'src/register.ts';

const ordinarySource = `
// Non-ASCII prefix 前置🙂 proves offsets use TypeScript UTF-16 positions.
import { handlerFn, wrappedHandler, fallbackHandler } from './handlers';
import { HandlerClass } from './handler-class';
import * as ns from './namespace';
import { packageHandler } from '@neutral/event-handlers';

function localHandler(): void {}
function ordinaryTarget(): void {}
export function ordinaryCaller(): void { ordinaryTarget(); }
`;

const subscriptionSource = `
export async function register(): Promise<void> {
  messaging.on('EventFoo', handlerFn);
  messaging.on('EventBar', HandlerClass.method);
  messaging.on('EventBaz', guard(wrappedHandler));
  messaging.on('EventQux', guard(HandlerClass.wrappedMethod));
  messaging.on('EventNs', ns.exportedFn);
  messaging.on('EventLocal', localHandler);
  messaging.on('EventPackage', packageHandler);
  messaging.on('EventInline', (message) => void message);
  messaging.on('EventFunction', function namedInline(message) { return message; });
  messaging.on('EventMulti', guard(handlerFn, options));
  messaging.on('EventNested', outer(guard(handlerFn)));
  messaging.on('EventWrappedInline', guard((message) => void message));
  messaging.on('error', handlerFn);
  cds.on('served', handlerFn);
  messaging.once('EventOnce', handlerFn);
}

export async function registerFallback(): Promise<void> {
  const queue = await cds.connect.to('messaging');
  queue.on('EventFallback', fallbackHandler);
}
`;

const fullSource = `${ordinarySource}${subscriptionSource}`;

type Parsed = Awaited<ReturnType<typeof parseExecutableSymbols>>;
type ParsedCall = Parsed['calls'][number];

interface ExpectedHandlerCall {
  expression: string;
  localName: string;
  importSource?: string;
  relation: string;
  wrapperFunction?: string;
}

const expectedHandlerCalls: ExpectedHandlerCall[] = [
  {
    expression: 'HandlerClass.method',
    localName: 'HandlerClass.method',
    importSource: './handler-class',
    relation: 'relative_import',
  },
  {
    expression: 'HandlerClass.wrappedMethod',
    localName: 'HandlerClass.wrappedMethod',
    importSource: './handler-class',
    relation: 'relative_import',
    wrapperFunction: 'guard',
  },
  {
    expression: 'fallbackHandler',
    localName: 'fallbackHandler',
    importSource: './handlers',
    relation: 'relative_import',
  },
  {
    expression: 'handlerFn',
    localName: 'handlerFn',
    importSource: './handlers',
    relation: 'relative_import',
  },
  {
    expression: 'localHandler',
    localName: 'localHandler',
    relation: 'indexed_local_symbol',
  },
  {
    expression: 'ns.exportedFn',
    localName: 'exportedFn',
    importSource: './namespace',
    relation: 'relative_import_namespace_member',
  },
  {
    expression: 'packageHandler',
    localName: 'packageHandler',
    importSource: '@neutral/event-handlers',
    relation: 'package_import',
  },
  {
    expression: 'wrappedHandler',
    localName: 'wrappedHandler',
    importSource: './handlers',
    relation: 'relative_import',
    wrapperFunction: 'guard',
  },
];

function handlerReferenceCalls(parsed: Parsed): ParsedCall[] {
  return parsed.calls.filter((call) =>
    call.callRole === 'event_subscribe_handler');
}

function stableCall(call: ParsedCall): Record<string, unknown> {
  return {
    callerQualifiedName: call.callerQualifiedName,
    calleeExpression: call.calleeExpression,
    calleeLocalName: call.calleeLocalName,
    receiverLocalName: call.receiverLocalName,
    importSource: call.importSource,
    sourceFile: call.sourceFile,
    sourceLine: call.sourceLine,
    callSiteStartOffset: call.callSiteStartOffset,
    callSiteEndOffset: call.callSiteEndOffset,
    callRole: call.callRole,
    evidence: call.evidence,
  };
}

function sourceLine(needle: string): number {
  const index = fullSource.split('\n').findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`Missing source line for ${needle}`);
  return index + 1;
}

async function writeParserFixture(root: string, source: string): Promise<void> {
  await writeFixtureFile(root, sourceFile, source);
}

type FixtureFile = readonly [relativePath: string, content: string];

const fixtureFiles: FixtureFile[] = [
  ['event-app/.git-fixture', ''],
  ['event-app/package.json', JSON.stringify({
    name: '@neutral/event-app',
    version: '1.0.0',
    dependencies: { '@neutral/event-handlers': '1.0.0' },
  })],
  [`event-app/${sourceFile}`, fullSource],
  ['event-app/src/handlers.ts', `
    export function handlerFn(): void {}
    export function wrappedHandler(): void {}
    export function fallbackHandler(): void {}
  `],
  ['event-app/src/handler-class.ts', `
    export class HandlerClass {
      static method(): void {}
      static wrappedMethod(): void {}
    }
  `],
  ['event-app/src/namespace.ts', 'export function exportedFn(): void {}\n'],
  ['event-handlers/.git-fixture', ''],
  ['event-handlers/package.json', JSON.stringify({
    name: '@neutral/event-handlers', version: '1.0.0',
  })],
  ['event-handlers/src/package-handler.ts',
    'export function packageHandler(): void {}\n'],
];

async function createWorkspaceFixture(root: string): Promise<void> {
  await Promise.all(fixtureFiles.map(([relativePath, content]) =>
    writeFixtureFile(root, relativePath, content)));
}

interface SubscriptionRow {
  eventName: string;
  expression: string | null;
  importSource: string | null;
  status: string | null;
  callerMatches: number | null;
  callerKind: string | null;
  callerQualifiedName: string | null;
  targetSourceFile: string | null;
  targetQualifiedName: string | null;
  targetRepoName: string | null;
  relation: string | null;
  calleeLocalName: string | null;
  wrapperFunction: string | null;
  candidateStrategy: string | null;
  candidateCount: number | null;
  factOrigin: string | null;
  callRole: string | null;
  subscribeStartOffset: number | null;
  subscribeEndOffset: number | null;
  handlerStartOffset: number | null;
  handlerEndOffset: number | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function subscriptionRows(db: Db): SubscriptionRow[] {
  return db.prepare(`SELECT oc.event_name_expr eventName,
      sc.callee_expression expression,sc.import_source importSource,sc.status,
      CASE WHEN sc.caller_symbol_id=oc.source_symbol_id THEN 1 ELSE 0 END callerMatches,
      caller.kind callerKind,caller.qualified_name callerQualifiedName,
      target.source_file targetSourceFile,target.qualified_name targetQualifiedName,
      targetRepo.name targetRepoName,
      json_extract(sc.evidence_json,'$.relation') relation,
      json_extract(sc.evidence_json,'$.targetName') calleeLocalName,
      json_extract(sc.evidence_json,'$.wrapperFunction') wrapperFunction,
      json_extract(sc.evidence_json,'$.candidateStrategy') candidateStrategy,
      json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
      json_extract(sc.evidence_json,'$.factOrigin') factOrigin,
      sc.call_role callRole,
      oc.call_site_start_offset subscribeStartOffset,
      oc.call_site_end_offset subscribeEndOffset,
      sc.call_site_start_offset handlerStartOffset,
      sc.call_site_end_offset handlerEndOffset
    FROM outbound_calls oc
    LEFT JOIN symbol_calls sc ON sc.repo_id=oc.repo_id
      AND sc.source_file=oc.source_file
      AND sc.call_site_start_offset=oc.call_site_start_offset
      AND sc.call_site_end_offset=oc.call_site_end_offset
      AND sc.call_role='event_subscribe_handler'
    LEFT JOIN symbols caller ON caller.id=sc.caller_symbol_id
    LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
    LEFT JOIN repositories targetRepo ON targetRepo.id=target.repo_id
    WHERE oc.call_type='async_subscribe'
    ORDER BY oc.event_name_expr,sc.callee_expression`).all().map((row) => ({
      eventName: String(row.eventName ?? ''),
      expression: nullableString(row.expression),
      importSource: nullableString(row.importSource),
      status: nullableString(row.status),
      callerMatches: nullableNumber(row.callerMatches),
      callerKind: nullableString(row.callerKind),
      callerQualifiedName: nullableString(row.callerQualifiedName),
      targetSourceFile: nullableString(row.targetSourceFile),
      targetQualifiedName: nullableString(row.targetQualifiedName),
      targetRepoName: nullableString(row.targetRepoName),
      relation: nullableString(row.relation),
      calleeLocalName: nullableString(row.calleeLocalName),
      wrapperFunction: nullableString(row.wrapperFunction),
      candidateStrategy: nullableString(row.candidateStrategy),
      candidateCount: nullableNumber(row.candidateCount),
      factOrigin: nullableString(row.factOrigin),
      callRole: nullableString(row.callRole),
      subscribeStartOffset: nullableNumber(row.subscribeStartOffset),
      subscribeEndOffset: nullableNumber(row.subscribeEndOffset),
      handlerStartOffset: nullableNumber(row.handlerStartOffset),
      handlerEndOffset: nullableNumber(row.handlerEndOffset),
    }));
}

function rowFor(rows: SubscriptionRow[], eventName: string): SubscriptionRow {
  const row = rows.find((candidate) => candidate.eventName === eventName);
  if (!row) throw new Error(`Expected subscription row for ${eventName}`);
  return row;
}

function databaseCounts(db: Db): Record<string, number> {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM symbols) symbols,
    (SELECT COUNT(*) FROM symbol_calls) symbolCalls,
    (SELECT COUNT(*) FROM outbound_calls WHERE call_type='async_subscribe') subscriptions,
    (SELECT COUNT(*) FROM outbound_calls WHERE call_type='async_emit') emissions,
    (SELECT COUNT(*) FROM graph_edges) graphEdges,
    (SELECT COUNT(*) FROM graph_edges
      WHERE edge_type='EVENT_CONSUMED_BY_HANDLER') subscriptionEdges`).get();
  return {
    symbols: Number(row?.symbols ?? 0),
    symbolCalls: Number(row?.symbolCalls ?? 0),
    subscriptions: Number(row?.subscriptions ?? 0),
    emissions: Number(row?.emissions ?? 0),
    graphEdges: Number(row?.graphEdges ?? 0),
    subscriptionEdges: Number(row?.subscriptionEdges ?? 0),
  };
}

function stableState(db: Db): Record<string, unknown> {
  return {
    rows: subscriptionRows(db),
    counts: databaseCounts(db),
    eventSymbols: db.prepare(`SELECT source_file sourceFile,start_line startLine,
      qualified_name qualifiedName FROM symbols WHERE kind='event_registration'
      ORDER BY source_file,start_line,qualified_name`).all(),
  };
}

const negativeEvents = [
  'EventFunction', 'EventInline', 'EventMulti', 'EventNested', 'EventWrappedInline',
];

function expectResolvedHandlerRows(rows: SubscriptionRow[]): void {
  expect(rows).toHaveLength(13);
  expect(rows.filter((row) => row.expression !== null)).toHaveLength(8);
  expect(rows.filter((row) => row.expression !== null)
    .every((row) => row.status === 'resolved'
      && row.callerMatches === 1
      && row.callRole === 'event_subscribe_handler'
      && row.factOrigin === 'event_subscribe_handler_reference'
      && row.subscribeStartOffset === row.handlerStartOffset
      && row.subscribeEndOffset === row.handlerEndOffset)).toBe(true);
  for (const eventName of negativeEvents)
    expect(rowFor(rows, eventName)).toMatchObject({ expression: null, status: null });

  expect(rowFor(rows, 'EventFoo')).toMatchObject({
    expression: 'handlerFn', importSource: './handlers', relation: 'relative_import',
    calleeLocalName: 'handlerFn', candidateStrategy: 'relative_import_exported_exact',
    candidateCount: 1, targetSourceFile: 'src/handlers.ts',
    targetQualifiedName: 'handlerFn', callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventBar')).toMatchObject({
    expression: 'HandlerClass.method', importSource: './handler-class',
    relation: 'relative_import', calleeLocalName: 'HandlerClass.method',
    candidateStrategy: 'relative_import_exported_exact', candidateCount: 1,
    targetSourceFile: 'src/handler-class.ts',
    targetQualifiedName: 'HandlerClass.method', callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventBaz')).toMatchObject({
    expression: 'wrappedHandler', wrapperFunction: 'guard',
    relation: 'relative_import', targetQualifiedName: 'wrappedHandler',
    callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventQux')).toMatchObject({
    expression: 'HandlerClass.wrappedMethod', wrapperFunction: 'guard',
    relation: 'relative_import', targetQualifiedName: 'HandlerClass.wrappedMethod',
    callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventNs')).toMatchObject({
    expression: 'ns.exportedFn', importSource: './namespace',
    relation: 'relative_import_namespace_member', calleeLocalName: 'exportedFn',
    candidateStrategy: 'relative_import_namespace_member', candidateCount: 1,
    targetSourceFile: 'src/namespace.ts', targetQualifiedName: 'exportedFn',
    callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventLocal')).toMatchObject({
    expression: 'localHandler', importSource: null,
    relation: 'indexed_local_symbol', calleeLocalName: 'localHandler',
    candidateStrategy: 'same_file_exact', candidateCount: 1,
    targetSourceFile: sourceFile, targetQualifiedName: 'localHandler',
    callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventPackage')).toMatchObject({
    expression: 'packageHandler', importSource: '@neutral/event-handlers',
    relation: 'package_import', calleeLocalName: 'packageHandler',
    candidateStrategy: 'package_import_workspace_resolved', candidateCount: 1,
    targetSourceFile: 'src/package-handler.ts', targetQualifiedName: 'packageHandler',
    targetRepoName: 'event-handlers', callerKind: 'event_registration',
  });
  expect(rowFor(rows, 'EventFallback')).toMatchObject({
    expression: 'fallbackHandler', importSource: './handlers',
    relation: 'relative_import', calleeLocalName: 'fallbackHandler',
    candidateStrategy: 'relative_import_exported_exact', candidateCount: 1,
    targetSourceFile: 'src/handlers.ts', targetQualifiedName: 'fallbackHandler',
    callerKind: 'function', callerQualifiedName: 'registerFallback',
  });
}

describe('event-subscription handler references', () => {
  it('adds only supported handler-reference facts without changing ordinary calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-event-handlers-parser-'));
    await writeParserFixture(root, ordinarySource);
    const baseline = await parseExecutableSymbols(root, sourceFile);
    await writeParserFixture(root, fullSource);
    const parsed = await parseExecutableSymbols(root, sourceFile);
    const handlers = handlerReferenceCalls(parsed);

    expect(parsed.calls.filter((call) => call.callRole === 'ordinary_call')
      .map(stableCall)).toEqual(baseline.calls.map(stableCall));
    expect(parsed.calls).toHaveLength(baseline.calls.length + expectedHandlerCalls.length);
    expect(handlers.map((call) => ({
      expression: call.calleeExpression,
      localName: call.calleeLocalName,
      relation: call.evidence.relation,
      ...(call.importSource ? { importSource: call.importSource } : {}),
      ...(typeof call.evidence.wrapperFunction === 'string'
        ? { wrapperFunction: call.evidence.wrapperFunction }
        : {}),
    })).sort((left, right) => left.expression.localeCompare(right.expression)))
      .toEqual([...expectedHandlerCalls]
        .sort((left, right) => left.expression.localeCompare(right.expression)));
    expect(handlers.every((call) =>
      call.evidence.factOrigin === 'event_subscribe_handler_reference'
      && call.evidence.candidateStrategy === undefined
      && typeof call.callSiteStartOffset === 'number'
      && typeof call.callSiteEndOffset === 'number'
      && call.callSiteEndOffset > call.callSiteStartOffset)).toBe(true);
    expect(handlers.find((call) => call.calleeExpression === 'handlerFn')
      ?.callerQualifiedName).toMatch(/^module:src\/register\.ts#event:EventFoo:/);
    expect(handlers.find((call) => call.calleeExpression === 'fallbackHandler'))
      .toMatchObject({ callerQualifiedName: 'registerFallback' });

    for (const needle of [
      "'EventInline'", "'EventFunction'", "'EventMulti'", "'EventNested'",
      "'EventWrappedInline'", "'error'", "'served'", "'EventOnce'",
    ]) expect(handlers.some((call) => call.sourceLine === sourceLine(needle))).toBe(false);

    const source = ts.createSourceFile(
      sourceFile, fullSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
    const expectedStart = fullSource.indexOf("messaging.on('EventFoo'");
    const eventFoo = handlers.find((call) => call.calleeExpression === 'handlerFn');
    expect(source.getLineAndCharacterOfPosition(expectedStart).line + 1)
      .toBe(eventFoo?.sourceLine);
    expect(eventFoo?.callSiteStartOffset).toBe(expectedStart);
    expect(Buffer.byteLength(fullSource.slice(0, expectedStart), 'utf8'))
      .not.toBe(expectedStart);
  });

  it('resolves, anchors, and reproduces handler rows through link and force index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-event-handlers-db-'));
    await createWorkspaceFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      const indexedRows = subscriptionRows(db);
      expect(indexedRows.filter((row) => row.expression !== null)).toHaveLength(8);
      expect(rowFor(indexedRows, 'EventPackage')).toMatchObject({
        status: 'unresolved', candidateStrategy: 'package_import_unresolved',
        candidateCount: 0, targetSourceFile: null,
      });
      expect(indexedRows.filter((row) => row.expression !== null
        && row.eventName !== 'EventPackage')
        .every((row) => row.status === 'resolved')).toBe(true);

      linkWorkspace(db, workspaceId);
      expectResolvedHandlerRows(subscriptionRows(db));
      expect(databaseCounts(db)).toEqual({
        symbols: 26,
        symbolCalls: 9,
        subscriptions: 13,
        emissions: 0,
        graphEdges: 27,
        subscriptionEdges: 13,
      });
      expect(db.prepare(`SELECT COUNT(*) count FROM symbols
        WHERE kind='event_registration' AND source_file=? AND start_line=?`)
        .get(sourceFile, sourceLine("'EventFallback'"))?.count).toBe(0);
      expect(db.prepare(`SELECT COUNT(*) count FROM symbols
        WHERE kind='event_registration'`).get()?.count).toBe(14);
      expect(db.prepare(`SELECT sc.status,caller.qualified_name callerQualifiedName,
        target.qualified_name targetQualifiedName,
        json_extract(sc.evidence_json,'$.candidateStrategy') candidateStrategy,
        json_extract(sc.evidence_json,'$.candidateCount') candidateCount
        FROM symbol_calls sc
        LEFT JOIN symbols caller ON caller.id=sc.caller_symbol_id
        LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
        WHERE sc.callee_expression='ordinaryTarget'`).get()).toMatchObject({
        status: 'resolved', callerQualifiedName: 'ordinaryCaller',
        targetQualifiedName: 'ordinaryTarget', candidateStrategy: 'same_file_exact',
        candidateCount: 1,
      });
      expect(db.prepare(`SELECT status,COUNT(*) count FROM graph_edges
        WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
        GROUP BY status ORDER BY status`).all()).toEqual([
        { status: 'resolved', count: 8 },
        { status: 'unresolved', count: 5 },
      ]);

      const first = stableState(db);
      linkWorkspace(db, workspaceId);
      expect(stableState(db)).toEqual(first);
      await indexWorkspace(db, workspaceId, { force: true });
      linkWorkspace(db, workspaceId);
      expect(stableState(db)).toEqual(first);
      await indexWorkspace(db, workspaceId, { force: true });
      linkWorkspace(db, workspaceId);
      expect(stableState(db)).toEqual(first);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
