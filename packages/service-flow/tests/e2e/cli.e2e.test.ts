import { describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { openDatabase } from '../../src/db/connection.js';
const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const fixture = path.resolve('tests/fixtures/cap-workspace');
const traceFixture = path.resolve('tests/fixtures/trace-correctness-workspace');
const pipeSafetyOutputFloorBytes = 128 * 1024;
async function runResult(
  args: string[],
  cwd = path.resolve('.'),
  nodeArgs: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('node', [...nodeArgs, cli, ...args], {
    cwd
  });
  return { stdout, stderr };
}
async function run(
  args: string[],
  cwd = path.resolve('.'),
  nodeArgs: string[] = [],
): Promise<string> {
  const { stdout } = await runResult(args, cwd, nodeArgs);
  return stdout;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function readText(stream: Readable | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { text += chunk; });
    stream.once('error', reject);
    stream.once('end', () => resolve(text));
  });
}

async function runWithExit(args: string[]): Promise<{
  exit: ProcessExit;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = readText(child.stdout);
  const stderr = readText(child.stderr);
  return {
    exit: await waitForExit(child),
    stdout: await stdout,
    stderr: await stderr,
  };
}

async function runWithShortReader(args: string[]): Promise<{
  producer: ProcessExit;
  stderr: string;
}> {
  const reader = spawn('head', ['-c', '1'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (!reader.stdin) throw new Error('Short reader stdin is unavailable');
  const producer = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'),
    stdio: ['ignore', reader.stdin, 'pipe'],
  });
  const stderr = readText(producer.stderr);
  const [producerExit] = await Promise.all([
    waitForExit(producer),
    waitForExit(reader),
  ]);
  return { producer: producerExit, stderr: await stderr };
}

async function measureOutput(args: string[]): Promise<{
  producer: ProcessExit;
  outputBytes: number;
  stderr: string;
}> {
  const producer = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!producer.stdout) throw new Error('Producer stdout is unavailable');
  let outputBytes = 0;
  producer.stdout.on('data', (chunk: Buffer) => { outputBytes += chunk.length; });
  const stderr = readText(producer.stderr);
  const producerExit = await waitForExit(producer);
  return { producer: producerExit, outputBytes, stderr: await stderr };
}

function largeRemoteCallBody(): string {
  const outputTargetBytes = pipeSafetyOutputFloorBytes;
  const call = "    await client.send({ method: 'POST', path: '/dispatch' });\n";
  return call.repeat(Math.ceil(outputTargetBytes / Buffer.byteLength(call)));
}

async function preparePipeOutputWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-pipe-output-'));
  await writeFile(path.join(root, '.git-fixture'), '');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@neutral/pipe-output-app', version: '1.0.0',
  }));
  await writeFile(path.join(root, 'service.cds'), 'service PipeOutputService { action emitLarge(); }');
  await writeFile(path.join(root, 'PipeOutputHandler.ts'), `import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class PipeOutputHandler {
  @Action('emitLarge')
  async emitLarge(): Promise<void> {
    const client = await cds.connect.to('remote');
${largeRemoteCallBody()}  }
}
`);
  await writeFile(path.join(root, 'server.ts'), `import { createCombinedHandler } from 'cds-routing-handlers';
import { PipeOutputHandler } from './PipeOutputHandler.js';
createCombinedHandler({ handler: [PipeOutputHandler] });
`);
  const db = path.join(root, 'service-flow.db');
  await runResult(['init', root, '--db', db]);
  await runResult(['index', '--workspace', root, '--force']);
  await runResult(['link', '--workspace', root, '--force']);
  return root;
}
describe('service-flow CLI', () => {
  it('runs init index link trace graph list and doctor', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'service-flow-e2e-'));
    const db = path.join(dir, 'service-flow.db');
    await expect(runResult(['init', fixture, '--db', db])).resolves.toMatchObject({ stderr: '' });
    await expect(runResult(['index', '--workspace', fixture])).resolves.toMatchObject({ stderr: '' });
    await expect(runResult(['link', '--workspace', fixture])).resolves.toMatchObject({ stderr: '' });
    const traceResult = await runResult([
      'trace',
      '--workspace',
      fixture,
      '--repo',
      'facade-service',
      '--handler',
      'EntryHandler',
      '--include-db',
      '--include-async',
      '--include-external',
      '--format',
      'json'
    ]);
    expect(traceResult.stderr).toBe('');
    const parsed = JSON.parse(traceResult.stdout) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(parsed.edges.length).toBeGreaterThan(0);
    const traceNodeIds = new Set(parsed.nodes.map((node) => node.id));
    expect(parsed.edges.every((edge) =>
      traceNodeIds.has(edge.from) && traceNodeIds.has(edge.to))).toBe(true);
    const warningHook = path.join(dir, 'stderr-warning.cjs');
    await writeFile(
      warningHook,
      "process.stderr.write('synthetic stderr warning from runtime\\n');\n",
    );
    const jsonWithWarning = await run(
      [
        'trace',
        '--workspace',
        fixture,
        '--repo',
        'facade-service',
        '--handler',
        'EntryHandler',
        '--include-db',
        '--include-async',
        '--include-external',
        '--format',
        'json'
      ],
      path.resolve('.'),
      ['--require', warningHook],
    );
    const parsedWithWarning = JSON.parse(jsonWithWarning) as {
      edges: unknown[];
    };
    expect(parsedWithWarning.edges.length).toBeGreaterThan(0);
    const graphResult = await runResult([
      'graph',
      '--workspace',
      fixture,
      '--repo',
      'facade-service',
      '--operation',
      'doWork',
      '--format',
      'mermaid'
    ]);
    expect(graphResult.stderr).toBe('');
    expect(graphResult.stdout).toContain('flowchart TD');
    const graphJson = JSON.parse(await run([
      'graph', '--workspace', fixture, '--repo', 'facade-service',
      '--operation', 'doWork', '--format', 'json',
    ])) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const graphNodeIds = new Set(graphJson.nodes.map((node) => node.id));
    expect(graphJson.edges.every((edge) =>
      graphNodeIds.has(edge.from) && graphNodeIds.has(edge.to))).toBe(true);
    const listResult = await runResult(['list', 'operations', '--workspace', fixture, '--repo', 'facade-service']);
    expect(listResult.stderr).toBe('');
    expect(JSON.parse(listResult.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'facade-service' }),
    ]));
    const inspectedOperation = JSON.parse(await run([
      'inspect', 'operation', 'doWork', '--workspace', fixture,
    ])) as Array<Record<string, unknown>>;
    expect(inspectedOperation).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repository_name: 'facade-service',
        service_name: 'FacadeService',
      }),
    ]));
    const unknownOperation = JSON.parse(await run([
      'inspect', 'operation', 'neutralMissingOperation',
      '--workspace', fixture,
    ])) as Array<{ code?: string }>;
    expect(unknownOperation).toEqual([
      expect.objectContaining({ code: 'selector_operation_not_found' }),
    ]);
    const doctorResult = await runResult(['doctor', '--workspace', fixture]);
    expect(doctorResult.stderr).toBe('');
    expect(doctorResult.stdout).toMatch(/No diagnostics|\[/);
    const strictDoctorResult = await runResult(['doctor', '--workspace', fixture, '--strict']);
    expect(strictDoctorResult.stderr).toBe('');
    const strictDiagnostics = JSON.parse(strictDoctorResult.stdout) as Array<{ code?: string; topUnresolvedCallees?: unknown[] }>;
    expect(strictDiagnostics.some((item) => item.code === 'strict_symbol_call_quality' && Array.isArray(item.topUnresolvedCallees))).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_db_query_quality')).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_outbound_evidence_quality')).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_graph_evidence_quality')).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_event_receiver_classification_quality')).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_graph_dynamic_flag_consistency')).toBe(true);
    const detailDoctorResult = await runResult(['doctor', '--workspace', fixture, '--strict', '--detail']);
    expect(detailDoctorResult.stderr).toBe('');
    expect(JSON.parse(detailDoctorResult.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'strict_implementation_candidate_quality' }),
    ]));
  });
});

describe('service-flow CLI link wording', () => {
  it('splits remote and local operation resolution labels', async () => {
    const linkResult = await runResult(['link', '--workspace', fixture]);
    expect(linkResult.stderr).toBe('');
    expect(linkResult.stdout).toContain('remote operation calls resolved');
    expect(linkResult.stdout).toContain('local operation calls resolved');
    expect(linkResult.stdout).not.toContain('remote resolved');
  });
});

describe('service-flow CLI lifecycle guards', () => {
  it('rejects unbounded traces and unsupported doctor detail mode', async () => {
    for (const args of [
      ['trace', '--workspace', path.join(os.tmpdir(), 'unused-workspace')],
      ['doctor', '--workspace', path.join(os.tmpdir(), 'unused-workspace'),
        '--detail'],
    ]) {
      const result = await runWithExit(args);
      expect(result.exit).toEqual({ code: 1, signal: null });
      expect(result.stdout).toBe('');
    }
  });

  it('blocks list and inspect commands when indexed facts are stale', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'service-flow-read-guard-'),
    );
    const dbPath = path.join(root, 'service-flow.db');
    await writeFile(path.join(root, '.git-fixture'), '');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@neutral/read-guard', version: '1.0.0',
    }));
    await writeFile(
      path.join(root, 'index.ts'),
      'export const currentFact = true;\n',
    );
    await run(['init', root, '--db', dbPath]);
    await run(['index', '--workspace', root, '--force']);
    const db = openDatabase(dbPath);
    db.prepare(
      "UPDATE repositories SET fact_analyzer_version='stale-facts'",
    ).run();
    db.close();

    const commands = [
      ['list', 'repos', '--workspace', root],
      ['inspect', 'repo', '@neutral/read-guard', '--workspace', root],
    ];
    for (const args of commands) {
      const result = await runWithExit(args);
      expect(result.exit).toEqual({ code: 1, signal: null });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ code: 'reindex_required' }),
      ]);
    }
  });
});

describe('service-flow CLI pipe safety', () => {
  it('finishes cleanly when a short Unix reader closes JSON, table, or Mermaid output', async () => {
    const workspace = await preparePipeOutputWorkspace();
    const commands = [
      ['trace', '--workspace', workspace, '--repo', '@neutral/pipe-output-app', '--handler', 'PipeOutputHandler', '--format', 'json'],
      ['trace', '--workspace', workspace, '--repo', '@neutral/pipe-output-app', '--handler', 'PipeOutputHandler', '--format', 'table'],
      ['graph', '--workspace', workspace, '--repo', '@neutral/pipe-output-app', '--operation', 'emitLarge', '--format', 'mermaid'],
    ];
    for (const args of commands) {
      const complete = await measureOutput(args);
      expect(complete.producer).toEqual({ code: 0, signal: null });
      expect(complete.stderr).toBe('');
      expect(complete.outputBytes).toBeGreaterThan(pipeSafetyOutputFloorBytes);
      const result = await runWithShortReader(args);
      expect(result.producer).toEqual({ code: 0, signal: null });
      expect(result.stderr).not.toMatch(/EPIPE|Unhandled 'error' event/i);
    }
  });
});

describe('service-flow guided trace CLI', () => {
  it('documents repeatable event environment keys on index help', async () => {
    const help = await run(['index', '--help']);
    expect(help).toContain('--event-environment-key <key>');
    expect(help).toContain('repeatable');
  });

  it('persists explicit event environment keys for later index runs', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'service-flow-environment-key-'),
    );
    await writeFile(path.join(root, '.git-fixture'), '');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@neutral/environment-key', version: '1.0.0',
    }));
    await writeFile(
      path.join(root, 'events.ts'),
      'export const topic = process.env.NEUTRAL_EVENT_KEY;\n',
    );
    await run(['init', root]);
    await run([
      'index', '--workspace', root, '--force',
      '--event-environment-key', 'NEUTRAL_EVENT_KEY',
    ]);
    const config = JSON.parse(await readFile(
      path.join(root, '.service-flow', 'config.json'), 'utf8',
    )) as { eventEnvironmentKeys?: string[] };
    expect(config.eventEnvironmentKeys).toEqual(['NEUTRAL_EVENT_KEY']);
    await expect(run([
      'index', '--workspace', root,
    ])).resolves.toContain('Indexed 0 repositories, skipped 1');
  });

  it('runs runtime substitution, ambiguity, hints, doctor, and SQLite checks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'service-flow-guided-e2e-'));
    const dbPath = path.join(dir, 'service-flow.db');
    await run(['init', traceFixture, '--db', dbPath]);
    await run(['index', '--workspace', traceFixture, '--force']);
    await run(['link', '--workspace', traceFixture, '--force']);

    const runtime = JSON.parse(await run([
      'trace', '--workspace', traceFixture,
      '--repo', 'gateway-app',
      '--operation', 'runCompositeCheck',
      '--format', 'json',
      '--include-db', '--include-external', '--include-async',
      '--var', 'domain=Product',
      '--var', 'shortName=prod',
    ])) as { edges: Array<{
      evidence?: { sourceFile?: string };
      from?: string;
      fromLabel?: string;
      to?: string;
      toLabel?: string;
      type?: string;
      unresolvedReason?: string;
    }> };
    expect(runtime.edges.some((edge) =>
      edge.toLabel === '/ProductProcessService/runDeepCheck')).toBe(true);
    const gaps = runtime.edges.filter((edge) => edge.unresolvedReason);
    expect(gaps).toEqual([]);

    const missing = JSON.parse(await run([
      'trace', '--workspace', traceFixture,
      '--repo', 'gateway-app',
      '--operation', 'runCompositeCheck',
      '--format', 'json',
      '--include-db', '--include-external', '--include-async',
    ])) as { diagnostics: Array<{ code?: string; missingVariables?: string[] }> };
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
      missingVariables: ['domain', 'shortName'],
    }));
    const candidateMode = JSON.parse(await run([
      'trace', '--workspace', traceFixture,
      '--repo', 'gateway-app',
      '--operation', 'runCompositeCheck',
      '--format', 'json',
      '--include-db', '--include-external', '--include-async',
      '--dynamic-mode', 'candidates',
      '--max-dynamic-candidates', '2',
    ])) as { diagnostics: Array<{ code?: string }>; edges: unknown[] };
    expect(candidateMode.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
    }));
    expect(candidateMode.edges.length).toBeGreaterThan(0);
    const graphCandidateMode = JSON.parse(await run([
      'graph', '--workspace', traceFixture,
      '--repo', 'gateway-app',
      '--operation', 'runCompositeCheck',
      '--format', 'json',
      '--dynamic-mode', 'candidates',
      '--max-dynamic-candidates', '2',
    ])) as { edges: unknown[] };
    expect(graphCandidateMode.edges.length).toBeGreaterThan(0);

    const ambiguous = JSON.parse(await run([
      'trace', '--workspace', traceFixture,
      '--repo', 'process-service',
      '--service', '/ProductProcessService',
      '--operation', 'activate',
      '--format', 'json',
      '--include-db', '--include-external', '--include-async',
    ])) as { diagnostics: Array<{ resolutionStatus?: string }> };
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({
      resolutionStatus: 'ambiguous_implementation',
    }));

    const guided = JSON.parse(await run([
      'trace', '--workspace', traceFixture,
      '--repo', 'process-service',
      '--service', '/ProductProcessService',
      '--operation', 'activate',
      '--format', 'json',
      '--include-db', '--include-external', '--include-async',
      '--implementation-hint',
      'service=/ProductProcessService,operation=/activate,repo=process-helper-a',
    ])) as {
      edges: Array<{ type?: string; to?: string; toLabel?: string }>;
    };
    const guidedImplementation = guided.edges.find((edge) =>
      edge.type === 'operation_implemented_by_handler');
    expect(guidedImplementation?.toLabel)
      .toContain('ActivateHandlerA.activate');

    const doctorJson = JSON.parse(await run([
      'doctor', '--workspace', traceFixture, '--strict', '--format', 'json',
    ])) as Array<{ code?: string }>;
    expect(doctorJson).toContainEqual(expect.objectContaining({
      code: 'strict_service_binding_quality',
    }));
    const doctorTable = await run([
      'doctor', '--workspace', traceFixture, '--strict', '--format', 'table',
    ]);
    expect(doctorTable).toContain('Severity');
    expect(doctorTable).toContain('strict_service_binding_quality');

    const db = openDatabase(dbPath, { readonly: true });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
