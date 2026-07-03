import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
const execFileAsync = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const fixture = path.resolve('tests/fixtures/cap-workspace');
async function run(args: string[], cwd = path.resolve('.')): Promise<string> { const { stdout, stderr } = await execFileAsync('node', [cli, ...args], { cwd }); return `${stdout}${stderr}`; }
describe('service-flow CLI', () => {
  it('runs init index link trace graph doctor', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'service-flow-e2e-')); const db = path.join(dir, 'service-flow.db'); await run(['init', fixture, '--db', db]); await run(['index', '--workspace', fixture]); await run(['link', '--workspace', fixture]); const json = await run(['trace', '--workspace', fixture, '--repo', 'facade-service', '--operation', 'doWork', '--include-db', '--include-async', '--include-external', '--format', 'json']); const parsed = JSON.parse(json) as { edges: unknown[] }; expect(parsed.edges.length).toBeGreaterThan(0); const mermaid = await run(['graph', '--workspace', fixture, '--repo', 'facade-service', '--operation', 'doWork', '--format', 'mermaid']); expect(mermaid).toContain('flowchart TD'); const doctor = await run(['doctor', '--workspace', fixture]); expect(doctor).toMatch(/No diagnostics|\[/); });
});
