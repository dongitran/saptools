import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

const cli = path.resolve('dist/cli.js');
const databaseCallCount = 1_200;

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CompactCliDocument {
  schema: string;
  query: {
    depth: number;
    includeAsync: boolean;
    includeDb: boolean;
    includeExternal: boolean;
  };
  source: { schemaVersion: number; analyzerVersion: string };
  summary: { fullTraceEdges: number };
  edges: unknown[];
}

let workspaceRoot: string | undefined;
let databasePath: string | undefined;
let linkOutput = '';

function currentWorkspace(): { root: string; dbPath: string } {
  if (!workspaceRoot || !databasePath)
    throw new Error('Compact CLI fixture was not initialized');
  return { root: workspaceRoot, dbPath: databasePath };
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

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function runCli(args: string[]): Promise<ProcessResult> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [exit, stdout, stderr] = await Promise.all([
    waitForExit(child), readText(child.stdout), readText(child.stderr),
  ]);
  return { ...exit, stdout, stderr };
}

async function runCliOk(args: string[]): Promise<string> {
  const result = await runCli(args);
  if (result.code !== 0 || result.signal)
    throw new Error(`CLI failed (${String(result.code)}): ${result.stderr}`);
  if (result.stderr) throw new Error(`Unexpected CLI stderr: ${result.stderr}`);
  return result.stdout;
}

function parseCompact(output: string): CompactCliDocument {
  expect(output.endsWith('\n')).toBe(true);
  expect(output.slice(0, -1)).not.toContain('\n');
  return JSON.parse(output) as CompactCliDocument;
}

function queryStatements(): string {
  return Array.from({ length: databaseCallCount }, (_, index) =>
    `    await cds.run(SELECT.from(CliRows${String(index).padStart(4, '0')}));`,
  ).join('\n');
}

async function writeWorkspace(root: string): Promise<void> {
  await mkdir(path.join(root, 'srv'), { recursive: true });
  await writeFile(path.join(root, '.git-fixture'), '');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@neutral/compact-cli', version: '1.0.0',
    dependencies: { '@sap/cds': '1.0.0', 'cds-routing-handlers': '1.0.0' },
  }));
  await writeFile(path.join(root, 'srv', 'service.cds'),
    'service CompactCliService { action run(); }');
  await writeFile(path.join(root, 'srv', 'CompactCliHandler.ts'), `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class CompactCliHandler {
  @Action('run')
  async run(): Promise<void> {
${queryStatements()}
  }
}
`);
  await writeFile(path.join(root, 'srv', 'server.ts'), `
import { createCombinedHandler } from 'cds-routing-handlers';
import { CompactCliHandler } from './CompactCliHandler.js';
createCombinedHandler({ handler: [CompactCliHandler] });
`);
}

async function prepareWorkspace(): Promise<void> {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'service-flow-compact-cli-'));
  databasePath = path.join(workspaceRoot, 'service-flow.db');
  await writeWorkspace(workspaceRoot);
  await runCliOk(['init', workspaceRoot, '--db', databasePath]);
  await runCliOk(['index', '--workspace', workspaceRoot, '--force']);
  linkOutput = await runCliOk(['link', '--workspace', workspaceRoot, '--force']);
}

async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function redirectCompact(
  command: 'trace' | 'graph',
  output: string,
): Promise<void> {
  const { root } = currentWorkspace();
  const script = '"$1" "$2" "$3" --workspace "$4" --repo "@neutral/compact-cli" --operation run --format compact-json > "$5"';
  const child = spawn('/bin/sh', [
    '-c', script, 'compact-cli-redirect',
    process.execPath, cli, command, root, output,
  ], { cwd: path.resolve('.'), stdio: ['ignore', 'ignore', 'pipe'] });
  const [exit, stderr] = await Promise.all([
    waitForExit(child), readText(child.stderr),
  ]);
  expect(exit).toEqual({ code: 0, signal: null });
  expect(stderr).toBe('');
}

async function runWithShortReader(args: string[]): Promise<ProcessResult> {
  const reader = spawn('head', ['-c', '1'], { stdio: ['pipe', 'ignore', 'ignore'] });
  if (!reader.stdin) throw new Error('Short reader stdin is unavailable');
  const producer = spawn(process.execPath, [cli, ...args], {
    cwd: path.resolve('.'), stdio: ['ignore', reader.stdin, 'pipe'],
  });
  const stderr = readText(producer.stderr);
  const [exit] = await Promise.all([waitForExit(producer), waitForExit(reader)]);
  return { ...exit, stdout: '', stderr: await stderr };
}

beforeAll(async () => { await prepareWorkspace(); }, 60_000);

afterAll(async () => {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
});

describe('compact JSON CLI contract', () => {
  it('emits minified trace JSON and preserves graph preset semantics', async () => {
    const { root } = currentWorkspace();
    const traceArgs = [
      'trace', '--workspace', root, '--repo', '@neutral/compact-cli',
      '--operation', 'run', '--depth', '7', '--include-async',
      '--format', 'compact-json',
    ];
    const firstTraceOutput = await runCliOk(traceArgs);
    const trace = parseCompact(firstTraceOutput);
    expect(trace.schema).toBe('service-flow/compact-graph@1');
    expect(trace.query).toEqual(expect.objectContaining({
      depth: 7, includeAsync: true, includeDb: false, includeExternal: false,
    }));
    expect(await runCliOk(traceArgs)).toBe(firstTraceOutput);

    const graph = parseCompact(await runCliOk([
      'graph', '--workspace', root, '--repo', '@neutral/compact-cli',
      '--operation', 'run', '--format', 'compact-json',
    ]));
    expect(graph.query).toEqual(expect.objectContaining({
      depth: 100, includeAsync: true, includeDb: true, includeExternal: true,
    }));
    expect(graph.source).toEqual(expect.objectContaining({
      schemaVersion: 12, analyzerVersion: '0.1.66-facts.1',
    }));
    expect(graph.summary.fullTraceEdges).toBeGreaterThan(databaseCallCount);
  });

  it('rejects unknown formats before workspace or database access', async () => {
    const missing = path.join(os.tmpdir(), 'service-flow-format-must-not-open');
    const invalidCases = [
      { command: 'trace', format: 'compact-jsno' },
      { command: 'graph', format: 'compact-jsno' },
      { command: 'graph', format: 'table' },
    ];
    for (const { command, format } of invalidCases) {
      const result = await runCli([
        command, '--workspace', missing, '--format', format,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/allowed choices/i);
      expect(result.stderr).toContain('compact-json');
      expect(result.stderr).toContain('json');
      expect(result.stderr).toContain('mermaid');
      expect(result.stderr).not.toMatch(/ENOENT|SQLite|database/i);
    }
  });

  it('supports shell redirection and leaves the database byte-identical', async () => {
    const { root, dbPath } = currentWorkspace();
    const before = await fileHash(dbPath);
    const graphTarget = path.join(root, 'compact.graph.json');
    const traceTarget = path.join(root, 'compact.trace.json');
    await redirectCompact('graph', graphTarget);
    await redirectCompact('trace', traceTarget);
    for (const target of [graphTarget, traceTarget]) {
      const redirected = parseCompact(await readFile(target, 'utf8'));
      expect(redirected.schema).toBe('service-flow/compact-graph@1');
    }
    await runCliOk([
      'trace', '--workspace', root, '--repo', '@neutral/compact-cli',
      '--operation', 'run', '--format', 'compact-json',
    ]);
    expect(await fileHash(dbPath)).toBe(before);
  });

  it('inherits clean EPIPE handling for compact output', async () => {
    const { root } = currentWorkspace();
    const args = [
      'graph', '--workspace', root, '--repo', '@neutral/compact-cli',
      '--operation', 'run', '--format', 'compact-json',
    ];
    const complete = await runCliOk(args);
    expect(Buffer.byteLength(complete)).toBeGreaterThan(128 * 1024);
    const result = await runWithShortReader(args);
    expect(result).toEqual({ code: 0, signal: null, stdout: '', stderr: '' });
  });

  it('reports release and subscription-link summary contracts', async () => {
    expect(await runCliOk(['--version'])).toBe('0.1.67\n');
    expect(linkOutput).toContain('subscription handlers resolved');
    expect(linkOutput).toContain('subscription handlers ambiguous');
    expect(linkOutput).toContain('subscription handlers unresolved');
    expect(linkOutput).toContain('subscription handler associations missing');
  });
});
