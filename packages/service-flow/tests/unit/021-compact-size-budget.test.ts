import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { renderCompactJson } from '../../src/output/001-compact-json-output.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import type {
  CompactGraphV1,
  CompactNodeRowV1,
} from '../../src/trace/014-compact-contract.js';
import {
  traceAndCompact,
  type CompactTraceExecution,
} from '../../src/trace/018-compact-trace.js';
import type { TraceOptions, TraceStart } from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const asyncQueryCount = 72;
const dynamicCallCount = 110;
const payloadSentinel = 'PAYLOAD_ONLY_PRIVATE_COMPACT_BUDGET_VALUE';
const runtimeSentinel = 'Bearer runtime-only-compact-budget-value';
const forbiddenCompactKeys = new Set([
  'candidates', 'candidateScores', 'dynamicTargetCandidates',
  'dynamicTargetCandidateSuggestions', 'candidateSuggestions',
  'rejectedCandidates', 'suppliedVariables', 'suppliedRuntimeVariables',
  'appliedSuppliedVariables', 'callArguments', 'payload', 'payloadSummary',
  'astText', 'rawExpression', 'rawPathExpression', 'rawOperationExpression',
  'odataPathIntent', 'pathAnalysis', 'helperChain', 'parserEvidence',
  'outboundEvidence', 'linker', 'effectiveResolution',
  'categories', 'suggestions', 'copyableExamples',
]);

interface IndexedFixture {
  db: Db;
  workspaceId: number;
}

interface SizeMetrics {
  compactBytes: number;
  prettyBytes: number;
  minifiedBytes: number;
  edgeCount: number;
  hash: string;
}

let asyncFixture: IndexedFixture | undefined;
let dynamicFixture: IndexedFixture | undefined;

function fixture(value: IndexedFixture | undefined, name: string): IndexedFixture {
  if (!value) throw new Error(`${name} size fixture was not initialized`);
  return value;
}

function repeatedStatements(count: number, statement: string): string {
  return Array.from({ length: count }, () => `    ${statement}`).join('\n');
}

async function writeAsyncRepository(root: string): Promise<void> {
  await writeFixtureFile(root, 'compact-async/.git-fixture');
  await writeFixtureFile(root, 'compact-async/package.json', JSON.stringify({
    name: '@neutral/compact-async', version: '1.0.0',
  }));
  await writeFixtureFile(root, 'compact-async/srv/service.cds',
    'service CompactAsyncService { action begin(); }');
  await writeAsyncEntryHandler(root);
  await writeAsyncSubscriber(root);
  await writeFixtureFile(root, 'compact-async/src/register.ts', `
import { budgetSubscriber } from './subscriber.js';
messaging.on('CompactBudgetEvent', budgetSubscriber);
`);
  await writeFixtureFile(root, 'compact-async/src/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { BudgetEntryHandler } from './BudgetEntryHandler.js';
createCombinedHandler({ handler: [BudgetEntryHandler] });
`);
}

async function writeAsyncEntryHandler(root: string): Promise<void> {
  const queries = repeatedStatements(
    asyncQueryCount,
    'await cds.run(SELECT.from(EmitterBudgetRows));',
  );
  await writeFixtureFile(root, 'compact-async/src/BudgetEntryHandler.ts', `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class BudgetEntryHandler {
  @Action('begin')
  async begin(): Promise<void> {
${queries}
    await messaging.emit('CompactBudgetEvent', { marker: '${payloadSentinel}' });
  }
}
`);
}

async function writeAsyncSubscriber(root: string): Promise<void> {
  const queries = repeatedStatements(
    asyncQueryCount,
    'await cds.run(SELECT.from(SubscriberBudgetRows));',
  );
  await writeFixtureFile(root, 'compact-async/src/subscriber.ts', `
import cds from '@sap/cds';
export async function budgetSubscriber(): Promise<void> {
${queries}
}
`);
}

async function writeDynamicGateway(root: string): Promise<void> {
  await writeFixtureFile(root, 'compact-gateway/.git-fixture');
  await writeFixtureFile(root, 'compact-gateway/package.json', JSON.stringify({
    name: '@neutral/compact-gateway', version: '1.0.0',
    cds: { requires: {
      svc_alpha_process: dynamicRequire('Alpha'),
      svc_beta_process: dynamicRequire('Beta'),
    } },
  }));
  await writeFixtureFile(root, 'compact-gateway/srv/gateway.cds',
    'service CompactGatewayService { action route(); }');
  await writeDynamicHandler(root);
  await writeFixtureFile(root, 'compact-gateway/srv/server.ts', `
import { createCombinedHandler } from 'cds-routing-handlers';
import { CompactGatewayHandler } from './CompactGatewayHandler.js';
createCombinedHandler({ handler: [CompactGatewayHandler] });
`);
}

function dynamicRequire(prefix: string): Record<string, unknown> {
  return {
    kind: 'odata',
    credentials: {
      destination: `svc_${prefix.toLowerCase()}_process`,
      path: `/${prefix}ProcessService`,
    },
  };
}

async function writeDynamicHandler(root: string): Promise<void> {
  const sends = repeatedStatements(dynamicCallCount,
    `await client.send({ method: 'POST', path: '/collectPaths', data: { marker: '${payloadSentinel}' } });`);
  await writeFixtureFile(root, 'compact-gateway/srv/CompactGatewayHandler.ts', `
import cds from '@sap/cds';
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class CompactGatewayHandler {
  @Action('route')
  async route(domainName: string, domainCode: string): Promise<void> {
    const client = await cds.connect.to(\`svc_\${domainCode}_process\`, {
      credentials: {
        destination: \`svc_\${domainCode}_process\`,
        path: \`/\${domainName}ProcessService\`,
      },
    });
${sends}
  }
}
`);
}

async function writeProcessRepository(
  root: string,
  repo: string,
  prefix: string,
): Promise<void> {
  const className = `${prefix}ProcessHandler`;
  await writeFixtureFile(root, `${repo}/.git-fixture`);
  await writeFixtureFile(root, `${repo}/package.json`, JSON.stringify({
    name: `@neutral/${repo}`, version: '1.0.0',
  }));
  await writeFixtureFile(root, `${repo}/srv/process.cds`,
    `service ${prefix}ProcessService { action collectPaths(); }`);
  await writeFixtureFile(root, `${repo}/srv/${className}.ts`, `
import { Action, Handler } from 'cds-routing-handlers';
@Handler()
export class ${className} {
  @Action('collectPaths')
  async collectPaths(): Promise<void> {}
}
`);
  await writeFixtureFile(root, `${repo}/srv/server.ts`, `
import { createCombinedHandler } from 'cds-routing-handlers';
import { ${className} } from './${className}.js';
createCombinedHandler({ handler: [${className}] });
`);
}

async function prepareAsyncFixture(): Promise<IndexedFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-compact-async-'));
  await writeAsyncRepository(root);
  const prepared = await prepareWorkspace(root);
  linkWorkspace(prepared.db, prepared.workspaceId);
  return prepared;
}

async function prepareDynamicFixture(): Promise<IndexedFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-compact-dynamic-'));
  await writeDynamicGateway(root);
  await writeProcessRepository(root, 'compact-alpha', 'Alpha');
  await writeProcessRepository(root, 'compact-beta', 'Beta');
  const prepared = await prepareWorkspace(root);
  linkWorkspace(prepared.db, prepared.workspaceId);
  return prepared;
}

function asyncOptions(workspaceId: number): TraceOptions {
  return {
    depth: 8, workspaceId, includeAsync: true,
    includeDb: true, includeExternal: true,
  };
}

function dynamicOptions(workspaceId: number): TraceOptions {
  return {
    depth: 8, workspaceId, includeAsync: true,
    includeDb: true, includeExternal: true,
    dynamicMode: 'candidates', maxDynamicCandidates: 5,
    vars: { auditMarker: runtimeSentinel },
  };
}

function sizeMetrics(execution: CompactTraceExecution): SizeMetrics {
  const compact = renderCompactJson(execution.compact);
  const pretty = renderTraceJson(execution.trace);
  const minified = JSON.stringify(execution.trace);
  return {
    compactBytes: Buffer.byteLength(compact),
    prettyBytes: Buffer.byteLength(pretty),
    minifiedBytes: Buffer.byteLength(minified),
    edgeCount: execution.trace.edges.length,
    hash: sha256(compact),
  };
}

function assertSizeBudget(metrics: SizeMetrics): void {
  expect(metrics.edgeCount).toBeGreaterThanOrEqual(100);
  expect(metrics.prettyBytes).toBeGreaterThanOrEqual(50 * 1024);
  expect(metrics.compactBytes).toBeLessThanOrEqual(metrics.prettyBytes * 0.15);
  expect(metrics.compactBytes).toBeLessThanOrEqual(metrics.minifiedBytes * 0.20);
}

function compactNode(
  compact: CompactGraphV1,
  id: string,
): CompactNodeRowV1 | undefined {
  return compact.nodes.find((node) => node[0] === id);
}

function assertAsyncTopology(compact: CompactGraphV1): void {
  const bridge = compact.edges.find((edge) =>
    edge[3] === 'event_name_matches_subscription_handler');
  expect(bridge?.[6]).toBe('inferred');
  if (!bridge) throw new Error('Expected an inferred event subscriber bridge');
  const eventNode = compactNode(compact, bridge[4]);
  expect(eventNode?.[1]).toBe('event');
  expect(eventNode?.[2]).toBe('CompactBudgetEvent');
  expect(compactNode(compact, bridge[5])?.[2]).toContain('budgetSubscriber');
  expect(compact.edges.some((edge) =>
    edge[4] === bridge[5]
    && edge[3] === 'local_db_query'
    && compactNode(compact, edge[5])?.[2].includes('SubscriberBudgetRows'))).toBe(true);
}

function assertDynamicSummaries(compact: CompactGraphV1): void {
  const decisions = compact.edges.flatMap((edge) => edge[9]?.decision
    ? [edge[9].decision] : []);
  expect(decisions.some((decision) =>
    decision.dynamicMode === 'candidates'
    && decision.candidateCount === 2
    && decision.viableCandidateCount === 2)).toBe(true);
  const json = renderCompactJson(compact);
  for (const forbidden of [
    'dynamicTargetCandidates', 'dynamicTargetCandidateSuggestions',
    'candidateScores', 'callArguments', payloadSentinel, runtimeSentinel,
  ]) expect(json).not.toContain(forbidden);
  const projectedKeys = compactObjectKeys(compact);
  for (const forbidden of forbiddenCompactKeys)
    expect(projectedKeys.has(forbidden)).toBe(false);
  expect(compact.query.suppliedVariableNames).toEqual(['auditMarker']);
}

function assertRepeatedBytes(executions: CompactTraceExecution[]): void {
  const values = executions.map((item) => renderCompactJson(item.compact));
  expect(values).toHaveLength(3);
  expect(new Set(values).size).toBe(1);
  expect(new Set(values.map(sha256)).size).toBe(1);
}

function compactObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) compactObjectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.add(key);
    compactObjectKeys(item, keys);
  }
  return keys;
}

function semanticCompactHash(compact: CompactGraphV1): string {
  const edges = compact.edges.map((edge) => [
    edge[2], edge[3], edge[4], edge[5], edge[6], edge[7], edge[8],
    edge[9]?.decision ?? null,
  ]);
  return sha256(JSON.stringify({
    schema: compact.schema, start: compact.start, query: compact.query,
    source: {
      schemaVersion: compact.source.schemaVersion,
      analyzerVersion: compact.source.analyzerVersion,
    },
    summary: compact.summary, repos: compact.repos, files: compact.files,
    nodes: compact.nodes, edges, diagnostics: compact.diagnostics,
  }));
}

function assertDynamicModes(
  strict: CompactGraphV1,
  candidates: CompactGraphV1,
  infer: CompactGraphV1,
): void {
  for (const [compact, mode] of [
    [strict, 'strict'], [candidates, 'candidates'], [infer, 'infer'],
  ] as const) {
    expect(compact.query.dynamicMode).toBe(mode);
    expect(compact.edges.some((edge) =>
      edge[9]?.decision.dynamicMode === mode)).toBe(true);
  }
  expect(strict.edges.some((edge) => edge[3] === 'dynamic_candidate_branch')).toBe(false);
  expect(candidates.edges.some((edge) => edge[3] === 'dynamic_candidate_branch')).toBe(true);
  expect(infer.edges.some((edge) => edge[3] === 'dynamic_candidate_branch')).toBe(false);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reportMetrics(name: string, metrics: SizeMetrics): void {
  if (process.env.SERVICE_FLOW_REPORT_COMPACT_SIZES !== '1') return;
  process.stdout.write(`${name} ${JSON.stringify(metrics)}\n`);
}

beforeAll(async () => {
  asyncFixture = await prepareAsyncFixture();
  dynamicFixture = await prepareDynamicFixture();
}, 60_000);

afterAll(() => {
  asyncFixture?.db.close();
  dynamicFixture?.db.close();
});

  it('compresses an async and database-heavy traversal without losing topology', () => {
    const current = fixture(asyncFixture, 'async');
    const start: TraceStart = {
      repo: 'compact-async', operation: 'begin',
      servicePath: '/CompactAsyncService',
    };
    const options = asyncOptions(current.workspaceId);
    const first = traceAndCompact(current.db, start, options);
    const second = traceAndCompact(current.db, start, options);
    const third = traceAndCompact(current.db, start, options);
    const metrics = sizeMetrics(first);
    assertSizeBudget(metrics);
    assertRepeatedBytes([first, second, third]);
    assertAsyncTopology(first.compact);
    expect(renderCompactJson(first.compact)).not.toContain(payloadSentinel);
    reportMetrics('async-db', metrics);
  });

  it('compresses candidate-heavy traversal using authoritative bounded summaries', () => {
    const current = fixture(dynamicFixture, 'dynamic');
    const start: TraceStart = {
      repo: 'compact-gateway', operation: 'route',
      servicePath: '/CompactGatewayService',
    };
    const options = dynamicOptions(current.workspaceId);
    const first = traceAndCompact(current.db, start, options);
    const second = traceAndCompact(current.db, start, options);
    const third = traceAndCompact(current.db, start, options);
    const metrics = sizeMetrics(first);
    assertSizeBudget(metrics);
    assertRepeatedBytes([first, second, third]);
    assertDynamicSummaries(first.compact);
    const strict = traceAndCompact(current.db, start, {
      ...options, dynamicMode: 'strict',
    }).compact;
    const infer = traceAndCompact(current.db, start, {
      ...options, dynamicMode: 'infer',
    }).compact;
    assertDynamicModes(strict, first.compact, infer);
    expect(renderTraceJson(first.trace)).toContain(runtimeSentinel);
    const stored = current.db.prepare(`SELECT payload_summary payload
      FROM outbound_calls WHERE payload_summary LIKE ? LIMIT 1`)
      .get(`%${payloadSentinel}%`);
    expect(String(stored?.payload ?? '')).toContain(payloadSentinel);
    reportMetrics('dynamic-candidates', metrics);
  });

  it('keeps a semantic hash stable across two clean index and link cycles', async () => {
    const current = fixture(asyncFixture, 'async');
    const start: TraceStart = {
      repo: 'compact-async', operation: 'begin',
      servicePath: '/CompactAsyncService',
    };
    const first = traceAndCompact(
      current.db, start, asyncOptions(current.workspaceId),
    ).compact;
    const rebuilt = await prepareAsyncFixture();
    try {
      const second = traceAndCompact(
        rebuilt.db, start, asyncOptions(rebuilt.workspaceId),
      ).compact;
      expect(semanticCompactHash(second)).toBe(semanticCompactHash(first));
    } finally {
      rebuilt.db.close();
    }
  });
