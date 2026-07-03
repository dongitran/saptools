import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const fixture = path.resolve('tests/fixtures/cap-workspace');
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
  it('runs init index link trace graph doctor', async () => {
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
      '--operation',
      'doWork',
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
        '--operation',
        'doWork',
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
    const doctorResult = await runResult(['doctor', '--workspace', fixture]);
    expect(doctorResult.stderr).toBe('');
    expect(doctorResult.stdout).toMatch(/No diagnostics|\[/);
    const strictDoctorResult = await runResult(['doctor', '--workspace', fixture, '--strict']);
    expect(strictDoctorResult.stderr).toBe('');
    const strictDiagnostics = JSON.parse(strictDoctorResult.stdout) as Array<{ code?: string; topUnresolvedCallees?: unknown[] }>;
    expect(strictDiagnostics.some((item) => item.code === 'strict_symbol_call_quality' && Array.isArray(item.topUnresolvedCallees))).toBe(true);
    expect(strictDiagnostics.some((item) => item.code === 'strict_db_query_quality')).toBe(true);
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
