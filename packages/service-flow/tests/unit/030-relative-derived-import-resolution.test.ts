import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import {
  invalidRelativeFactCategories,
} from '../../src/db/008-relative-fact-semantics.js';
import { factLifecycleDiagnostic } from
  '../../src/db/001-fact-lifecycle.js';
import { parseExecutableSymbols } from '../../src/parsers/symbol-parser.js';
import {
  prepareWorkspace,
  writeFixtureFile,
} from './test-workspace.js';

const consumerSource = `
import {
  ActualWorker as RenamedWorker,
  AbstractWorker as RenamedAbstract,
  HiddenWorker as RenamedHidden,
}
  from '../helpers/worker';
import { DomainWorker as RenamedDomain } from '../helpers/work-map';
import { PackageWorker as RenamedPackage } from '@neutral/workers';
export function start(): void {
  const worker = new RenamedWorker();
  worker.run('value');
  const bodyless = new RenamedAbstract();
  bodyless.run();
  const hidden = new RenamedHidden();
  hidden.run();
  const proxy = RenamedDomain.instance();
  proxy.runHeavyCheck();
  proxy.ambiguousTarget();
  proxy.noBody();
  const packageWorker = new RenamedPackage();
  packageWorker.run();
  const packageProxy = RenamedPackage.instance();
  packageProxy.run();
}
`;

const workerSource = `
function workerLeaf(): void {}
export class ActualWorker {
  run(value: string): void;
  run(value: string): void { workerLeaf(); void value; }
}
export abstract class AbstractWorker {
  abstract run(): void;
}
class HiddenWorker {
  run(): void {}
}
`;

const workMapSource = `
import { runHeavyCheck } from './run-heavy-check';
import { ambiguousTarget } from './ambiguous-target';
import { noBody } from './declarations';
export const workerFunctions = { runHeavyCheck, ambiguousTarget, noBody };
export class DomainWorker {
  static instance(): unknown { return {}; }
}
`;

interface PersistedCall {
  expression: string;
  status: string;
  reason: string | null;
  targetFile: string | null;
  targetName: string | null;
  strategy: string;
  candidateCount: number;
  eligibleCount: number;
  selectedCount: number;
  candidateSetComplete: boolean;
  resolvedModulePath: string | null;
  evidence: Record<string, unknown>;
}

type ParsedSymbols = Awaited<ReturnType<typeof parseExecutableSymbols>>;
type ParsedCallMap = Map<string, ParsedSymbols['calls'][number]>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function persistedCalls(db: Db): PersistedCall[] {
  return db.prepare(`SELECT sc.callee_expression expression,sc.status,
    sc.unresolved_reason reason,target.source_file targetFile,
    target.qualified_name targetName,
    json_extract(sc.evidence_json,'$.candidateStrategy') strategy,
    json_extract(sc.evidence_json,'$.candidateCount') candidateCount,
    json_extract(sc.evidence_json,'$.eligibleCandidateCount') eligibleCount,
    json_extract(sc.evidence_json,'$.selectedCandidateCount') selectedCount,
    json_extract(sc.evidence_json,'$.candidateSetComplete') candidateSetComplete,
    json_extract(sc.evidence_json,'$.resolvedModulePath') resolvedModulePath,
    sc.evidence_json evidenceJson
    FROM symbol_calls sc
    LEFT JOIN symbols target ON target.id=sc.callee_symbol_id
    WHERE sc.source_file='src/handlers/entry.ts'
    ORDER BY sc.callee_expression`).all().map((row) => ({
      expression: String(row.expression),
      status: String(row.status),
      reason: typeof row.reason === 'string' ? row.reason : null,
      targetFile: typeof row.targetFile === 'string' ? row.targetFile : null,
      targetName: typeof row.targetName === 'string' ? row.targetName : null,
      strategy: String(row.strategy),
      candidateCount: Number(row.candidateCount),
      eligibleCount: Number(row.eligibleCount),
      selectedCount: Number(row.selectedCount),
      candidateSetComplete: Boolean(row.candidateSetComplete),
      resolvedModulePath: typeof row.resolvedModulePath === 'string'
        ? row.resolvedModulePath : null,
      evidence: record(JSON.parse(String(row.evidenceJson)) as unknown),
    }));
}

function persistedCall(
  rows: readonly PersistedCall[],
  expression: string,
): PersistedCall {
  const result = rows.find((row) => row.expression === expression);
  if (!result) throw new Error(`Missing persisted call ${expression}`);
  return result;
}

function updateCallEvidence(
  db: Db,
  expression: string,
  mutate: (evidence: Record<string, unknown>) => void,
): void {
  const row = db.prepare(`SELECT id,evidence_json evidenceJson
    FROM symbol_calls WHERE callee_expression=?`).get(expression);
  if (typeof row?.id !== 'number' || typeof row.evidenceJson !== 'string')
    throw new Error(`Missing call evidence ${expression}`);
  const evidence = record(JSON.parse(row.evidenceJson) as unknown);
  mutate(evidence);
  db.prepare('UPDATE symbol_calls SET evidence_json=? WHERE id=?').run(
    JSON.stringify(evidence), row.id,
  );
}

async function createFixture(root: string): Promise<void> {
  const files: Array<readonly [string, string]> = [
    ['app/.git-fixture', ''],
    ['app/package.json', JSON.stringify({
      name: '@neutral/app',
      dependencies: { '@neutral/workers': '1.0.0' },
    })],
    ['app/src/handlers/entry.ts', consumerSource],
    ['app/src/helpers/worker.ts', workerSource],
    ['app/src/helpers/wrong-worker.ts',
      'export class ActualWorker { run(value: string): void { void value; } }'],
    ['app/src/helpers/run-heavy-check.ts',
      'export function runHeavyCheck(): void {}'],
    ['app/src/helpers/wrong-run.ts',
      'export function runHeavyCheck(): void {}'],
    ['app/src/helpers/ambiguous-target.ts',
      'export function ambiguousTarget(): void {}'],
    ['app/src/helpers/ambiguous-target/index.ts',
      'export function other(): void {}'],
    ['app/src/helpers/declarations.d.ts',
      'export declare function noBody(): void;'],
    ['app/src/helpers/work-map.ts', workMapSource],
  ];
  await Promise.all(files.map(([file, content]) =>
    writeFixtureFile(root, file, content)));
}

async function parsedCallMap(
  root: string,
): Promise<ParsedCallMap> {
  const parsed = await parseExecutableSymbols(
    path.join(root, 'app'), 'src/handlers/entry.ts',
  );
  return new Map(parsed.calls.map((call) => [call.calleeExpression, call]));
}

function expectRenamedClassCall(
  calls: ParsedCallMap,
): void {
  expect(calls.get('worker.run')).toMatchObject({
    calleeLocalName: 'ActualWorker.run',
    importSource: '../helpers/worker',
    evidence: {
      relation: 'class_instance_method',
      importBinding: {
        moduleKind: 'relative',
        bindingKind: 'esm_named',
        localName: 'RenamedWorker',
        importedName: 'ActualWorker',
        requestedPublicName: 'ActualWorker.run',
      },
    },
  });
}

function expectRenamedProxyCall(
  calls: ParsedCallMap,
): void {
  expect(calls.get('proxy.runHeavyCheck')).toMatchObject({
    importSource: '../helpers/work-map',
    evidence: {
      relation: 'relative_import_proxy_member',
      importBinding: {
        moduleKind: 'relative',
        localName: 'RenamedDomain',
        importedName: 'DomainWorker',
        requestedPublicName: 'DomainWorker.runHeavyCheck',
      },
    },
  });
}

function expectPackageDerivedCalls(
  calls: ParsedCallMap,
): void {
  for (const expression of ['packageWorker.run', 'packageProxy.run'])
    expect(calls.get(expression)?.evidence).toMatchObject({
      relation: 'package_import_derived_member',
      derivedImportBinding: {
        moduleKind: 'package',
        localName: 'RenamedPackage',
        importedName: 'PackageWorker',
        requestedPublicName: 'PackageWorker.run',
      },
    });
}

function expectResolvedRelativeClass(rows: readonly PersistedCall[]): void {
  expect(persistedCall(rows, 'worker.run')).toMatchObject({
    status: 'resolved',
    reason: null,
    targetFile: 'src/helpers/worker.ts',
    targetName: 'ActualWorker.run',
    candidateCount: 3,
    eligibleCount: 1,
    selectedCount: 1,
    resolvedModulePath: 'src/helpers/worker',
  });
}

function expectBodylessRelativeCalls(rows: readonly PersistedCall[]): void {
  expect(persistedCall(rows, 'bodyless.run')).toMatchObject({
    status: 'unresolved',
    reason: 'relative_import_requested_module_has_no_executable_body',
    targetFile: null,
    candidateCount: 1,
    eligibleCount: 0,
    selectedCount: 0,
  });
  expect(persistedCall(rows, 'hidden.run')).toMatchObject({
    status: 'unresolved',
    reason: 'relative_import_requested_module_has_no_target',
    targetFile: null,
    candidateCount: 1,
    eligibleCount: 0,
    selectedCount: 0,
  });
  expect(persistedCall(rows, 'proxy.noBody')).toMatchObject({
    status: 'unresolved',
    reason: 'relative_import_requested_module_has_no_executable_body',
    candidateCount: 2,
    eligibleCount: 0,
    selectedCount: 0,
  });
}

function expectMappedProxyCall(rows: readonly PersistedCall[]): void {
  expect(persistedCall(rows, 'proxy.runHeavyCheck')).toMatchObject({
    status: 'resolved',
    reason: null,
    targetFile: 'src/helpers/run-heavy-check.ts',
    targetName: 'runHeavyCheck',
    candidateCount: 3,
    eligibleCount: 1,
    selectedCount: 1,
    resolvedModulePath: 'src/helpers/work-map',
  });
}

function expectAmbiguousMappedProxyCall(
  rows: readonly PersistedCall[],
): void {
  expect(persistedCall(rows, 'proxy.ambiguousTarget')).toMatchObject({
    status: 'unresolved',
    reason: 'relative_import_module_resolution_ambiguous',
    targetFile: null,
    candidateCount: 2,
    eligibleCount: 0,
    selectedCount: 0,
    candidateSetComplete: false,
    resolvedModulePath: null,
  });
}

function expectedPackageBinding(): Record<string, unknown> {
  return {
    version: 1,
    moduleKind: 'package',
    bindingKind: 'esm_named',
    localName: 'RenamedPackage',
    importedName: 'PackageWorker',
    requestedPackageName: '@neutral/workers',
    requestedModuleSubpath: '.',
    rawModuleSpecifier: '@neutral/workers',
    typeOnly: false,
    referenceShape: 'static_member',
    referencedMemberName: 'run',
    requestedPublicName: 'PackageWorker.run',
  };
}

function expectUnsupportedPackageCalls(rows: readonly PersistedCall[]): void {
  for (const expression of ['packageWorker.run', 'packageProxy.run'])
    expect(persistedCall(rows, expression)).toMatchObject({
      status: 'unresolved',
      reason: 'package_derived_member_provenance_insufficient',
      strategy: 'package_import_derived_member_unsupported',
      candidateCount: 0,
      eligibleCount: 0,
      selectedCount: 0,
      candidateSetComplete: true,
      targetFile: null,
      evidence: { derivedImportBinding: expectedPackageBinding() },
    });
}

async function verifyAmbiguousModuleNormalization(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-relative-module-'));
  await Promise.all([
    writeFixtureFile(root, 'app/.git-fixture'),
    writeFixtureFile(root, 'app/package.json', JSON.stringify({
      name: '@neutral/relative-module-app',
    })),
    writeFixtureFile(root, 'app/src/entry.ts', `
      import { choose } from './dual';
      export function start(): void { choose(); }
    `),
    writeFixtureFile(
      root, 'app/src/dual.ts',
      'export function choose(): void {}\n',
    ),
    writeFixtureFile(
      root, 'app/src/dual/index.ts',
      'export function other(): void {}\n',
    ),
  ]);
  const { db, workspaceId } = await prepareWorkspace(root);
  try {
    const call = db.prepare(`SELECT status,unresolved_reason reason,
      evidence_json evidenceJson FROM symbol_calls
      WHERE callee_expression='choose'`).get();
    expect(call).toMatchObject({
      status: 'unresolved',
      reason: 'relative_import_module_resolution_ambiguous',
    });
    expect(record(JSON.parse(String(call?.evidenceJson)) as unknown))
      .toMatchObject({
        candidateCount: 1, eligibleCandidateCount: 0,
        selectedCandidateCount: 0, candidateSetComplete: false,
      });
    expect(invalidRelativeFactCategories(db, workspaceId)).toEqual([]);
    expect(factLifecycleDiagnostic(db, workspaceId)).toBeUndefined();
  } finally {
    db.close();
  }
}

describe('derived relative import resolution', () => {
  it('preserves renamed class and proxy import provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-derived-parser-'));
    await createFixture(root);
    const calls = await parsedCallMap(root);
    expectRenamedClassCall(calls);
    expectRenamedProxyCall(calls);
    expectPackageDerivedCalls(calls);
  });

  it('selects only exact-module executable bodies with truthful counts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-derived-db-'));
    await createFixture(root);
    const { db } = await prepareWorkspace(root);
    try {
      const rows = persistedCalls(db);
      expectResolvedRelativeClass(rows);
      expectBodylessRelativeCalls(rows);
      expectMappedProxyCall(rows);
      expectAmbiguousMappedProxyCall(rows);
      expectUnsupportedPackageCalls(rows);
    } finally {
      db.close();
    }
  });

  it('keeps derived contexts lexical and rejects mutable receivers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-derived-scope-'));
    await Promise.all([
      writeFixtureFile(root, 'app/.git-fixture'),
      writeFixtureFile(root, 'app/package.json', JSON.stringify({
        name: '@neutral/derived-scope',
      })),
      writeFixtureFile(root, 'app/src/helpers/factory.ts', `
        export function create(): unknown { return {}; }
      `),
      writeFixtureFile(root, 'app/src/helpers/worker.ts', `
        export class Worker { run(): void {} }
      `),
      writeFixtureFile(root, 'app/src/entry.ts', `
        import * as Factory from './helpers/factory';
        import { Worker } from './helpers/worker';
        export function safe(): void {
          const proxy = Factory.create();
          proxy.run();
          const worker = new Worker();
          worker.run();
        }
        export function shadowed(
          Factory: { create(): unknown },
          Worker: new () => { run(): void },
        ): void {
          const proxy = Factory.create();
          proxy.run();
          const worker = new Worker();
          worker.run();
        }
        export function mutable(): void {
          let proxy = Factory.create();
          proxy.run();
          let worker = new Worker();
          worker.run();
          void proxy;
          void worker;
        }
        class Container {
          private imported = new Worker();
          run(): void { this.imported.run(); }
          mutate(): void { this['imported'] = new Worker(); }
        }
        void Container;
      `),
    ]);
    const parsed = await parseExecutableSymbols(
      path.join(root, 'app'), 'src/entry.ts',
    );
    const derived = parsed.calls.filter((call) =>
      call.evidence.relation === 'class_instance_method'
      || call.evidence.relation === 'relative_import_proxy_member');
    expect(derived.map((call) => call.calleeExpression).sort()).toEqual([
      'proxy.run',
      'worker.run',
    ]);
    expect(parsed.calls.some((call) =>
      call.calleeExpression === 'this.imported.run')).toBe(false);
  });
});

describe('relative import lifecycle semantics', () => {
  it('fails closed when extension and index normalization is ambiguous',
    verifyAmbiguousModuleNormalization);

  it('rejects forged relation and target-name provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-relative-proof-'));
    await createFixture(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    try {
      expect(invalidRelativeFactCategories(db, workspaceId)).toEqual([]);
      updateCallEvidence(db, 'worker.run', (evidence) => {
        evidence.relation = 'relative_import_namespace_member';
      });
      expect(invalidRelativeFactCategories(db, workspaceId)).toEqual([
        {
          category: 'relative_import_resolution_proof_invalid',
          count: 1,
        },
      ]);
      updateCallEvidence(db, 'worker.run', (evidence) => {
        evidence.relation = 'class_instance_method';
        evidence.targetName = 'WrongWorker.run';
      });
      expect(invalidRelativeFactCategories(db, workspaceId)).toEqual([
        {
          category: 'relative_import_resolution_proof_invalid',
          count: 1,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
