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

type ParsedSymbols = Awaited<ReturnType<typeof parseExecutableSymbols>>['symbols'];
type FixtureFile = readonly [relativePath: string, content: string];

const providerSource = `
function arrowLeaf(): void {}
function expressionLeaf(): void {}
function methodLeaf(): void {}
export class StaticTools {
  public static arrowTask = (value: string): string => { arrowLeaf(); return value; };
  static expressionTask = function (value: string): string { expressionLeaf(); return value; };
  static methodTask(value: string): string { methodLeaf(); return value; }
  instanceTask = (): void => {};
  private static secretTask = (): void => {};
  protected static guardedTask = function (): void {};
  static callSibling = (): void => { this.arrowTask('nested'); };
}
class InternalTools {
  static localTask = (): void => {};
}
`;

const localProviderSource = `
function barrelLeaf(): void {}
function directLeaf(): void {}
export class BarrelTools {
  static run = (): void => { barrelLeaf(); };
}
export class DirectTools {
  static run = function (): void { directLeaf(); };
}
`;

const packageHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { StaticTools } from '@neutral/static-tools';
@Handler()
export class PackageHandler {
  run(): void {
    StaticTools.arrowTask('arrow');
    StaticTools.expressionTask('expression');
    StaticTools.methodTask('method');
    StaticTools.callSibling();
    StaticTools.instanceTask();
  }
}
`;

const barrelHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { BarrelTools } from '../local';
@Handler()
export class BarrelHandler {
  run(): void { BarrelTools.run(); }
}
`;

const directHandlerSource = `
import { Handler } from 'cds-routing-handlers';
import { DirectTools } from '../local/static-tools';
@Handler()
export class DirectHandler {
  run(): void { DirectTools.run(); }
}
`;

const fixtureFiles: FixtureFile[] = [
  ['consumer/.git-fixture', ''],
  ['consumer/package.json', JSON.stringify({
    name: '@neutral/consumer', version: '1.0.0',
    dependencies: { '@neutral/static-tools': '1.0.0' },
  })],
  ['consumer/src/handlers/PackageHandler.ts', packageHandlerSource],
  ['consumer/src/handlers/BarrelHandler.ts', barrelHandlerSource],
  ['consumer/src/handlers/DirectHandler.ts', directHandlerSource],
  ['consumer/src/local/index.ts', "export { BarrelTools } from './static-tools';\n"],
  ['consumer/src/local/static-tools.ts', localProviderSource],
  ['static-tools/.git-fixture', ''],
  ['static-tools/package.json', JSON.stringify({
    name: '@neutral/static-tools', version: '1.0.0',
  })],
  ['static-tools/src/static-tools.ts', providerSource],
];

async function createFixture(root: string): Promise<void> {
  await Promise.all(fixtureFiles.map(([relativePath, content]) =>
    writeFixtureFile(root, relativePath, content)));
}

function symbolByQualified(symbols: ParsedSymbols, qualifiedName: string): ParsedSymbols[number] {
  const symbol = symbols.find((candidate) => candidate.qualifiedName === qualifiedName);
  if (!symbol) throw new Error(`Expected symbol ${qualifiedName}`);
  return symbol;
}

function expectUnexportedProperty(
  symbols: ParsedSymbols,
  qualifiedName: string,
  memberKind: string,
): void {
  expect(symbolByQualified(symbols, qualifiedName)).toMatchObject({
    exported: false, exportedName: undefined,
    importExportEvidence: { source: 'class_property_function', memberKind },
  });
}

function records(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.filter((row): row is Record<string, unknown> =>
    typeof row === 'object' && row !== null && !Array.isArray(row));
}

function callRows(db: Db): Array<Record<string, unknown>> {
  return records(db.prepare(`SELECT sc.source_file sourceFile,
      sc.callee_expression expression,sc.import_source importSource,sc.status,
      json_extract(sc.evidence_json,'$.relation') relation,
      json_extract(sc.evidence_json,'$.candidateStrategy') candidateStrategy,
      json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
      json_extract(sc.evidence_json,'$.resolvedModulePath') resolvedModulePath,
      sc.callee_symbol_id calleeSymbolId,sc.unresolved_reason unresolvedReason,
      targetRepo.name targetRepoName,targetRepo.package_name targetPackageName,
      target.source_file targetSourceFile,target.qualified_name targetQualifiedName,
      target.exported targetExported,json_valid(sc.evidence_json) evidenceValid,
      length(sc.evidence_json) evidenceLength
    FROM symbol_calls sc
    LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
    LEFT JOIN repositories targetRepo ON targetRepo.id=target.repo_id
    ORDER BY sc.source_file,sc.source_line,sc.callee_expression`).all());
}

function persistedSymbolRows(db: Db): Array<Record<string, unknown>> {
  return records(db.prepare(`SELECT r.name repoName,s.qualified_name qualifiedName,
      s.exported,s.exported_name exportedName,
      json_extract(s.evidence_json,'$.source') source,
      json_extract(s.evidence_json,'$.memberKind') memberKind,
      json_valid(s.evidence_json) evidenceValid,length(s.evidence_json) evidenceLength
    FROM symbols s JOIN repositories r ON r.id=s.repo_id
    WHERE s.qualified_name GLOB 'StaticTools.*'
      OR s.qualified_name GLOB 'InternalTools.*'
      OR s.qualified_name IN ('BarrelTools.run','DirectTools.run')
    ORDER BY r.name,s.qualified_name`).all());
}

function persistedSymbol(
  rows: Array<Record<string, unknown>>,
  qualifiedName: string,
): Record<string, unknown> {
  const row = rows.find((candidate) => candidate.qualifiedName === qualifiedName);
  if (!row) throw new Error(`Expected persisted symbol ${qualifiedName}`);
  return row;
}

function expectPersistedSymbols(rows: Array<Record<string, unknown>>): void {
  expect(rows).toHaveLength(10);
  expect(rows.filter((row) => row.exported === 1)).toHaveLength(6);
  expect(persistedSymbol(rows, 'StaticTools.arrowTask')).toMatchObject({
    exported: 1, exportedName: 'StaticTools.arrowTask',
    source: 'exported_class_member', memberKind: 'static_arrow_function',
  });
  expect(persistedSymbol(rows, 'StaticTools.expressionTask')).toMatchObject({
    exported: 1, exportedName: 'StaticTools.expressionTask',
    source: 'exported_class_member', memberKind: 'static_function_expression',
  });
  for (const qualifiedName of [
    'StaticTools.instanceTask', 'StaticTools.secretTask',
    'StaticTools.guardedTask', 'InternalTools.localTask',
  ]) expect(persistedSymbol(rows, qualifiedName).exported).toBe(0);
  expect(rows.every((row) => row.evidenceValid === 1
    && typeof row.evidenceLength === 'number' && row.evidenceLength < 4_096)).toBe(true);
}

function callRow(
  rows: Array<Record<string, unknown>>,
  sourceFile: string,
  expression: string,
): Record<string, unknown> {
  const row = rows.find((candidate) =>
    candidate.sourceFile === sourceFile && candidate.expression === expression);
  if (!row) throw new Error(`Expected symbol call ${sourceFile}:${expression}`);
  return row;
}

function expectResolvedCall(
  rows: Array<Record<string, unknown>>,
  sourceFile: string,
  expression: string,
  expected: Record<string, unknown>,
): void {
  expect(callRow(rows, sourceFile, expression)).toMatchObject({
    status: 'resolved', candidateCount: 1, unresolvedReason: null,
    ...expected,
  });
}

function expectIndexResolution(rows: Array<Record<string, unknown>>): void {
  expectResolvedCall(rows, 'src/handlers/BarrelHandler.ts', 'BarrelTools.run', {
    relation: 'relative_import', candidateStrategy: 'relative_import_exported_exact',
    targetSourceFile: 'src/local/static-tools.ts', targetQualifiedName: 'BarrelTools.run',
    targetExported: 1,
  });
  expectResolvedCall(rows, 'src/handlers/DirectHandler.ts', 'DirectTools.run', {
    relation: 'relative_import', candidateStrategy: 'relative_import_exported_exact',
    resolvedModulePath: 'src/local/static-tools',
    targetSourceFile: 'src/local/static-tools.ts', targetQualifiedName: 'DirectTools.run',
    targetExported: 1,
  });
  expectResolvedCall(rows, 'src/static-tools.ts', 'this.arrowTask', {
    relation: 'indexed_this_method', candidateStrategy: 'same_file_exact',
    targetSourceFile: 'src/static-tools.ts', targetQualifiedName: 'StaticTools.arrowTask',
    targetExported: 1,
  });
}

function expectPackageIndexBaseline(rows: Array<Record<string, unknown>>): void {
  const packageRows = rows.filter((row) =>
    row.sourceFile === 'src/handlers/PackageHandler.ts' && row.relation === 'package_import');
  expect(packageRows).toHaveLength(5);
  expect(packageRows.every((row) => row.status === 'unresolved'
    && row.candidateStrategy === 'package_import_unresolved'
    && row.candidateCount === 0 && row.calleeSymbolId === null)).toBe(true);
}

function expectPackageResolution(rows: Array<Record<string, unknown>>): void {
  for (const member of ['arrowTask', 'expressionTask', 'methodTask', 'callSibling']) {
    expectResolvedCall(rows, 'src/handlers/PackageHandler.ts', `StaticTools.${member}`, {
      relation: 'package_import', candidateStrategy: 'package_import_workspace_resolved',
      resolvedModulePath: 'src/static-tools', targetRepoName: 'static-tools',
      targetPackageName: '@neutral/static-tools', targetSourceFile: 'src/static-tools.ts',
      targetQualifiedName: `StaticTools.${member}`, targetExported: 1,
    });
  }
  expect(callRow(rows, 'src/handlers/PackageHandler.ts', 'StaticTools.instanceTask'))
    .toMatchObject({
      status: 'unresolved', candidateStrategy: 'package_import_unresolved',
      candidateCount: 0, calleeSymbolId: null, targetSourceFile: null,
    });
}

function traceEdges(db: Db, workspaceId: number, handler: string): string[] {
  return trace(db, { repo: 'consumer', handler }, { depth: 8, workspaceId }).edges
    .filter((edge) => edge.type === 'local_symbol_call')
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort();
}

function traceSnapshot(db: Db, workspaceId: number): Record<string, string[]> {
  return Object.fromEntries(['PackageHandler', 'BarrelHandler', 'DirectHandler']
    .map((handler) => [handler, traceEdges(db, workspaceId, handler)]));
}

function expectTraceDescent(snapshot: Record<string, string[]>): void {
  expect(snapshot.PackageHandler).toEqual(expect.arrayContaining([
    expect.stringContaining('StaticTools.arrowTask->'),
    expect.stringContaining('StaticTools.expressionTask->'),
    expect.stringContaining('StaticTools.methodTask->'),
    expect.stringContaining('StaticTools.callSibling->'),
    expect.stringContaining('this.arrowTask->'),
    expect.stringContaining('arrowLeaf->'),
    expect.stringContaining('expressionLeaf->'),
    expect.stringContaining('methodLeaf->'),
  ]));
  expect(snapshot.PackageHandler?.some((edge) =>
    edge.startsWith('StaticTools.instanceTask->'))).toBe(false);
  expect(snapshot.BarrelHandler).toEqual(expect.arrayContaining([
    expect.stringContaining('BarrelTools.run->'), expect.stringContaining('barrelLeaf->'),
  ]));
  expect(snapshot.DirectHandler).toEqual(expect.arrayContaining([
    expect.stringContaining('DirectTools.run->'), expect.stringContaining('directLeaf->'),
  ]));
}

function stableRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'calleeSymbolId'),
  ));
}

function graphSnapshot(db: Db): Array<Record<string, unknown>> {
  return records(db.prepare(`SELECT edge_type edgeType,status,from_kind fromKind,
      from_id fromId,to_kind toKind,to_id toId,confidence,is_dynamic isDynamic,
      unresolved_reason unresolvedReason,evidence_json evidenceJson
    FROM graph_edges ORDER BY edge_type,from_kind,from_id,to_kind,to_id`).all());
}

function expectBoundedEvidence(rows: Array<Record<string, unknown>>): void {
  expect(rows.every((row) => row.evidenceValid === 1
    && typeof row.evidenceLength === 'number' && row.evidenceLength < 4_096)).toBe(true);
}

async function verifyWorkspaceContract(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-static-properties-'));
  await createFixture(root);
  const { db, workspaceId } = await prepareWorkspace(root);
  try {
    const indexRows = callRows(db);
    const indexSymbols = persistedSymbolRows(db);
    expectPersistedSymbols(indexSymbols);
    expectIndexResolution(indexRows);
    expectPackageIndexBaseline(indexRows);
    linkWorkspace(db, workspaceId);
    const linkedRows = callRows(db);
    const linkedTrace = traceSnapshot(db, workspaceId);
    const linkedGraph = graphSnapshot(db);
    expect(linkedRows).toHaveLength(13);
    expect(linkedRows.some((row) => row.status === 'ambiguous')).toBe(false);
    expect(linkedGraph).toEqual([
      expect.objectContaining({ edgeType: 'REPO_IMPORTS_HELPER_PACKAGE', status: 'resolved' }),
    ]);
    expectPackageResolution(linkedRows);
    expectTraceDescent(linkedTrace);
    expectBoundedEvidence(linkedRows);
    linkWorkspace(db, workspaceId);
    expect(callRows(db)).toEqual(linkedRows);
    expect(traceSnapshot(db, workspaceId)).toEqual(linkedTrace);
    expect(graphSnapshot(db)).toEqual(linkedGraph);
    await indexWorkspace(db, workspaceId, { force: true });
    linkWorkspace(db, workspaceId);
    expect(persistedSymbolRows(db)).toEqual(indexSymbols);
    expect(stableRows(callRows(db))).toEqual(stableRows(linkedRows));
    expect(traceSnapshot(db, workspaceId)).toEqual(linkedTrace);
    expect(graphSnapshot(db)).toEqual(linkedGraph);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
}

describe('exported static class property symbols', () => {
  it('exports only public static function-valued properties on exported classes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-static-parser-'));
    await writeFixtureFile(root, 'src/static-tools.ts', providerSource);
    const { symbols, calls } = await parseExecutableSymbols(root, 'src/static-tools.ts');
    expect(symbolByQualified(symbols, 'StaticTools.arrowTask')).toMatchObject({
      kind: 'method', localName: 'arrowTask', exported: true,
      exportedName: 'StaticTools.arrowTask',
      importExportEvidence: {
        source: 'exported_class_member', exportedClass: 'StaticTools',
        memberKind: 'static_arrow_function', parameters: ['value'],
        parameterBindings: [{ index: 0, kind: 'identifier', name: 'value' }],
      },
    });
    expect(symbolByQualified(symbols, 'StaticTools.expressionTask')).toMatchObject({
      exported: true, exportedName: 'StaticTools.expressionTask',
      importExportEvidence: {
        source: 'exported_class_member', exportedClass: 'StaticTools',
        memberKind: 'static_function_expression',
      },
    });
    expect(symbolByQualified(symbols, 'StaticTools.methodTask')).toMatchObject({
      exported: true, exportedName: 'StaticTools.methodTask',
      importExportEvidence: { source: 'exported_class_member', memberKind: 'static_method' },
    });
    expectUnexportedProperty(symbols, 'StaticTools.instanceTask', 'arrow_function_property');
    expectUnexportedProperty(symbols, 'StaticTools.secretTask', 'arrow_function_property');
    expectUnexportedProperty(symbols, 'StaticTools.guardedTask', 'function_expression_property');
    expectUnexportedProperty(symbols, 'InternalTools.localTask', 'arrow_function_property');
    expect(calls.find((call) => call.calleeExpression === 'this.arrowTask'))?.toMatchObject({
      callerQualifiedName: 'StaticTools.callSibling', calleeLocalName: 'StaticTools.arrowTask',
      evidence: { relation: 'indexed_this_method' },
    });
  });

  it('resolves package, barrel, direct, and same-file calls deterministically', async () => {
    await verifyWorkspaceContract();
  });
});
