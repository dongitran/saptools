import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type FixtureFile = readonly [relativePath: string, content: string];

const packageName = '@neutral/shape-handlers';
const cappedPackageName = '@neutral/capped-handlers';

const consumerSource = `
import defaultAlias from '${packageName}';
import { namedHandler as esmAlias } from '${packageName}';
import * as esmHandlers from '${packageName}';
import { hiddenHandler } from '${packageName}/internal';
import { yBeyond, zDuplicate } from '${cappedPackageName}';
const { cjsNamed: cjsAlias } = require('${packageName}');
const cjsHandlers = require('${packageName}');

export function register(): void {
  messaging.on('DefaultEvent', defaultAlias);
  messaging.on('EsmAliasEvent', esmAlias);
  messaging.on('EsmNamespaceEvent', esmHandlers.namespaceHandler);
  messaging.on('CjsAliasEvent', cjsAlias);
  messaging.on('CjsNamespaceEvent', cjsHandlers.cjsNamespaceHandler);
  messaging.on('WrongSubpathEvent', hiddenHandler);
  messaging.on('BeyondCapEvent', yBeyond);
  messaging.on('HiddenDuplicateEvent', zDuplicate);
}
`;

const shapePackageSource = `
export default function defaultHandler(): void {}
export function namedHandler(): void {}
export function namespaceHandler(): void {}
export function cjsNamed(): void {}
export function cjsNamespaceHandler(): void {}
`;

function cappedIndexSource(): string {
  const fillers = Array.from(
    { length: 127 },
    (_, index) =>
      `export function a${String(index).padStart(3, '0')}(): void {}`,
  ).join('\n');
  return `${fillers}
export { yBeyond } from './late';
export * from './duplicate-a';
export * from './duplicate-b';
`;
}

function fixtureFiles(): FixtureFile[] {
  return [
    ['app/.git-fixture', ''],
    ['app/package.json', JSON.stringify({
      name: '@neutral/app',
      dependencies: {
        [packageName]: '1.0.0',
        [cappedPackageName]: '1.0.0',
      },
    })],
    ['app/src/register.ts', consumerSource],
    ['shape-handlers/.git-fixture', ''],
    ['shape-handlers/package.json', JSON.stringify({
      name: packageName,
      exports: { '.': './src/index.ts' },
    })],
    ['shape-handlers/src/index.ts', shapePackageSource],
    ['shape-handlers/src/internal.ts',
      'export function hiddenHandler(): void {}\n'],
    ['capped-handlers/.git-fixture', ''],
    ['capped-handlers/package.json', JSON.stringify({
      name: cappedPackageName,
      exports: { '.': './src/index.ts' },
    })],
    ['capped-handlers/src/index.ts', cappedIndexSource()],
    ['capped-handlers/src/late.ts',
      'export function yBeyond(): void {}\n'],
    ['capped-handlers/src/duplicate-a.ts',
      'export function zDuplicate(): void {}\n'],
    ['capped-handlers/src/duplicate-b.ts',
      'export function zDuplicate(): void {}\n'],
  ];
}

async function createFixture(root: string): Promise<void> {
  await Promise.all(fixtureFiles().map(([relativePath, content]) =>
    writeFixtureFile(root, relativePath, content)));
}

interface HandlerCall {
  eventName: string;
  expression: string;
  status: string;
  reason: string | null;
  strategy: string;
  candidateCount: number;
  eligibleCount: number;
  selectedCount: number;
  candidateSetComplete: number;
  bindingKind: string;
  localName: string;
  importedName: string | null;
  moduleSubpath: string;
  referenceShape: string;
  callerKind: string;
  callerStart: number;
  callerEnd: number;
  callStart: number;
  callEnd: number;
  targetName: string | null;
  targetSourceFile: string | null;
  targetPackageName: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringValue(value: unknown): string {
  return optionalString(value) ?? '';
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function handlerCall(row: Record<string, unknown>): HandlerCall {
  return {
    eventName: stringValue(row.eventName),
    expression: stringValue(row.expression),
    status: stringValue(row.status),
    reason: optionalString(row.reason),
    strategy: stringValue(row.strategy),
    candidateCount: numberValue(row.candidateCount),
    eligibleCount: numberValue(row.eligibleCount),
    selectedCount: numberValue(row.selectedCount),
    candidateSetComplete: numberValue(row.candidateSetComplete),
    bindingKind: stringValue(row.bindingKind),
    localName: stringValue(row.localName),
    importedName: optionalString(row.importedName),
    moduleSubpath: stringValue(row.moduleSubpath),
    referenceShape: stringValue(row.referenceShape),
    callerKind: stringValue(row.callerKind),
    callerStart: numberValue(row.callerStart, -1),
    callerEnd: numberValue(row.callerEnd, -1),
    callStart: numberValue(row.callStart, -1),
    callEnd: numberValue(row.callEnd, -1),
    targetName: optionalString(row.targetName),
    targetSourceFile: optionalString(row.targetSourceFile),
    targetPackageName: optionalString(row.targetPackageName),
  };
}

function handlerCalls(db: Db): HandlerCall[] {
  return db.prepare(`SELECT oc.event_name_expr eventName,
    sc.callee_expression expression,sc.status,sc.unresolved_reason reason,
    json_extract(sc.evidence_json,'$.candidateStrategy') strategy,
    json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
    json_extract(sc.evidence_json,'$.eligibleCandidateCount') eligibleCount,
    json_extract(sc.evidence_json,'$.selectedCandidateCount') selectedCount,
    json_extract(sc.evidence_json,'$.candidateSetComplete') candidateSetComplete,
    json_extract(sc.evidence_json,'$.importBinding.bindingKind') bindingKind,
    json_extract(sc.evidence_json,'$.importBinding.localName') localName,
    json_extract(sc.evidence_json,'$.importBinding.importedName') importedName,
    json_extract(sc.evidence_json,
      '$.importBinding.requestedModuleSubpath') moduleSubpath,
    json_extract(sc.evidence_json,
      '$.importBinding.referenceShape') referenceShape,
    caller.kind callerKind,caller.start_offset callerStart,
    caller.end_offset callerEnd,sc.call_site_start_offset callStart,
    sc.call_site_end_offset callEnd,target.qualified_name targetName,
    target.source_file targetSourceFile,targetRepo.package_name targetPackageName
    FROM symbol_calls sc
    JOIN outbound_calls oc ON oc.repo_id=sc.repo_id
      AND oc.source_file=sc.source_file
      AND oc.call_site_start_offset=sc.call_site_start_offset
      AND oc.call_site_end_offset=sc.call_site_end_offset
      AND oc.call_type='async_subscribe'
    JOIN symbols caller ON caller.id=sc.caller_symbol_id
    LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
    LEFT JOIN repositories targetRepo ON targetRepo.id=target.repo_id
    WHERE sc.call_role='event_subscribe_handler'
    ORDER BY oc.event_name_expr COLLATE BINARY`).all().map(handlerCall);
}

function callByEvent(rows: HandlerCall[], eventName: string): HandlerCall {
  const row = rows.find((item) => item.eventName === eventName);
  if (!row) throw new Error(`Missing handler call for ${eventName}`);
  return row;
}

interface PositiveExpectation {
  eventName: string;
  expression: string;
  bindingKind: string;
  localName: string;
  importedName: string | null;
  referenceShape: string;
  targetName: string;
}

const positiveExpectations: PositiveExpectation[] = [
  {
    eventName: 'DefaultEvent', expression: 'defaultAlias',
    bindingKind: 'esm_default', localName: 'defaultAlias',
    importedName: 'default', referenceShape: 'identifier',
    targetName: 'defaultHandler',
  },
  {
    eventName: 'EsmAliasEvent', expression: 'esmAlias',
    bindingKind: 'esm_named', localName: 'esmAlias',
    importedName: 'namedHandler', referenceShape: 'identifier',
    targetName: 'namedHandler',
  },
  {
    eventName: 'EsmNamespaceEvent',
    expression: 'esmHandlers.namespaceHandler',
    bindingKind: 'esm_namespace', localName: 'esmHandlers',
    importedName: null, referenceShape: 'namespace_member',
    targetName: 'namespaceHandler',
  },
  {
    eventName: 'CjsAliasEvent', expression: 'cjsAlias',
    bindingKind: 'cjs_destructured', localName: 'cjsAlias',
    importedName: 'cjsNamed', referenceShape: 'identifier',
    targetName: 'cjsNamed',
  },
  {
    eventName: 'CjsNamespaceEvent',
    expression: 'cjsHandlers.cjsNamespaceHandler',
    bindingKind: 'cjs_namespace', localName: 'cjsHandlers',
    importedName: null, referenceShape: 'namespace_member',
    targetName: 'cjsNamespaceHandler',
  },
];

function assertPositiveCalls(rows: HandlerCall[]): void {
  for (const expected of positiveExpectations) {
    const row = callByEvent(rows, expected.eventName);
    expect(row).toMatchObject({
      ...expected,
      status: 'resolved',
      reason: null,
      strategy: 'package_public_surface_exact',
      candidateCount: 1,
      eligibleCount: 1,
      selectedCount: 1,
      candidateSetComplete: 1,
      moduleSubpath: '.',
      callerKind: 'event_registration',
      targetSourceFile: 'src/index.ts',
      targetPackageName: packageName,
    });
    expect([row.callerStart, row.callerEnd])
      .toEqual([row.callStart, row.callEnd]);
  }
}

function assertFailClosedCalls(rows: HandlerCall[]): void {
  expect(callByEvent(rows, 'WrongSubpathEvent')).toMatchObject({
    status: 'unresolved',
    reason: 'package_public_name_not_exposed',
    moduleSubpath: './internal',
    targetName: null,
    targetSourceFile: null,
    selectedCount: 0,
  });
  for (const eventName of ['BeyondCapEvent', 'HiddenDuplicateEvent']) {
    expect(callByEvent(rows, eventName)).toMatchObject({
      status: 'unresolved',
      reason: 'public_surface_evidence_incomplete',
      strategy: 'package_public_surface_unresolved',
      candidateSetComplete: 0,
      selectedCount: 0,
      targetName: null,
      targetSourceFile: null,
    });
  }
}

function assertCappedSurface(db: Db): void {
  const row = db.prepare(`SELECT
    json_extract(package_public_surface_json,'$.status') status,
    json_extract(package_public_surface_json,'$.total') total,
    json_extract(package_public_surface_json,'$.shown') shown,
    json_extract(package_public_surface_json,'$.omitted') omitted,
    json_extract(package_public_surface_json,'$.recordCap') recordCap,
    json_extract(package_public_surface_json,
      '$.scopes[#-1].publicName') lastPublicName
    FROM repositories WHERE package_name=?`).get(cappedPackageName);
  expect(row).toMatchObject({
    status: 'complete',
    shown: 255,
    recordCap: 256,
    lastPublicName: 'a126',
  });
  expect(Number(row?.omitted)).toBeGreaterThan(0);
  expect(Number(row?.total)).toBe(
    Number(row?.shown) + Number(row?.omitted),
  );
  expect(db.prepare(`SELECT qualified_name qualifiedName,COUNT(*) count
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE r.package_name=? AND qualified_name IN ('yBeyond','zDuplicate')
    GROUP BY qualified_name ORDER BY qualified_name COLLATE BINARY`)
    .all(cappedPackageName)).toEqual([
      { qualifiedName: 'yBeyond', count: 1 },
      { qualifiedName: 'zDuplicate', count: 2 },
    ]);
}

function assertEventEdges(db: Db): void {
  const rows = db.prepare(`SELECT ge.from_id eventName,ge.status,
    ge.to_kind toKind,target.qualified_name targetName
    FROM graph_edges ge
    LEFT JOIN symbols target ON ge.to_kind='symbol'
      AND ge.to_id=CAST(target.id AS TEXT)
    WHERE ge.edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
    ORDER BY ge.from_id COLLATE BINARY`).all();
  expect(rows).toHaveLength(8);
  expect(rows.filter((row) => row.status === 'resolved')).toHaveLength(5);
  expect(rows.filter((row) => row.status === 'unresolved')).toHaveLength(3);
  expect(rows.filter((row) => row.status === 'resolved')
    .map((row) => row.targetName).sort()).toEqual([
      'cjsNamed', 'cjsNamespaceHandler', 'defaultHandler',
      'namedHandler', 'namespaceHandler',
    ]);
  expect(rows.filter((row) => row.status !== 'resolved')
    .every((row) => row.toKind === 'symbol_reference'
      && row.targetName === null)).toBe(true);
}

describe('package import binding and public-surface integration matrix', () => {
  it('resolves exact package shapes and keeps hidden or truncated targets non-traversable', async () => {
    const root = await mkdtemp(path.join(
      os.tmpdir(), 'service-flow-package-shapes-',
    ));
    await createFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      linkWorkspace(db, workspaceId);
      const rows = handlerCalls(db);
      expect(rows).toHaveLength(8);
      assertPositiveCalls(rows);
      assertFailClosedCalls(rows);
      assertCappedSurface(db);
      assertEventEdges(db);
      expect(db.pragma('integrity_check')).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
