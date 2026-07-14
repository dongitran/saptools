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
@Handler()
export class PackageHandler {
  runPackage(): void { sharedUtil(); }
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
  ['shared-helpers/src/shared-util.ts', 'export function sharedUtil(): void {}\n'],
];

async function createFixture(root: string): Promise<void> {
  await Promise.all([...appFiles, ...packageFiles]
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
  sourceFile: string;
  sourceLine: number;
  expression: string;
  importSource: string | null;
  status: string;
  relation: string | null;
  candidateStrategy: string | null;
  candidateCount: number;
  resolvedModulePath: string | null;
  targetSourceFile: string | null;
  targetQualifiedName: string | null;
  targetExported: number | null;
  evidenceJson: string;
  evidenceValid: number;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function symbolCallRows(db: Db): SymbolCallRow[] {
  return db.prepare(`SELECT sc.source_file sourceFile,sc.source_line sourceLine,
      sc.callee_expression expression,sc.import_source importSource,sc.status,
      json_extract(sc.evidence_json,'$.relation') relation,
      json_extract(sc.evidence_json,'$.candidateStrategy') candidateStrategy,
      json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
      json_extract(sc.evidence_json,'$.resolvedModulePath') resolvedModulePath,
      s.source_file targetSourceFile,s.qualified_name targetQualifiedName,
      s.exported targetExported,sc.evidence_json evidenceJson,
      json_valid(sc.evidence_json) evidenceValid
    FROM symbol_calls sc LEFT JOIN symbols s ON s.id=sc.callee_symbol_id
    ORDER BY sc.source_file,sc.source_line,sc.callee_expression`).all().map((row) => ({
      sourceFile: String(row.sourceFile ?? ''),
      sourceLine: Number(row.sourceLine ?? 0),
      expression: String(row.expression ?? ''),
      importSource: nullableString(row.importSource),
      status: String(row.status ?? ''),
      relation: nullableString(row.relation),
      candidateStrategy: nullableString(row.candidateStrategy),
      candidateCount: Number(row.candidateCount ?? 0),
      resolvedModulePath: nullableString(row.resolvedModulePath),
      targetSourceFile: nullableString(row.targetSourceFile),
      targetQualifiedName: nullableString(row.targetQualifiedName),
      targetExported: typeof row.targetExported === 'number' ? row.targetExported : null,
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

function assertPackageFact(rows: SymbolCallRow[]): void {
  expect(callRow(rows, 'src/handlers/PackageHandler.ts', 'sharedUtil')).toMatchObject({
    status: 'unresolved', relation: 'package_import', candidateStrategy: 'package_import_unresolved',
    candidateCount: 0, importSource: '@neutral/shared-helpers', targetSourceFile: null,
  });
}

function localTraceEdges(db: Db, workspaceId: number, handler: string): string[] {
  return trace(db, { repo: 'app', handler }, { depth: 8, workspaceId }).edges
    .filter((edge) => edge.type === 'local_symbol_call')
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort();
}

function traceSnapshot(db: Db, workspaceId: number): Record<string, string[]> {
  return Object.fromEntries(['ShadowHandler', 'NamespaceHandler', 'DirectFormatHandler', 'BarrelFormatHandler', 'SingletonHandler', 'PackageHandler']
    .map((handler) => [handler, localTraceEdges(db, workspaceId, handler)]));
}

function stableRows(rows: SymbolCallRow[]): Array<Omit<SymbolCallRow, 'sourceLine' | 'evidenceJson' | 'evidenceValid'>> {
  return rows.map((row) => ({
    sourceFile: row.sourceFile,
    expression: row.expression,
    importSource: row.importSource,
    status: row.status,
    relation: row.relation,
    candidateStrategy: row.candidateStrategy,
    candidateCount: row.candidateCount,
    resolvedModulePath: row.resolvedModulePath,
    targetSourceFile: row.targetSourceFile,
    targetQualifiedName: row.targetQualifiedName,
    targetExported: row.targetExported,
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
  });

  it('resolves relative bindings module-scoped and remains deterministic after force index and relink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-import-bindings-db-'));
    await createFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const firstRows = symbolCallRows(db);
    const firstTraces = traceSnapshot(db, workspaceId);
    const firstCounts = databaseCounts(db);

    assertShadowResolution(firstRows);
    assertNamespaceResolution(firstRows);
    assertDuplicateResolution(firstRows);
    assertSingletonResolution(firstRows);
    assertPackageFact(firstRows);
    expect(firstRows).toHaveLength(15);
    expect(firstRows.every((row) => row.evidenceValid === 1 && row.evidenceJson.length < 4096)).toBe(true);
    expect(firstTraces.ShadowHandler).toEqual(expect.arrayContaining([expect.stringContaining('loadRecord->'), expect.stringContaining('localStep->'), expect.stringContaining('helperLeaf->')]));
    expect(firstTraces.NamespaceHandler).toEqual(expect.arrayContaining([expect.stringContaining('utilityModule.buildHeaders->'), expect.stringContaining('namespaceLeaf->')]));
    expect(firstTraces.DirectFormatHandler).toEqual(expect.arrayContaining([expect.stringContaining('formatValue->')]));
    expect(firstTraces.BarrelFormatHandler).toEqual([]);
    expect(firstTraces.SingletonHandler).toEqual(expect.arrayContaining([expect.stringContaining('TaskService.getInstance().execute->'), expect.stringContaining('TaskService.instance().execute->'), expect.stringContaining('direct.execute->'), expect.stringContaining('serviceLeaf->')]));
    expect(firstTraces.PackageHandler).toEqual([]);

    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    const secondRows = symbolCallRows(db);
    expect(stableRows(secondRows)).toEqual(stableRows(firstRows));
    expect(traceSnapshot(db, workspaceId)).toEqual(firstTraces);
    expect(databaseCounts(db)).toEqual(firstCounts);
    db.close();
  });
});
