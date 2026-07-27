import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { openReadOnlyDatabase } from '../../src/db/connection.js';

const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const complexKey = 'tenantInfo.region?.toLowerCase()';
const operationPath = `\${${complexKey}}`;

const callerSource = `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
function createdLeaf(): void {}
function rejectedLeaf(): void {}
function firstDuplicateLeaf(): void {}
function secondDuplicateLeaf(): void {}
function createdHandler(): void { createdLeaf(); }
function rejectedHandler(): void { rejectedLeaf(); }
function firstDuplicateHandler(): void { firstDuplicateLeaf(); }
function secondDuplicateHandler(): void { secondDuplicateLeaf(); }
function guard<T>(handler: T): T { return handler; }
async function firstBindingScope(): Promise<void> { const scopedClient = await cds.connect.to('target-api', { credentials: { path: '/TargetService' } }); await scopedClient.send({ method: 'GET', path: '/lookup' }); } async function secondBindingScope(): Promise<void> { const scopedClient = await cds.connect.to('target-api', { credentials: { path: '/TargetService' } }); await scopedClient.send({ method: 'GET', path: '/lookup' }); }
@Handler()
export class FlowHandler {
  @Action('runFlow')
  async runFlow(tenantInfo: { region?: string }): Promise<void> {
    const customBus = await cds.connect.messaging();
    customBus.on('Created', createdHandler); customBus.on('Rejected', rejectedHandler); customBus.on('Duplicated', firstDuplicateHandler); customBus.on('Duplicated', guard(secondDuplicateHandler));
    await customBus.emit('Created', {});
    await customBus.emit('Rejected', {});
    await customBus.emit('Duplicated', {});
    await firstBindingScope(); await secondBindingScope();
    const remoteClient = await cds.connect.to('target-api', {
      credentials: { path: '/TargetService' },
    });
    await remoteClient.send({
      method: 'GET',
      path: \`/\${tenantInfo.region?.toLowerCase()}\`,
    });
  }
}
`;

const targetSource = `
import { Func, Handler } from 'cds-routing-handlers';
function lookupLeaf(): string { return 'ok'; }
@Handler()
export class TargetHandler {
  @Func('lookup')
  lookup(): string { return lookupLeaf(); }
}
`;

interface DetailedEdge {
  type: string;
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  evidence: Record<string, unknown>;
  unresolvedReason?: string;
}

interface DetailedTrace {
  edges: DetailedEdge[];
  diagnostics: Array<{
    code?: string;
    missingVariables?: string[];
  }>;
}

type CompactEdge = [
  string, number[], number, string, string, string, string, number, number,
  Record<string, unknown> | null,
];

type CompactDiagnostic = [
  number, string, string, string, number | null, number | null,
  Record<string, unknown> | null,
];

interface CompactTrace {
  query: { suppliedVariableNames: string[] };
  nodes: Array<[string, string, string, number | null, number | null, number | null]>;
  edges: CompactEdge[];
  diagnostics: CompactDiagnostic[];
}

interface FixtureState {
  root: string;
  dbPath: string;
}

let fixtureState: FixtureState | undefined;

function fixture(): FixtureState {
  if (!fixtureState) throw new Error('Neutral provenance fixture is unavailable');
  return fixtureState;
}

async function writeRepository(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const repository = path.join(root, name);
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, '.git-fixture'), '');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repository, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function writeWorkspace(root: string): Promise<void> {
  await writeRepository(root, 'caller', {
    'package.json': JSON.stringify({
      name: '@neutral/provenance-caller',
      version: '1.0.0',
      dependencies: { '@neutral/provenance-target': '1.0.0' },
    }),
    'srv/facade.cds':
      'service FacadeService { action runFlow(); }',
    'srv/FlowHandler.ts': callerSource,
    'srv/server.ts': `
import { createCombinedHandler } from 'cds-routing-handlers';
import { FlowHandler } from './FlowHandler.js';
createCombinedHandler({ handler: [FlowHandler] });
`,
  });
  await writeRepository(root, 'target', {
    'package.json': JSON.stringify({
      name: '@neutral/provenance-target',
      version: '1.0.0',
    }),
    'srv/target.cds':
      'service TargetService { function lookup() returns String; }',
    'srv/TargetHandler.ts': targetSource,
    'srv/server.ts': `
import { createCombinedHandler } from 'cds-routing-handlers';
import { TargetHandler } from './TargetHandler.js';
createCombinedHandler({ handler: [TargetHandler] });
`,
  });
}

async function runCli(args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'),
  });
  if (result.stderr)
    throw new Error(`Unexpected service-flow stderr: ${result.stderr}`);
  return result.stdout;
}

async function prepareFixture(): Promise<void> {
  const root = await mkdtemp(path.join(
    os.tmpdir(), 'service-flow-neutral-provenance-',
  ));
  const dbPath = path.join(root, 'service-flow.db');
  await writeWorkspace(root);
  await runCli(['init', root, '--db', dbPath]);
  await runCli(['index', '--workspace', root, '--force']);
  await runCli(['link', '--workspace', root, '--force']);
  const unchanged = await runCli(['index', '--workspace', root]);
  expect(unchanged).toContain('Indexed 0 repositories, skipped 2');
  fixtureState = { root, dbPath };
}

function traceArgs(format: 'json' | 'compact-json'): string[] {
  return [
    'trace', '--workspace', fixture().root,
    '--repo', '@neutral/provenance-caller',
    '--operation', 'runFlow', '--depth', '12',
    '--include-async', '--include-external', '--format', format,
  ];
}

function registrationLine(): number {
  const offset = callerSource.indexOf("customBus.on('Created'");
  return callerSource.slice(0, offset).split('\n').length;
}

function assertStoredRegistrations(): void {
  const db = openReadOnlyDatabase(fixture().dbPath);
  try {
    const rows = db.prepare(`SELECT outbound.event_name_expr eventName,
      outbound.source_file sourceFile,outbound.source_line sourceLine,
      outbound.source_symbol_id sourceOwnerId,
      handler.caller_symbol_id handlerOwnerId,
      outbound.call_site_start_offset callStart,
      outbound.call_site_end_offset callEnd,
      owner.start_offset ownerStart,owner.end_offset ownerEnd
      FROM outbound_calls outbound
      JOIN symbol_calls handler
        ON handler.repo_id=outbound.repo_id
        AND handler.source_file=outbound.source_file
        AND handler.call_site_start_offset=outbound.call_site_start_offset
        AND handler.call_site_end_offset=outbound.call_site_end_offset
        AND handler.call_role='event_subscribe_handler'
      JOIN symbols owner ON owner.id=outbound.source_symbol_id
      WHERE outbound.call_type='async_subscribe'
      ORDER BY outbound.call_site_start_offset`).all();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.sourceLine))
      .toEqual(Array.from({ length: 4 }, registrationLine));
    expect(new Set(rows.map((row) => row.sourceOwnerId)).size).toBe(4);
    for (const row of rows) {
      expect(row.sourceFile).toBe('srv/FlowHandler.ts');
      expect(row.sourceOwnerId).toBe(row.handlerOwnerId);
      expect(row.callStart).toBe(row.ownerStart);
      expect(row.callEnd).toBe(row.ownerEnd);
      const call = callerSource.slice(
        Number(row.callStart), Number(row.callEnd),
      );
      expect(call).toContain(`customBus.on('${String(row.eventName)}'`);
    }
    const graph = db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
        AND status='resolved'`).get();
    expect(graph?.count).toBe(4);
  } finally {
    db.close();
  }
}

function assertIndexedDynamicPath(): void {
  const db = openReadOnlyDatabase(fixture().dbPath);
  try {
    const row = db.prepare(`SELECT evidence_json evidenceJson
      FROM outbound_calls WHERE operation_path_expr=?`)
      .get(`/${operationPath}`);
    const evidence = JSON.parse(String(row?.evidenceJson)) as {
      odataPathIntent?: Record<string, unknown>;
    };
    expect(evidence.odataPathIntent).toMatchObject({
      kind: 'unknown',
      hasQueryString: false,
      pathWithoutQuery: `/${operationPath}`,
      placeholderKeys: [complexKey],
    });
  } finally {
    db.close();
  }
}

function assertScopedBindings(): void {
  const db = openReadOnlyDatabase(fixture().dbPath);
  try {
    const rows = db.prepare(`SELECT binding.id bindingId,
      binding.symbol_id bindingOwnerId,
      binding.owner_resolution ownerResolution,
      binding.binding_site_start_offset bindingStart,
      binding.binding_site_end_offset bindingEnd,
      outbound.source_symbol_id callOwnerId,
      outbound.service_binding_id selectedBindingId,
      json_extract(outbound.evidence_json,
        '$.serviceBindingReference.bindingSiteStartOffset') referenceStart,
      json_extract(outbound.evidence_json,
        '$.serviceBindingReference.bindingSiteEndOffset') referenceEnd
      FROM outbound_calls outbound
      JOIN service_bindings binding ON binding.id=outbound.service_binding_id
      WHERE binding.variable_name='scopedClient'
      ORDER BY binding.binding_site_start_offset`).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.bindingId)).size).toBe(2);
    expect(new Set(rows.map((row) => row.callOwnerId)).size).toBe(2);
    for (const row of rows) {
      expect(row.ownerResolution).toBe('owned_exact');
      expect(row.selectedBindingId).toBe(row.bindingId);
      expect(row.callOwnerId).toBe(row.bindingOwnerId);
      expect(row.referenceStart).toBe(row.bindingStart);
      expect(row.referenceEnd).toBe(row.bindingEnd);
    }
  } finally {
    db.close();
  }
}

async function assertDetailedCliFlow(): Promise<void> {
  const missing = JSON.parse(
    await runCli(traceArgs('json')),
  ) as DetailedTrace;
  expect(missing.diagnostics).toContainEqual(expect.objectContaining({
    code: 'trace_runtime_variables_missing',
    missingVariables: [complexKey],
  }));
  expect(missing.edges.some((edge) =>
    edge.type === 'event_name_matches_subscription_handler'
    && edge.evidence.eventName === 'Created')).toBe(true);
  expect(missing.edges.filter((edge) =>
    edge.type === 'event_name_matches_subscription_handler'
    && edge.evidence.eventName === 'Duplicated')).toHaveLength(2);
  const exactArgs = [
    ...traceArgs('json'), '--var', `${complexKey}=lookup`,
  ];
  const resolved = JSON.parse(await runCli(exactArgs)) as DetailedTrace;
  expect(resolved.edges.some((edge) =>
    edge.type === 'remote_action'
    && edge.toLabel.includes('/TargetService/lookup'))).toBe(true);
  expect(resolved.edges.some((edge) =>
    edge.type === 'local_symbol_call'
    && `${edge.fromLabel}:${edge.toLabel}`.includes('lookupLeaf'))).toBe(true);
  expect(resolved.edges.some((edge) =>
    `${edge.fromLabel}:${edge.toLabel}`.includes('firstDuplicateLeaf'))).toBe(true);
  expect(resolved.edges.some((edge) =>
    `${edge.fromLabel}:${edge.toLabel}`.includes('secondDuplicateLeaf'))).toBe(true);
}

async function assertCompactCliFlow(): Promise<void> {
  const missing = JSON.parse(
    await runCli(traceArgs('compact-json')),
  ) as CompactTrace;
  const diagnostic = missing.diagnostics.find(
    (item) => item[2] === 'trace_runtime_variables_missing',
  );
  expect(diagnostic?.[6]).toMatchObject({
    missingVariableNames: [complexKey],
    missingVariableCount: 1,
    shownMissingVariableCount: 1,
    omittedMissingVariableCount: 0,
  });
  const exactArgs = [
    ...traceArgs('compact-json'), '--var', `${complexKey}=lookup`,
  ];
  const compact = JSON.parse(await runCli(exactArgs)) as CompactTrace;
  expect(compact.query.suppliedVariableNames).toEqual([complexKey]);
  expect(compact.edges.filter((edge) =>
    edge[3] === 'event_name_matches_subscription_handler')).toHaveLength(4);
  expect(compact.nodes.some((node) =>
    node[2].includes('lookupLeaf'))).toBe(true);
}

async function verifyComplexGet(): Promise<void> {
  assertIndexedDynamicPath();
  await assertDetailedCliFlow();
  await assertCompactCliFlow();
}

beforeAll(prepareFixture, 60_000);

afterAll(async () => {
  if (fixtureState)
    await rm(fixtureState.root, { recursive: true, force: true });
});

describe('neutral built-CLI provenance flow', () => {
  it('persists distinct exact owners for duplicate subscriptions on one line',
    assertStoredRegistrations);
  it('selects the exact binding site in two minified lexical scopes',
    assertScopedBindings);
  it('keeps a complex GET dynamic until its exact CLI variable is supplied',
    verifyComplexGet);
});
