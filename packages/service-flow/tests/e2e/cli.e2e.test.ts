import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { openDatabase } from '../../src/db/connection.js';
const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const fixture = path.resolve('tests/fixtures/cap-workspace');
const traceFixture = path.resolve('tests/fixtures/trace-correctness-workspace');
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
    const parsed = JSON.parse(traceResult.stdout) as { edges: unknown[] };
    expect(parsed.edges.length).toBeGreaterThan(0);
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
    const listResult = await runResult(['list', 'operations', '--workspace', fixture, '--repo', 'facade-service']);
    expect(listResult.stderr).toBe('');
    expect(JSON.parse(listResult.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'facade-service' }),
    ]));
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

describe('service-flow guided trace CLI', () => {
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
    ])) as { edges: Array<{ unresolvedReason?: string; to?: string }> };
    expect(runtime.edges.some((edge) =>
      edge.to === '/ProductProcessService/runDeepCheck')).toBe(true);
    expect(runtime.edges.filter((edge) => edge.unresolvedReason)).toEqual([]);

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
    ])) as { edges: Array<{ type?: string; to?: string }> };
    const guidedImplementation = guided.edges.find((edge) =>
      edge.type === 'operation_implemented_by_handler');
    expect(guidedImplementation?.to).toContain('ActivateHandlerA.activate');

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
