import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { indexWorkspace } from '../../src/indexer/workspace-indexer.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { parseExecutableSymbols } from '../../src/parsers/symbol-parser.js';
import { trace } from '../../src/trace/trace-engine.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const shadowHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { loadRecord } from '../helpers/record-helper';
function localStep(): void {}
@Handler()
export class ShadowHandler {
  async loadRecord(): Promise<void> { await loadRecord(); }
  runLocal(): void { localStep(); }
}
`;

const namespaceHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import * as utilityModule from '../namespaces';
function buildHeaders(): void {}
@Handler()
export class NamespaceHandler {
  async runNamespace(): Promise<void> {
    await utilityModule.buildHeaders();
    utilityModule.missingMember();
  }
}
`;

const directFormatHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { formatValue } from '../duplicates/value-helper';
@Handler()
export class DirectFormatHandler {
  runDirect(): string { return formatValue('direct'); }
}
`;

const barrelFormatHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { formatValue } from '../barrel';
@Handler()
export class BarrelFormatHandler {
  runBarrel(): string { return formatValue('barrel'); }
}
`;

const singletonHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { TaskService } from '../services/task-service';
@Handler()
export class SingletonHandler {
  async runSingleton(): Promise<void> {
    const direct = new TaskService();
    await TaskService.getInstance().execute();
    await TaskService.instance().execute();
    await direct.execute();
  }
}
`;

const packageHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { sharedUtil } from '@neutral/shared-helpers';
import { subpathUtil } from '@neutral/shared-helpers/sub';
import { duplicateName, hiddenUtil, Helper, OtherHelper, doWork, publicName, internalName } from '@neutral/shared-helpers';
import Anything from '@neutral/shared-helpers';
import { externalOnly } from '@neutral/external-only';
import { selfOnly } from '@neutral/app';
@Handler()
export class PackageHandler {
  runPackage(): void {
    sharedUtil();
    subpathUtil();
    duplicateName();
    hiddenUtil();
    Helper.doWork();
    OtherHelper.doWork();
    doWork();
    publicName();
    internalName();
    Anything();
    externalOnly();
    selfOnly();
  }
}
`;

type FixtureFile = readonly [relativePath: string, content: string];

const appFiles: FixtureFile[] = [
  ['app/.git-fixture', ''],
  ['app/package.json', JSON.stringify({ name: '@neutral/app', version: '1.0.0', dependencies: { '@neutral/shared-helpers': '1.0.0' } })],
  ['app/src/handlers/ShadowHandler.ts', shadowHandlerSource],
  ['app/src/handlers/NamespaceHandler.ts', namespaceHandlerSource],
  ['app/src/handlers/DirectFormatHandler.ts', directFormatHandlerSource],
  ['app/src/handlers/BarrelFormatHandler.ts', barrelFormatHandlerSource],
  ['app/src/handlers/SingletonHandler.ts', singletonHandlerSource],
  ['app/src/handlers/PackageHandler.ts', packageHandlerSource],
  ['app/src/self.ts', 'export function selfOnly(): void {}\n'],
  ['app/src/helpers/record-helper.ts', 'function helperLeaf(): void {}\nexport async function loadRecord(): Promise<void> { helperLeaf(); }\n'],
  ['app/src/namespaces/index.ts', 'function namespaceLeaf(): void {}\nexport async function buildHeaders(): Promise<void> { namespaceLeaf(); }\n'],
  ['app/src/duplicates/value-helper.ts', "export function formatValue(value: string): string { return `selected:${value}`; }\n"],
  ['app/src/duplicates/other-helper.ts', "export function formatValue(value: string): string { return `other:${value}`; }\nexport class OtherFormatter { static formatValue(value: string): string { return value; } }\n"],
  ['app/src/barrel/index.ts', "export * from '../duplicates/value-helper';\nexport * from '../duplicates/other-helper';\n"],
  ['app/src/services/task-service.ts', 'function serviceLeaf(): void {}\nexport class TaskService {\n  static getInstance(): TaskService { return new TaskService(); }\n  static instance(): TaskService { return new TaskService(); }\n  async execute(): Promise<void> { serviceLeaf(); }\n}\n'],
];

const packageFiles: FixtureFile[] = [
  ['shared-helpers/.git-fixture', ''],
  ['shared-helpers/package.json', JSON.stringify({ name: '@neutral/shared-helpers', version: '1.0.0' })],
  ['shared-helpers/src/shared-util.ts', 'function sharedLeaf(): void {}\nexport function sharedUtil(): void { sharedLeaf(); }\n'],
  ['shared-helpers/src/sub/subpath-util.ts', 'export function subpathUtil(): void {}\n'],
  ['shared-helpers/src/duplicates/first.ts', 'export function duplicateName(): void {}\n'],
  ['shared-helpers/src/duplicates/second.ts', 'export function duplicateName(): void {}\n'],
  ['shared-helpers/src/hidden.ts', 'function hiddenUtil(): void {}\nvoid hiddenUtil;\n'],
  ['shared-helpers/src/helper.ts', 'export const Helper = { doWork(): void {} };\nexport const OtherHelper = { otherWork(): void {} };\n'],
  ['shared-helpers/src/do-work.ts', 'export function doWork(): void {}\n'],
  ['shared-helpers/src/aliases.ts', 'function internalName(): void {}\nexport { internalName as publicName };\n'],
  ['shared-helpers/src/default.ts', 'export default function canonicalDefault(): void {}\n'],
];

const mismatchedPackageFiles: FixtureFile[] = [
  ['external-only/.git-fixture', ''],
  ['external-only/package.json', JSON.stringify({ name: '@neutral/different-package', version: '1.0.0' })],
  ['external-only/src/external-only.ts', 'export function externalOnly(): void {}\n'],
];

async function createFixture(root: string): Promise<void> {
  await Promise.all([...appFiles, ...packageFiles, ...mismatchedPackageFiles]
    .map(([relativePath, content]) => writeFixtureFile(root, relativePath, content)));
}

type ParsedSymbols = Awaited<ReturnType<typeof parseExecutableSymbols>>;

function parsedCall(parsed: ParsedSymbols, expression: string): ParsedSymbols['calls'][number] {
  const call = parsed.calls.find((candidate) => candidate.calleeExpression === expression);
  if (!call) throw new Error(`Expected parser call fact for ${expression}`);
  return call;
}

function expectParsedCall(parsed: ParsedSymbols, expression: string, expected: { calleeLocalName: string; importSource?: string; relation: string }): void {
  const call = parsedCall(parsed, expression);
  expect(call).toMatchObject({ calleeLocalName: expected.calleeLocalName, importSource: expected.importSource });
  expect(call.evidence).toMatchObject({ relation: expected.relation });
}

interface SymbolCallRow {
  id: number;
  sourceFile: string;
  sourceLine: number;
  expression: string;
  importSource: string | null;
  status: string;
  confidence: number;
  relation: string | null;
  candidateStrategy: string | null;
  candidateCount: number;
  resolvedModulePath: string | null;
  calleeSymbolId: number | null;
  targetSourceFile: string | null;
  targetName: string | null;
  targetQualifiedName: string | null;
  targetExportedName: string | null;
  targetExported: number | null;
  targetRepoName: string | null;
  targetPackageName: string | null;
  unresolvedReason: string | null;
  evidenceJson: string;
  evidenceValid: number;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function symbolCallRows(db: Db): SymbolCallRow[] {
  return db.prepare(`SELECT sc.id,sc.source_file sourceFile,sc.source_line sourceLine,
      sc.callee_expression expression,sc.import_source importSource,sc.status,sc.confidence,
      json_extract(sc.evidence_json,'$.relation') relation,
      json_extract(sc.evidence_json,'$.candidateStrategy') candidateStrategy,
      json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
      json_extract(sc.evidence_json,'$.resolvedModulePath') resolvedModulePath,
      sc.callee_symbol_id calleeSymbolId,s.source_file targetSourceFile,
      s.name targetName,s.qualified_name targetQualifiedName,
      s.exported_name targetExportedName,s.exported targetExported,
      targetRepo.name targetRepoName,targetRepo.package_name targetPackageName,
      sc.unresolved_reason unresolvedReason,sc.evidence_json evidenceJson,
      json_valid(sc.evidence_json) evidenceValid
    FROM symbol_calls sc
    LEFT JOIN symbols s ON s.id=sc.callee_symbol_id
    LEFT JOIN repositories targetRepo ON targetRepo.id=s.repo_id
    ORDER BY sc.source_file,sc.source_line,sc.callee_expression`).all().map((row) => ({
      id: Number(row.id ?? 0),
      sourceFile: String(row.sourceFile ?? ''),
      sourceLine: Number(row.sourceLine ?? 0),
      expression: String(row.expression ?? ''),
      importSource: nullableString(row.importSource),
      status: String(row.status ?? ''),
      confidence: Number(row.confidence ?? 0),
      relation: nullableString(row.relation),
      candidateStrategy: nullableString(row.candidateStrategy),
      candidateCount: Number(row.candidateCount ?? 0),
      resolvedModulePath: nullableString(row.resolvedModulePath),
      calleeSymbolId: typeof row.calleeSymbolId === 'number' ? row.calleeSymbolId : null,
      targetSourceFile: nullableString(row.targetSourceFile),
      targetName: nullableString(row.targetName),
      targetQualifiedName: nullableString(row.targetQualifiedName),
      targetExportedName: nullableString(row.targetExportedName),
      targetExported: typeof row.targetExported === 'number' ? row.targetExported : null,
      targetRepoName: nullableString(row.targetRepoName),
      targetPackageName: nullableString(row.targetPackageName),
      unresolvedReason: nullableString(row.unresolvedReason),
      evidenceJson: String(row.evidenceJson ?? ''),
      evidenceValid: Number(row.evidenceValid ?? 0),
    }));
}

function callRow(rows: SymbolCallRow[], sourceFile: string, expression: string): SymbolCallRow {
  const row = rows.find((candidate) => candidate.sourceFile === sourceFile && candidate.expression === expression);
  if (!row) throw new Error(`Expected persisted call ${sourceFile}:${expression}`);
  return row;
}

function assertShadowResolution(rows: SymbolCallRow[]): void {
  expect(callRow(rows, 'src/handlers/ShadowHandler.ts', 'loadRecord')).toMatchObject({
    status: 'resolved', relation: 'relative_import', candidateStrategy: 'relative_import_exported_exact',
    resolvedModulePath: 'src/helpers/record-helper', targetSourceFile: 'src/helpers/record-helper.ts', targetQualifiedName: 'loadRecord',
  });
  expect(callRow(rows, 'src/handlers/ShadowHandler.ts', 'localStep')).toMatchObject({
    status: 'resolved', importSource: null, candidateStrategy: 'same_file_exact',
    targetSourceFile: 'src/handlers/ShadowHandler.ts', targetQualifiedName: 'localStep',
  });
  expect(rows.some((row) => row.importSource?.startsWith('.') === true && row.candidateStrategy === 'same_file_exact' && row.targetSourceFile === row.sourceFile)).toBe(false);
}

function assertNamespaceResolution(rows: SymbolCallRow[]): void {
  expect(callRow(rows, 'src/handlers/NamespaceHandler.ts', 'utilityModule.buildHeaders')).toMatchObject({
    status: 'resolved', relation: 'relative_import_namespace_member', candidateStrategy: 'relative_import_namespace_member',
    candidateCount: 1, resolvedModulePath: 'src/namespaces/index', targetSourceFile: 'src/namespaces/index.ts', targetQualifiedName: 'buildHeaders',
  });
  expect(callRow(rows, 'src/handlers/NamespaceHandler.ts', 'utilityModule.missingMember')).toMatchObject({
    status: 'unresolved', relation: 'relative_import_namespace_member', candidateStrategy: 'relative_import_namespace_member',
    candidateCount: 0, targetSourceFile: null,
  });
}

function assertDuplicateResolution(rows: SymbolCallRow[]): void {
  expect(callRow(rows, 'src/handlers/DirectFormatHandler.ts', 'formatValue')).toMatchObject({
    status: 'resolved', candidateStrategy: 'relative_import_path_disambiguated', candidateCount: 3,
    resolvedModulePath: 'src/duplicates/value-helper', targetSourceFile: 'src/duplicates/value-helper.ts', targetQualifiedName: 'formatValue',
  });
  expect(callRow(rows, 'src/handlers/BarrelFormatHandler.ts', 'formatValue')).toMatchObject({
    status: 'ambiguous', candidateStrategy: 'exported_exact', candidateCount: 3,
    resolvedModulePath: null, targetSourceFile: null,
  });
}

function assertSingletonResolution(rows: SymbolCallRow[]): void {
  for (const expression of ['TaskService.getInstance().execute', 'TaskService.instance().execute']) {
    expect(callRow(rows, 'src/handlers/SingletonHandler.ts', expression)).toMatchObject({
      status: 'resolved', relation: 'relative_import', candidateStrategy: 'relative_import_static_accessor_instance_method',
      candidateCount: 1, resolvedModulePath: 'src/services/task-service', targetSourceFile: 'src/services/task-service.ts',
      targetQualifiedName: 'TaskService.execute', targetExported: 0,
    });
  }
  expect(callRow(rows, 'src/handlers/SingletonHandler.ts', 'direct.execute')).toMatchObject({
    status: 'resolved', relation: 'class_instance_method', candidateStrategy: 'relative_import_class_instance_method',
    targetSourceFile: 'src/services/task-service.ts', targetQualifiedName: 'TaskService.execute', targetExported: 0,
  });
}

const packageHandlerFile = 'src/handlers/PackageHandler.ts';

function packageRows(rows: SymbolCallRow[]): SymbolCallRow[] {
  return rows.filter((row) => row.sourceFile === packageHandlerFile && row.relation === 'package_import');
}

function assertPackageIndexBaseline(rows: SymbolCallRow[]): void {
  const calls = packageRows(rows);
  expect(calls).toHaveLength(12);
  expect(calls.every((row) => row.status === 'unresolved'
    && row.candidateStrategy === 'package_import_unresolved'
    && row.candidateCount === 0
    && row.calleeSymbolId === null
    && row.resolvedModulePath === null)).toBe(true);
}

function expectResolvedPackageCall(
  rows: SymbolCallRow[],
  expression: string,
  expected: { importSource: string; sourceFile: string; qualifiedName: string; name?: string; exportedName?: string },
): void {
  const row = callRow(rows, packageHandlerFile, expression);
  expect(typeof row.calleeSymbolId).toBe('number');
  expect(row).toMatchObject({
    status: 'resolved', confidence: 0.8, relation: 'package_import',
    candidateStrategy: 'package_import_workspace_resolved', candidateCount: 1,
    importSource: expected.importSource, resolvedModulePath: expected.sourceFile.replace(/\.ts$/, ''),
    targetSourceFile: expected.sourceFile, targetName: expected.name ?? expected.qualifiedName,
    targetQualifiedName: expected.qualifiedName, targetExportedName: expected.exportedName ?? expected.qualifiedName,
    targetExported: 1, targetRepoName: 'shared-helpers', targetPackageName: '@neutral/shared-helpers',
    unresolvedReason: null,
  });
}

function assertResolvedPackageCalls(rows: SymbolCallRow[]): void {
  const packageName = '@neutral/shared-helpers';
  expectResolvedPackageCall(rows, 'sharedUtil', { importSource: packageName, sourceFile: 'src/shared-util.ts', qualifiedName: 'sharedUtil' });
  expectResolvedPackageCall(rows, 'subpathUtil', { importSource: `${packageName}/sub`, sourceFile: 'src/sub/subpath-util.ts', qualifiedName: 'subpathUtil' });
  expectResolvedPackageCall(rows, 'Helper.doWork', { importSource: packageName, sourceFile: 'src/helper.ts', qualifiedName: 'Helper.doWork' });
  expectResolvedPackageCall(rows, 'doWork', { importSource: packageName, sourceFile: 'src/do-work.ts', qualifiedName: 'doWork' });
  expectResolvedPackageCall(rows, 'publicName', {
    importSource: packageName, sourceFile: 'src/aliases.ts', qualifiedName: 'internalName',
    name: 'internalName', exportedName: 'publicName',
  });
}

function assertFailClosedPackageCalls(rows: SymbolCallRow[]): void {
  for (const expression of ['hiddenUtil', 'OtherHelper.doWork', 'internalName', 'Anything']) {
    const row = callRow(rows, packageHandlerFile, expression);
    expect(row.unresolvedReason).toContain('Sibling package indexed but no matching exported symbol');
    expect(row).toMatchObject({
      status: 'unresolved', candidateStrategy: 'package_import_unresolved', candidateCount: 0,
      calleeSymbolId: null, resolvedModulePath: null, targetSourceFile: null,
    });
  }
  for (const expression of ['externalOnly', 'selfOnly']) {
    expect(callRow(rows, packageHandlerFile, expression)).toMatchObject({
      status: 'unresolved', candidateStrategy: 'package_import_unresolved', candidateCount: 0,
      calleeSymbolId: null, resolvedModulePath: null, targetSourceFile: null,
      unresolvedReason: 'Package import target resolution requires a post-publication workspace pass',
    });
  }
}

function assertPackageResolution(rows: SymbolCallRow[]): void {
  assertResolvedPackageCalls(rows);
  assertFailClosedPackageCalls(rows);
  expect(callRow(rows, packageHandlerFile, 'duplicateName')).toMatchObject({
    status: 'ambiguous', relation: 'package_import', candidateStrategy: 'package_import_ambiguous',
    candidateCount: 2, calleeSymbolId: null, resolvedModulePath: null, targetSourceFile: null,
    unresolvedReason: 'Multiple exported sibling-package symbol targets matched exactly',
  });
  const calls = packageRows(rows);
  expect(calls).toHaveLength(12);
  expect(calls.filter((row) => row.candidateStrategy === 'package_import_workspace_resolved')).toHaveLength(5);
  expect(calls.filter((row) => row.candidateStrategy === 'package_import_unresolved')).toHaveLength(6);
  expect(calls.filter((row) => row.candidateStrategy === 'package_import_ambiguous')).toHaveLength(1);
  expect(calls.every((row) => row.confidence === 0.8)).toBe(true);
  expect(calls.every((row) => row.evidenceValid === 1 && row.evidenceJson.length < 4096)).toBe(true);
}

function localTraceEdges(db: Db, workspaceId: number, handler: string): string[] {
  return trace(db, { repo: 'app', handler }, { depth: 8, workspaceId }).edges
    .filter((edge) => edge.type === 'local_symbol_call')
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort();
}

function assertPackageTrace(db: Db, workspaceId: number): void {
  const result = trace(db, { repo: 'app', handler: 'PackageHandler' }, { depth: 8, workspaceId });
  const localEdges = result.edges.filter((edge) => edge.type === 'local_symbol_call');
  expect(localEdges.map((edge) => edge.from).sort()).toEqual([
    'Helper.doWork', 'doWork', 'publicName', 'sharedLeaf', 'sharedUtil', 'subpathUtil',
  ]);
  expect(localEdges.find((edge) => edge.from === 'sharedUtil')?.evidence).toMatchObject({
    relation: 'package_import', candidateStrategy: 'package_import_workspace_resolved',
    candidateCount: 1, resolvedModulePath: 'src/shared-util', resolutionStatus: 'resolved',
  });
  expect(result.nodes).toContainEqual(expect.objectContaining({
    kind: 'symbol', repoName: 'shared-helpers', sourceFile: 'src/shared-util.ts', qualifiedName: 'sharedUtil',
  }));
}

function exportedSymbolCount(db: Db, packageName: string, qualifiedName: string): number {
  const row = db.prepare(`SELECT COUNT(*) count FROM symbols s
    JOIN repositories r ON r.id=s.repo_id
    WHERE r.package_name=? AND s.qualified_name=? AND s.exported=1`).get(packageName, qualifiedName);
  return Number(row?.count ?? 0);
}

function assertFailClosedFixtureExports(db: Db): void {
  expect(exportedSymbolCount(db, '@neutral/shared-helpers', 'canonicalDefault')).toBe(1);
  expect(exportedSymbolCount(db, '@neutral/shared-helpers', 'OtherHelper.otherWork')).toBe(1);
  expect(exportedSymbolCount(db, '@neutral/different-package', 'externalOnly')).toBe(1);
}

function assertStalePackageResolutionCleared(db: Db, workspaceId: number): void {
  const changed = db.prepare(`UPDATE symbols SET exported=0
    WHERE repo_id=(SELECT id FROM repositories WHERE workspace_id=? AND package_name=?)
      AND qualified_name=?`).run(workspaceId, '@neutral/shared-helpers', 'sharedUtil');
  expect(changed.changes).toBe(1);
  linkWorkspace(db, workspaceId);
  const row = callRow(symbolCallRows(db), packageHandlerFile, 'sharedUtil');
  expect(row.unresolvedReason).toContain('Sibling package indexed but no matching exported symbol');
  expect(row).toMatchObject({
    status: 'unresolved', candidateStrategy: 'package_import_unresolved', candidateCount: 0,
    calleeSymbolId: null, resolvedModulePath: null, targetSourceFile: null, confidence: 0.8,
  });
}

function traceSnapshot(db: Db, workspaceId: number): Record<string, string[]> {
  return Object.fromEntries(['ShadowHandler', 'NamespaceHandler', 'DirectFormatHandler', 'BarrelFormatHandler', 'SingletonHandler', 'PackageHandler']
    .map((handler) => [handler, localTraceEdges(db, workspaceId, handler)]));
}

type StableSymbolCallRow = Omit<SymbolCallRow, 'id' | 'sourceLine' | 'calleeSymbolId' | 'evidenceJson' | 'evidenceValid'>;

function stableRows(rows: SymbolCallRow[]): StableSymbolCallRow[] {
  return rows.map((row) => ({
    sourceFile: row.sourceFile,
    expression: row.expression,
    importSource: row.importSource,
    status: row.status,
    confidence: row.confidence,
    relation: row.relation,
    candidateStrategy: row.candidateStrategy,
    candidateCount: row.candidateCount,
    resolvedModulePath: row.resolvedModulePath,
    targetSourceFile: row.targetSourceFile,
    targetName: row.targetName,
    targetQualifiedName: row.targetQualifiedName,
    targetExportedName: row.targetExportedName,
    targetExported: row.targetExported,
    targetRepoName: row.targetRepoName,
    targetPackageName: row.targetPackageName,
    unresolvedReason: row.unresolvedReason,
  }));
}

function databaseCounts(db: Db): { symbolCalls: number; graphEdges: number } {
  const row = db.prepare('SELECT (SELECT COUNT(*) FROM symbol_calls) symbolCalls,(SELECT COUNT(*) FROM graph_edges) graphEdges').get();
  return { symbolCalls: Number(row?.symbolCalls ?? 0), graphEdges: Number(row?.graphEdges ?? 0) };
}

describe('import-binding-aware local symbol calls', () => {
  it('emits binding-specific parser facts for relative, namespace, accessor, and package imports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-import-bindings-parser-'));
    await createFixture(root);
    const appRoot = path.join(root, 'app');
    const shadow = await parseExecutableSymbols(appRoot, 'src/handlers/ShadowHandler.ts');
    const namespace = await parseExecutableSymbols(appRoot, 'src/handlers/NamespaceHandler.ts');
    const singleton = await parseExecutableSymbols(appRoot, 'src/handlers/SingletonHandler.ts');
    const packageCalls = await parseExecutableSymbols(appRoot, 'src/handlers/PackageHandler.ts');

    expectParsedCall(shadow, 'loadRecord', { calleeLocalName: 'loadRecord', importSource: '../helpers/record-helper', relation: 'relative_import' });
    expectParsedCall(shadow, 'localStep', { calleeLocalName: 'localStep', relation: 'indexed_local_symbol' });
    expectParsedCall(namespace, 'utilityModule.buildHeaders', { calleeLocalName: 'buildHeaders', importSource: '../namespaces', relation: 'relative_import_namespace_member' });
    expectParsedCall(namespace, 'utilityModule.missingMember', { calleeLocalName: 'missingMember', importSource: '../namespaces', relation: 'relative_import_namespace_member' });
    expectParsedCall(singleton, 'TaskService.getInstance().execute', { calleeLocalName: 'TaskService.execute', importSource: '../services/task-service', relation: 'relative_import' });
    expectParsedCall(singleton, 'TaskService.instance().execute', { calleeLocalName: 'TaskService.execute', importSource: '../services/task-service', relation: 'relative_import' });
    expectParsedCall(singleton, 'direct.execute', { calleeLocalName: 'TaskService.execute', importSource: '../services/task-service', relation: 'class_instance_method' });
    expectParsedCall(packageCalls, 'sharedUtil', { calleeLocalName: 'sharedUtil', importSource: '@neutral/shared-helpers', relation: 'package_import' });
    expectParsedCall(packageCalls, 'subpathUtil', { calleeLocalName: 'subpathUtil', importSource: '@neutral/shared-helpers/sub', relation: 'package_import' });
    expectParsedCall(packageCalls, 'Helper.doWork', { calleeLocalName: 'doWork', importSource: '@neutral/shared-helpers', relation: 'package_import' });
    expectParsedCall(packageCalls, 'doWork', { calleeLocalName: 'doWork', importSource: '@neutral/shared-helpers', relation: 'package_import' });
  });

  it('resolves relative and sibling-package bindings deterministically across link and force index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-import-bindings-db-'));
    await createFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    assertPackageIndexBaseline(symbolCallRows(db));

    linkWorkspace(db, workspaceId);
    const firstRows = symbolCallRows(db);
    const firstTraces = traceSnapshot(db, workspaceId);
    const firstCounts = databaseCounts(db);

    assertShadowResolution(firstRows);
    assertNamespaceResolution(firstRows);
    assertDuplicateResolution(firstRows);
    assertSingletonResolution(firstRows);
    assertPackageResolution(firstRows);
    assertPackageTrace(db, workspaceId);
    assertFailClosedFixtureExports(db);
    expect(firstRows).toHaveLength(27);
    expect(firstRows.every((row) => row.evidenceValid === 1 && row.evidenceJson.length < 4096)).toBe(true);
    expect(firstTraces.ShadowHandler).toEqual(expect.arrayContaining([expect.stringContaining('loadRecord->'), expect.stringContaining('localStep->'), expect.stringContaining('helperLeaf->')]));
    expect(firstTraces.NamespaceHandler).toEqual(expect.arrayContaining([expect.stringContaining('utilityModule.buildHeaders->'), expect.stringContaining('namespaceLeaf->')]));
    expect(firstTraces.DirectFormatHandler).toEqual(expect.arrayContaining([expect.stringContaining('formatValue->')]));
    expect(firstTraces.BarrelFormatHandler).toEqual([]);
    expect(firstTraces.SingletonHandler).toEqual(expect.arrayContaining([expect.stringContaining('TaskService.getInstance().execute->'), expect.stringContaining('TaskService.instance().execute->'), expect.stringContaining('direct.execute->'), expect.stringContaining('serviceLeaf->')]));

    linkWorkspace(db, workspaceId);
    expect(symbolCallRows(db)).toEqual(firstRows);
    expect(traceSnapshot(db, workspaceId)).toEqual(firstTraces);
    expect(databaseCounts(db)).toEqual(firstCounts);
    assertStalePackageResolutionCleared(db, workspaceId);

    await indexWorkspace(db, workspaceId, { force: true });
    assertPackageIndexBaseline(symbolCallRows(db));
    linkWorkspace(db, workspaceId);
    const secondRows = symbolCallRows(db);
    expect(stableRows(secondRows)).toEqual(stableRows(firstRows));
    expect(traceSnapshot(db, workspaceId)).toEqual(firstTraces);
    expect(databaseCounts(db)).toEqual(firstCounts);
    db.close();
  });
});
