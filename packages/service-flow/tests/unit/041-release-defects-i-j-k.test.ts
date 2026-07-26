import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import {
  eventSubscriberMissingVariables,
  loadEventSubscriberTransitions,
} from '../../src/trace/011-event-subscriber-traversal.js';
import {
  runtimeEventResolution,
} from '../../src/trace/030-event-runtime-resolution.js';
import {
  reconcileBindingAndCallIdentity,
} from '../../src/parsers/006-binding-identity.js';
import {
  classifyOutboundCallsInSource,
} from '../../src/parsers/outbound-call-parser.js';
import {
  parseServiceBindings,
} from '../../src/parsers/service-binding-parser.js';
import { trace } from '../../src/trace/trace-engine.js';
import type { OutboundCallFact } from '../../src/types.js';
import {
  prepareWorkspace,
  writeFixtureFile,
} from './test-workspace.js';

function source(text: string): ts.SourceFile {
  return ts.createSourceFile(
    'handler.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
}

function callByText(
  file: ts.SourceFile,
  text: string,
): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getText(file) === text) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`fixture_call_missing:${text}`);
  return found;
}

function parsedRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('fixture_evidence_not_object');
  return parsed as Record<string, unknown>;
}

function outboundFact(
  file: ts.SourceFile,
  callText: string,
  variableName: string,
): OutboundCallFact {
  const call = callByText(file, callText);
  return {
    callType: 'remote_action',
    serviceVariableName: variableName,
    operationPathExpr: '/refresh',
    sourceFile: 'handler.ts',
    sourceLine: file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
    callSiteStartOffset: call.getStart(file),
    callSiteEndOffset: call.getEnd(),
    confidence: 1,
    evidence: {},
  };
}

describe('release defects I/J/K', () => {
  it('links emit and subscribe templates only from exact supplied variables', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-event-var-'));
    await writeFixtureFile(root, 'events/.git-fixture');
    await writeFixtureFile(root, 'events/package.json', JSON.stringify({
      name: '@neutral/events', version: '1.0.0',
    }));
    await writeFixtureFile(root, 'events/srv/events.ts', `
import cds from '@sap/cds';
const messaging = await cds.connect.to('messaging');
function handle(): void {}
export async function run(
  emitKind: string,
  subscriptionKind: string,
): Promise<void> {
  messaging.on(\`Order.\${subscriptionKind}\`, handle);
  await messaging.emit(\`Order.\${emitKind}\`, {});
  await messaging.emit(emitKind, {});
  await messaging.emit('StaticEvent', {});
}
`);
    const { db, workspaceId } = await prepareWorkspace(root);

    linkWorkspace(db, workspaceId);
    const dynamic = db.prepare(`SELECT edge_type edgeType,to_kind toKind,
      to_id toId,evidence_json evidenceJson,generation
      FROM graph_edges WHERE edge_type='DYNAMIC_EDGE_CANDIDATE'
      ORDER BY id`).all();
    expect(dynamic).toHaveLength(3);
    const subscription = dynamic.find((row) =>
      row.toId === 'Event: Order.${subscriptionKind}');
    expect(subscription).toMatchObject({
      edgeType: 'DYNAMIC_EDGE_CANDIDATE',
      toKind: 'event_candidate',
      toId: 'Event: Order.${subscriptionKind}',
    });
    expect(JSON.parse(String(subscription?.evidenceJson))).toMatchObject({
      eventTemplateResolution: { missing: ['subscriptionKind'], supplied: [] },
    });

    const emitted = dynamic.find((row) =>
      row.toId === 'Event: Order.${emitKind}');
    if (!emitted) throw new Error('dynamic_emit_edge_missing');
    const emittedEvidence = parsedRecord(String(emitted.evidenceJson));
    const runtimeEmit = runtimeEventResolution({
      id: 1,
      edge_type: String(emitted.edgeType),
      from_id: '1',
      to_kind: String(emitted.toKind),
      to_id: String(emitted.toId),
      confidence: 0.6,
      evidence_json: String(emitted.evidenceJson),
      status: 'dynamic',
    }, { ...emittedEvidence, callType: 'async_emit' }, {
      emitKind: 'Created',
    });
    expect(runtimeEmit?.row).toMatchObject({
      edge_type: 'HANDLER_EMITS_EVENT',
      to_kind: 'event',
      to_id: 'Order.Created',
    });
    expect(eventSubscriberMissingVariables(db, {
      workspaceId,
      graphGeneration: Number(emitted.generation),
      eventName: 'Order.Created',
      vars: { emitKind: 'Created' },
    })).toEqual(['subscriptionKind']);
    const transitions = loadEventSubscriberTransitions(db, {
      workspaceId,
      graphGeneration: Number(emitted.generation),
      eventName: 'Order.Created',
      vars: { emitKind: 'Created', subscriptionKind: 'Created' },
    });
    expect(transitions[0]).toMatchObject({
      status: 'resolved',
      matchStrategy: 'workspace_exact_event_name_after_runtime_substitution',
      dispatchCertainty: 'runtime_variables_exact',
    });

    const unresolvedTrace = trace(
      db, { repo: 'events' },
      { depth: 8, workspaceId, includeAsync: true },
    );
    const unresolvedDiagnostic = unresolvedTrace.diagnostics.find((item) =>
      item.code === 'trace_runtime_variables_missing');
    expect(unresolvedDiagnostic?.missingVariables).toEqual(
      expect.arrayContaining(['emitKind']),
    );
    expect(unresolvedTrace.edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler')).toBe(false);

    const emitOnlyTrace = trace(
      db, { repo: 'events' },
      {
        depth: 8, workspaceId, includeAsync: true,
        vars: { emitKind: 'Created' },
      },
    );
    expect(emitOnlyTrace.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'trace_runtime_variables_missing',
        missingVariables: ['subscriptionKind'],
      }),
    ]));
    expect(emitOnlyTrace.edges.some((edge) =>
      edge.type === 'event_name_matches_subscription_handler')).toBe(false);

    const resolvedTrace = trace(
      db, { repo: 'events' },
      {
        depth: 8, workspaceId, includeAsync: true,
        vars: { emitKind: 'Created', subscriptionKind: 'Created' },
      },
    );
    const bridge = resolvedTrace.edges.find((edge) =>
      edge.type === 'event_name_matches_subscription_handler');
    expect(bridge?.from).toBe('Order.Created');
    expect(bridge?.evidence).toMatchObject({
      matchStrategy:
        'workspace_exact_event_name_after_runtime_substitution',
    });

    linkWorkspace(db, workspaceId, {
      emitKind: 'Created', subscriptionKind: 'Created',
    });
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='DYNAMIC_EDGE_CANDIDATE'`).get()).toMatchObject({
      count: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='HANDLER_EMITS_EVENT' AND to_kind='event'
        AND to_id='Order.Created'`).get()).toMatchObject({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
        AND from_kind='event' AND from_id='Order.Created'`).get())
      .toMatchObject({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
      WHERE edge_type='HANDLER_EMITS_EVENT' AND to_kind='event'
        AND to_id='StaticEvent'`).get()).toMatchObject({ count: 1 });
    db.close();
  });

  it('retains dynamic event parser diagnostics without guessing', () => {
    const file = source(`
declare const messaging: { emit(name: unknown): void };
declare const kind: string;
messaging.emit(\`Order.\${kind}\`);
messaging.emit(selectEvent());
`);
    const facts = classifyOutboundCallsInSource(file, 'handler.ts')
      .map((item) => item.fact);

    expect(facts[0]).toMatchObject({
      eventNameExpr: 'Order.${kind}',
      confidence: 0.6,
      unresolvedReason: 'dynamic_event_name_identifier',
      evidence: {
        eventNameStatus: 'dynamic',
        eventNameSourceKind: 'template_with_substitutions',
        eventNamePlaceholderKeys: ['kind'],
      },
    });
    expect(facts[1]).toMatchObject({
      eventNameExpr: 'selectEvent()',
      confidence: 0.3,
      unresolvedReason: 'dynamic_event_name_unsupported_expression',
    });
  });

  it('recognizes structural cds.run and marks direct and wrapped locks', () => {
    const file = source(`
async function run(): Promise<void> {
  await cds /* trivia */ . run(SELECT.from(Orders).forUpdate());
  await SELECT.from(DirectOrders).forUpdate();
  await cds.run(SELECT.from(UnlockedOrders));
}
`);
    const facts = classifyOutboundCallsInSource(file, 'handler.ts')
      .map((item) => item.fact);

    expect(facts).toHaveLength(3);
    expect(facts[0]?.evidence).toMatchObject({
      queryDispatch: 'cds_run_wrapper',
      hasForUpdate: true,
    });
    expect(facts[1]?.evidence).toMatchObject({
      queryDispatch: 'direct_query_builder',
      hasForUpdate: true,
    });
    expect(facts[2]?.evidence).not.toHaveProperty('hasForUpdate');
  });

  it('accepts a swallowing catch but rejects catch/finally return or connect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-helper-try-'));
    await writeFixtureFile(root, 'helper.ts', `
import cds from '@sap/cds';
export async function safe() {
  const cdsLog = cds.log('safe');
  try {
    const resolvedService = await cds.connect.to('SafeService');
    return resolvedService;
  }
  catch (error) { cdsLog.error(error); }
}
export async function catchReturn() {
  try { return await cds.connect.to('CatchReturn'); }
  catch { return fallback; }
}
export async function catchConnect() {
  try { return await cds.connect.to('CatchConnect'); }
  catch { await cds.connect.to('Fallback'); }
}
export async function finallyConnect() {
  try { return await cds.connect.to('FinallyConnect'); }
  finally { await cds.connect.to('Audit'); }
}
export async function branching(flag: boolean) {
  if (flag) return await cds.connect.to('BranchA');
  return await cds.connect.to('BranchB');
}
async function directSource() {
  return await cds.connect.to('DirectSource');
}
export async function twoHop() {
  try { return await directSource(); }
  catch (error) { logger.error(error); }
}
`);
    const handlerText = `
import {
  safe, catchReturn, catchConnect, finallyConnect, branching, twoHop,
} from './helper.js';
async function run(): Promise<void> {
  const safeClient = await safe();
  const rejectedReturn = await catchReturn();
  const rejectedCatchConnect = await catchConnect();
  const rejectedFinallyConnect = await finallyConnect();
  const rejectedBranch = await branching(true);
  const rejectedTwoHop = await twoHop();
  await safeClient.send('refresh');
  await rejectedReturn.send('refresh');
  await rejectedCatchConnect.send('refresh');
  await rejectedFinallyConnect.send('refresh');
  await rejectedBranch.send('refresh');
  await rejectedTwoHop.send('refresh');
}
`;
    await writeFixtureFile(root, 'handler.ts', handlerText);
    const bindings = await parseServiceBindings(root, 'handler.ts');
    expect(bindings.map((binding) => binding.variableName))
      .toEqual(['safeClient']);
    for (const binding of bindings)
      expect(binding.helperChain).toEqual(expect.arrayContaining([
        expect.objectContaining({
          bindingOrigin: 'single_hop_helper_return',
        }),
      ]));

    const file = source(handlerText);
    const facts = [
      outboundFact(file, "safeClient.send('refresh')", 'safeClient'),
      outboundFact(file, "rejectedReturn.send('refresh')", 'rejectedReturn'),
      outboundFact(
        file, "rejectedCatchConnect.send('refresh')",
        'rejectedCatchConnect',
      ),
      outboundFact(
        file, "rejectedFinallyConnect.send('refresh')",
        'rejectedFinallyConnect',
      ),
      outboundFact(file, "rejectedBranch.send('refresh')", 'rejectedBranch'),
      outboundFact(file, "rejectedTwoHop.send('refresh')", 'rejectedTwoHop'),
    ];
    const reconciled = reconcileBindingAndCallIdentity(
      file, bindings, facts, [],
    );
    expect(reconciled.calls.find((call) =>
      call.serviceVariableName === 'safeClient')?.serviceBindingReference)
      .toMatchObject({
        status: 'resolved_exact',
        resolutionStrategy: 'single_hop_helper_return',
      });
    for (const variableName of [
      'rejectedReturn', 'rejectedCatchConnect', 'rejectedFinallyConnect',
      'rejectedBranch', 'rejectedTwoHop',
    ]) {
      expect(reconciled.calls.find((call) =>
        call.serviceVariableName === variableName)?.serviceBindingReference)
        .toMatchObject({
          status: 'unresolved',
          reason: 'binding_flow_unsupported',
        });
    }
  });
});
