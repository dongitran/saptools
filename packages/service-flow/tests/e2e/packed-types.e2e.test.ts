import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '../..');

interface PackResult {
  filename: string;
}

function packedFilename(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('npm pack did not return an array');
  const first = parsed[0] as PackResult | undefined;
  if (!first || typeof first.filename !== 'string')
    throw new Error('npm pack did not return a filename');
  return first.filename;
}

async function extractPackedPackage(root: string): Promise<void> {
  const cache = path.join(root, 'npm-cache');
  await mkdir(cache, { recursive: true });
  const packed = await run('npm', [
    'pack', packageRoot, '--json', '--pack-destination', root,
  ], {
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  });
  const archive = path.join(root, packedFilename(packed.stdout));
  const staging = path.join(root, 'staging');
  const target = path.join(
    root, 'node_modules', '@saptools', 'service-flow',
  );
  await mkdir(staging, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', staging]);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(path.join(staging, 'package'), target);
}

async function writeConsumer(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }));
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      skipLibCheck: true,
    },
    include: ['consumer.ts'],
  }));
  await writeFile(path.join(root, 'consumer.ts'), consumerSource);
}

const consumerSource = `
import { compactTrace, trace, traceAndCompact } from '@saptools/service-flow';
import type {
  CallType, CompactDecisionV1, CompactDiagnosticDetailsV1,
  CompactReferenceGroupV1, Db, EdgeType, ExecutableSymbolFact,
  OutboundCallFact, SymbolCallFact, SymbolCallRole, TraceEdge, TraceOptions,
  TraceResult, TraceStart,
} from '@saptools/service-flow';

declare const db: Db;
const start: TraceStart = {};
const options: TraceOptions = { depth: 1 };
const detailed: TraceResult = trace(db, start, options);
const compact = compactTrace(db, start, options);
const paired = traceAndCompact(db, start, options);
const group: CompactReferenceGroupV1 = {
  values: ['repo-a'], total: 1, shown: 1, omitted: 0,
};
const decision: CompactDecisionV1 = { tiedCandidateRepos: group };
const diagnostic: CompactDiagnosticDetailsV1 = {
  selectorKind: 'operation',
  selectorSuggestions: group,
  invalidFactCategories: group,
};
const contracts: [
  CallType, EdgeType, ExecutableSymbolFact, OutboundCallFact,
  SymbolCallRole, SymbolCallFact, TraceEdge,
] | undefined = undefined;
void [detailed, compact, paired, decision, diagnostic, contracts];
`;

describe('packed public TypeScript contract', () => {
  it('imports fact types and trace entry points through the package root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-consumer-'));
    await extractPackedPackage(root);
    await writeConsumer(root);
    const compiler = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = await run(process.execPath, [compiler, '-p', root], { cwd: root });
    expect(result.stderr).toBe('');
  });
});
