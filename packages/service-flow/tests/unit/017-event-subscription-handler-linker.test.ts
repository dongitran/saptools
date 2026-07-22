import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { linkEventSubscriptionHandlers } from '../../src/linker/004-event-subscription-handler-linker.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { factLifecycleDiagnostic } from '../../src/db/001-fact-lifecycle.js';
import { ANALYZER_VERSION } from '../../src/version.js';
import { doctorDiagnostics, linkUpgradeWarnings } from '../../src/cli/doctor.js';

interface CallSpan {
  start: number | null;
  end: number | null;
}

interface SubscriptionInput {
  eventName: string;
  callerSymbolId?: number;
  sourceFile?: string;
  sourceLine?: number;
  span: CallSpan;
}

interface SymbolCallInput {
  callerSymbolId: number;
  calleeSymbolId?: number;
  expression?: string;
  sourceFile?: string;
  sourceLine?: number;
  span: CallSpan;
  role?: 'ordinary_call' | 'event_subscribe_handler' | 'legacy_unknown';
  status?: 'resolved' | 'ambiguous' | 'unresolved';
  importSource?: string;
  evidence?: Record<string, unknown>;
  unresolvedReason?: string;
}

interface EventEdge {
  workspaceId: number;
  status: string;
  fromId: string;
  toKind: string;
  toId: string;
  reason: string | null;
  evidence: Record<string, unknown>;
}

async function temporaryDatabase(label: string): Promise<Db> {
  const root = await mkdtemp(path.join(os.tmpdir(), `service-flow-${label}-`));
  return openDatabase(path.join(root, 'graph.db'));
}

function insertedId(row: Record<string, unknown> | undefined, subject: string): number {
  if (typeof row?.id !== 'number') throw new Error(`Missing inserted ${subject} id`);
  return row.id;
}

function insertWorkspace(db: Db, name: string): number {
  const now = new Date(0).toISOString();
  return insertedId(db.prepare(`INSERT INTO workspaces(
    root_path,db_path,created_at,updated_at
  ) VALUES(?,?,?,?) RETURNING id`).get(
    `/workspace/${name}`, `/workspace/${name}/graph.db`, now, now,
  ), 'workspace');
}

function insertRepository(
  db: Db,
  workspaceId: number,
  name: string,
  packageName = `@neutral/${name}`,
  analyzerVersion = ANALYZER_VERSION,
): number {
  return insertedId(db.prepare(`INSERT INTO repositories(
    workspace_id,name,absolute_path,relative_path,package_name,dependencies_json,
    kind,is_git_repo,index_status,fact_analyzer_version,graph_stale_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    workspaceId, name, `/workspace/${name}`, name, packageName, '{}',
    'helper-package', 1, 'indexed', analyzerVersion, 'facts_changed',
  ), 'repository');
}

function insertSymbol(
  db: Db,
  repoId: number,
  name: string,
  sourceFile = 'src/events.ts',
  exported = false,
): number {
  return insertedId(db.prepare(`INSERT INTO symbols(
    repo_id,kind,name,qualified_name,exported,start_line,end_line,
    start_offset,end_offset,source_file,exported_name,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, 'function', name, name, exported ? 1 : 0, 1, 100,
    0, 10_000, sourceFile, exported ? name : null, '{}',
  ), 'symbol');
}

function insertSubscription(db: Db, repoId: number, input: SubscriptionInput): number {
  return insertedId(db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,event_name_expr,source_file,source_line,
    call_site_start_offset,call_site_end_offset,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, input.callerSymbolId, 'async_subscribe', input.eventName,
    input.sourceFile ?? 'src/events.ts', input.sourceLine ?? 1,
    input.span.start, input.span.end, 0.8, '{}',
  ), 'subscription');
}

function insertEmission(
  db: Db,
  repoId: number,
  callerSymbolId: number,
  eventName: string,
  start: number,
): number {
  return insertedId(db.prepare(`INSERT INTO outbound_calls(
    repo_id,source_symbol_id,call_type,event_name_expr,source_file,source_line,
    call_site_start_offset,call_site_end_offset,confidence,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, callerSymbolId, 'async_emit', eventName, 'src/emitter.ts', 1,
    start, start + 10, 0.8, '{}',
  ), 'emission');
}

function insertSymbolCall(db: Db, repoId: number, input: SymbolCallInput): number {
  const status = input.status ?? 'resolved';
  const evidence = input.evidence ?? {
    relation: 'indexed_local_symbol',
    targetName: input.expression ?? 'handler',
    factOrigin: input.role === 'ordinary_call'
      ? undefined
      : 'event_subscribe_handler_reference',
    candidateStrategy: status === 'resolved' ? 'same_file_exact' : 'exact_symbol_match',
    candidateCount: status === 'resolved' ? 1 : 0,
  };
  return insertedId(db.prepare(`INSERT INTO symbol_calls(
    repo_id,caller_symbol_id,callee_symbol_id,callee_expression,import_source,
    source_file,source_line,call_site_start_offset,call_site_end_offset,
    call_role,status,confidence,evidence_json,unresolved_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    repoId, input.callerSymbolId, input.calleeSymbolId,
    input.expression ?? 'handler', input.importSource,
    input.sourceFile ?? 'src/events.ts', input.sourceLine ?? 1,
    input.span.start, input.span.end,
    input.role ?? 'event_subscribe_handler', status, 0.8,
    JSON.stringify(evidence), status === 'resolved'
      ? null : input.unresolvedReason ?? `${status}_fixture`,
  ), 'symbol call');
}

function objectJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function eventEdges(db: Db, workspaceId?: number): EventEdge[] {
  return db.prepare(`SELECT workspace_id workspaceId,status,from_id fromId,
    to_kind toKind,to_id toId,unresolved_reason reason,evidence_json evidenceJson
    FROM graph_edges WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
      AND (? IS NULL OR workspace_id=?)
    ORDER BY workspace_id,from_id COLLATE BINARY,to_kind,to_id,id`).all(
    workspaceId, workspaceId,
  ).map((row) => ({
    workspaceId: Number(row.workspaceId),
    status: String(row.status),
    fromId: String(row.fromId),
    toKind: String(row.toKind),
    toId: String(row.toId),
    reason: typeof row.reason === 'string' ? row.reason : null,
    evidence: objectJson(row.evidenceJson),
  }));
}

function reasonByEvent(edges: EventEdge[], eventName: string): string | null {
  const edge = edges.find((candidate) => candidate.fromId === eventName);
  if (!edge) throw new Error(`Missing event edge ${eventName}`);
  return edge.reason;
}

describe('event subscription handler linker', () => {
  it('links exact full spans without emitter cartesian products and preserves fan-out provenance', async () => {
    const db = await temporaryDatabase('event-linker-exact');
    try {
      const workspaceId = insertWorkspace(db, 'one');
      const repoId = insertRepository(db, workspaceId, 'events-one');
      const caller = insertSymbol(db, repoId, 'register');
      const firstTarget = insertSymbol(db, repoId, 'firstHandler');
      const secondTarget = insertSymbol(db, repoId, 'secondHandler');
      const spans = [
        { start: 10, end: 30 }, { start: 31, end: 50 },
        { start: 51, end: 70 }, { start: 71, end: 90 },
      ];
      const names = ['OrderExact', 'OrderExact', 'OrderExact', 'Orderexact'];
      const targets = [firstTarget, secondTarget, firstTarget, secondTarget];
      const subscriptionIds = spans.map((span, index) => insertSubscription(db, repoId, {
        eventName: names[index] ?? '', callerSymbolId: caller, sourceLine: 8, span,
      }));
      spans.forEach((span, index) => insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: targets[index],
        expression: index % 2 === 0 ? 'firstHandler' : 'secondHandler',
        sourceLine: 8, span,
      }));
      insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: firstTarget,
        expression: 'guard', sourceLine: 8, span: spans[0] ?? { start: 0, end: 1 },
        role: 'ordinary_call',
      });
      for (const start of [200, 220, 240, 260])
        insertEmission(db, repoId, caller, 'OrderExact', start);

      const otherWorkspace = insertWorkspace(db, 'two');
      const otherRepo = insertRepository(db, otherWorkspace, 'events-two');
      const otherCaller = insertSymbol(db, otherRepo, 'register');
      const otherTarget = insertSymbol(db, otherRepo, 'otherHandler');
      const otherSpan = { start: 10, end: 30 };
      insertSubscription(db, otherRepo, {
        eventName: 'OrderExact', callerSymbolId: otherCaller, span: otherSpan,
      });
      insertSymbolCall(db, otherRepo, {
        callerSymbolId: otherCaller, calleeSymbolId: otherTarget, span: otherSpan,
      });

      const summary = linkEventSubscriptionHandlers(db, workspaceId, 7);
      const edges = eventEdges(db, workspaceId);
      expect(summary).toEqual({
        edgeCount: 4, resolvedCount: 4, ambiguousCount: 0,
        unresolvedCount: 0, missingAssociationCount: 0,
      });
      expect(edges).toHaveLength(4);
      expect(edges.filter((edge) => edge.fromId === 'OrderExact')).toHaveLength(3);
      expect(edges.filter((edge) => edge.fromId === 'Orderexact')).toHaveLength(1);
      expect(edges.filter((edge) => edge.toId === String(firstTarget))).toHaveLength(2);
      expect(new Set(edges.map((edge) => edge.evidence.subscribeCallId)))
        .toEqual(new Set(subscriptionIds));
      expect(edges.every((edge) => edge.evidence.roleSiteMatchCount === 1
        && edge.evidence.associationBasis === 'exact_subscription_call_span')).toBe(true);
      expect(eventEdges(db, otherWorkspace)).toEqual([]);

      const otherSummary = linkEventSubscriptionHandlers(db, otherWorkspace, 9);
      expect(otherSummary.edgeCount).toBe(1);
      expect(eventEdges(db, otherWorkspace)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('fails closed on incomplete or mismatched site invariants and requires the full span', async () => {
    const db = await temporaryDatabase('event-linker-invariants');
    try {
      const workspaceId = insertWorkspace(db, 'invariants');
      const repoId = insertRepository(db, workspaceId, 'invariant-events');
      const caller = insertSymbol(db, repoId, 'register');
      const otherCaller = insertSymbol(db, repoId, 'registerElsewhere');
      const target = insertSymbol(db, repoId, 'handler');

      insertSubscription(db, repoId, {
        eventName: 'NullSpan', callerSymbolId: caller, span: { start: null, end: null },
      });
      insertSubscription(db, repoId, {
        eventName: 'StartCollision', callerSymbolId: caller, span: { start: 100, end: 130 },
      });
      insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: target, span: { start: 100, end: 140 },
      });
      insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: target, span: { start: 100, end: 130 },
        role: 'ordinary_call',
      });
      insertSubscription(db, repoId, {
        eventName: 'LineMismatch', callerSymbolId: caller,
        sourceLine: 20, span: { start: 200, end: 230 },
      });
      insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: target,
        sourceLine: 21, span: { start: 200, end: 230 },
      });
      insertSubscription(db, repoId, {
        eventName: 'CallerMismatch', callerSymbolId: caller,
        sourceLine: 30, span: { start: 300, end: 330 },
      });
      insertSymbolCall(db, repoId, {
        callerSymbolId: otherCaller, calleeSymbolId: target,
        sourceLine: 30, span: { start: 300, end: 330 },
      });
      insertSubscription(db, repoId, {
        eventName: 'MultipleMatches', callerSymbolId: caller,
        sourceLine: 40, span: { start: 400, end: 430 },
      });
      for (const [expression, factOrigin] of [
        ['handler', 'event_subscribe_handler_reference'],
        ['handlerAlias', 'alternate_fixture_origin'],
      ] as const) insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: target, expression,
        sourceLine: 40, span: { start: 400, end: 430 },
        evidence: {
          relation: 'indexed_local_symbol', targetName: expression, factOrigin,
          candidateStrategy: 'same_file_exact', candidateCount: 1,
        },
      });

      const summary = linkEventSubscriptionHandlers(db, workspaceId, 1);
      const edges = eventEdges(db, workspaceId);
      expect(summary).toEqual({
        edgeCount: 5, resolvedCount: 0, ambiguousCount: 1,
        unresolvedCount: 4, missingAssociationCount: 4,
      });
      expect(reasonByEvent(edges, 'NullSpan')).toBe('subscription_call_span_missing');
      expect(reasonByEvent(edges, 'StartCollision'))
        .toBe('subscription_handler_role_site_missing');
      expect(reasonByEvent(edges, 'LineMismatch'))
        .toBe('subscription_handler_source_line_mismatch');
      expect(reasonByEvent(edges, 'CallerMismatch'))
        .toBe('subscription_handler_caller_mismatch');
      expect(reasonByEvent(edges, 'MultipleMatches'))
        .toBe('multiple_handler_role_site_matches');
      expect(edges.find((edge) => edge.fromId === 'MultipleMatches')).toMatchObject({
        status: 'ambiguous', toKind: 'subscription_handler',
        evidence: {
          callRole: 'event_subscribe_handler', factOrigin: 'mixed',
          associationStatus: 'ambiguous', symbolCallResolutionStatus: 'resolved',
        },
      });
      expect(edges.find((edge) => edge.fromId === 'LineMismatch')).toMatchObject({
        status: 'unresolved',
        evidence: {
          callRole: 'event_subscribe_handler',
          factOrigin: 'event_subscribe_handler_reference',
          associationStatus: 'unresolved', symbolCallResolutionStatus: 'resolved',
        },
      });
    } finally {
      db.close();
    }
  });

  it('persists non-traversable references for unresolved, ambiguous, invalid, and cross-workspace targets', async () => {
    const db = await temporaryDatabase('event-linker-status');
    try {
      const workspaceId = insertWorkspace(db, 'status-one');
      const repoId = insertRepository(db, workspaceId, 'status-events');
      const caller = insertSymbol(db, repoId, 'register');
      const otherWorkspace = insertWorkspace(db, 'status-two');
      const otherRepo = insertRepository(db, otherWorkspace, 'foreign-events');
      const foreignTarget = insertSymbol(db, otherRepo, 'foreignHandler');
      const longReason = `fixture:${'x'.repeat(600)}`;
      const cases = [
        ['UnresolvedRef', 10, 'unresolved', undefined, longReason],
        ['AmbiguousRef', 30, 'ambiguous', undefined],
        ['ResolvedWithoutTarget', 50, 'resolved', undefined],
        ['ForeignTarget', 70, 'resolved', foreignTarget],
      ] as const;
      for (const [eventName, start, status, calleeSymbolId, unresolvedReason] of cases) {
        const span = { start, end: start + 10 };
        insertSubscription(db, repoId, { eventName, callerSymbolId: caller, span });
        insertSymbolCall(db, repoId, {
          callerSymbolId: caller, calleeSymbolId, expression: `${eventName}Handler`,
          span, status, unresolvedReason,
        });
      }

      const summary = linkEventSubscriptionHandlers(db, workspaceId, 2);
      const edges = eventEdges(db, workspaceId);
      expect(summary).toEqual({
        edgeCount: 4, resolvedCount: 0, ambiguousCount: 1,
        unresolvedCount: 3, missingAssociationCount: 1,
      });
      expect(reasonByEvent(edges, 'UnresolvedRef'))
        .toBe('subscription_handler_reference_unresolved');
      expect(reasonByEvent(edges, 'AmbiguousRef'))
        .toBe('subscription_handler_reference_ambiguous');
      expect(reasonByEvent(edges, 'ResolvedWithoutTarget'))
        .toBe('resolved_handler_symbol_missing');
      expect(reasonByEvent(edges, 'ForeignTarget'))
        .toBe('subscription_handler_target_workspace_mismatch');
      const unresolvedEvidence = edges.find(
        (edge) => edge.fromId === 'UnresolvedRef',
      )?.evidence;
      expect(unresolvedEvidence).toMatchObject({
        reasonCode: 'subscription_handler_reference_unresolved',
        symbolCallUnresolvedReason: longReason.slice(0, 512),
        omittedSymbolCallUnresolvedReasonCharacterCount: longReason.length - 512,
      });
      expect(edges.filter((edge) => edge.toKind === 'symbol_reference')).toHaveLength(3);
      expect(edges.find((edge) => edge.fromId === 'ForeignTarget')?.toKind)
        .toBe('subscription_handler');
    } finally {
      db.close();
    }
  });

  it('resolves package handlers before association and force-links without duplicate edges', async () => {
    const db = await temporaryDatabase('event-linker-package');
    try {
      const workspaceId = insertWorkspace(db, 'package-order');
      const appRepo = insertRepository(db, workspaceId, 'event-app', '@neutral/event-app');
      const packageRepo = insertRepository(
        db, workspaceId, 'event-handlers', '@neutral/event-handlers',
      );
      const caller = insertSymbol(db, appRepo, 'register');
      const target = insertSymbol(
        db, packageRepo, 'packageHandler', 'src/package-handler.ts', true,
      );
      const span = { start: 20, end: 60 };
      const subscribeCallId = insertSubscription(db, appRepo, {
        eventName: 'PackageEvent', callerSymbolId: caller, span,
      });
      const symbolCallId = insertSymbolCall(db, appRepo, {
        callerSymbolId: caller, expression: 'packageHandler', span,
        status: 'unresolved', importSource: '@neutral/event-handlers',
        evidence: {
          relation: 'package_import', targetName: 'packageHandler',
          factOrigin: 'event_subscribe_handler_reference',
          candidateStrategy: 'package_import_unresolved', candidateCount: 0,
        },
      });

      const first = linkWorkspace(db, workspaceId);
      const firstEdges = eventEdges(db, workspaceId);
      const persistedCall = db.prepare(`SELECT status,callee_symbol_id calleeSymbolId,
        call_role callRole,call_site_start_offset startOffset,
        call_site_end_offset endOffset,
        json_extract(evidence_json,'$.factOrigin') factOrigin,
        json_extract(evidence_json,'$.candidateStrategy') strategy
        FROM symbol_calls WHERE id=?`).get(symbolCallId);
      expect(persistedCall).toEqual({
        status: 'resolved', calleeSymbolId: target,
        callRole: 'event_subscribe_handler', startOffset: span.start, endOffset: span.end,
        factOrigin: 'event_subscribe_handler_reference',
        strategy: 'package_import_workspace_resolved',
      });
      expect(first).toMatchObject({
        edgeCount: 2, subscriptionHandlerResolvedCount: 1,
        subscriptionHandlerAmbiguousCount: 0,
        subscriptionHandlerUnresolvedCount: 0,
        subscriptionHandlerMissingAssociationCount: 0,
      });
      expect(first.edgeCount).toBe(Number(
        db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
          .get(workspaceId)?.count,
      ));
      expect(firstEdges).toHaveLength(1);
      expect(firstEdges[0]).toMatchObject({
        status: 'resolved', fromId: 'PackageEvent', toKind: 'symbol',
        toId: String(target),
      });
      expect(firstEdges[0]?.evidence).toMatchObject({
        subscribeCallId, symbolCallId, factOrigin: 'event_subscribe_handler_reference',
        resolutionStrategy: 'package_import_workspace_resolved',
      });

      const second = linkWorkspace(db, workspaceId);
      expect(second).toEqual(first);
      expect(eventEdges(db, workspaceId)).toHaveLength(1);
      expect(second.edgeCount).toBe(Number(
        db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
          .get(workspaceId)?.count,
      ));
      expect(db.prepare('SELECT graph_stale_reason reason FROM repositories WHERE id=?')
        .get(appRepo)?.reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses invalid current facts before deleting the prior graph and clears staleness only after repair', async () => {
    const db = await temporaryDatabase('event-linker-preflight');
    try {
      const workspaceId = insertWorkspace(db, 'preflight');
      const repoId = insertRepository(db, workspaceId, 'preflight-events');
      const caller = insertSymbol(db, repoId, 'caller');
      const target = insertSymbol(db, repoId, 'target');
      const legacyCall = insertSymbolCall(db, repoId, {
        callerSymbolId: caller, calleeSymbolId: target,
        span: { start: null, end: null }, role: 'legacy_unknown',
      });
      db.prepare(`INSERT INTO graph_edges(
        workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
        confidence,evidence_json,is_dynamic,generation
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, 'REPO_IMPORTS_HELPER_PACKAGE', 'resolved', 'repo',
        String(repoId), 'repo', String(repoId), 1, '{"sentinel":true}', 0, 9,
      );

      let firstError = '';
      try {
        linkWorkspace(db, workspaceId);
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toContain('reindex_required');
      expect(firstError).toContain('service-flow index --workspace /workspace --force');
      expect(firstError).toContain('service-flow link --workspace /workspace --force');
      expect(db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
        .get(workspaceId)?.count).toBe(1);
      expect(db.prepare('SELECT graph_stale_reason reason FROM repositories WHERE id=?')
        .get(repoId)?.reason).toBe('facts_changed');

      db.prepare(`UPDATE symbol_calls SET call_role='ordinary_call',
        call_site_start_offset=10,call_site_end_offset=20 WHERE id=?`).run(legacyCall);
      const emitId = insertEmission(db, repoId, caller, 'RepairEvent', 100);
      db.prepare(`UPDATE outbound_calls SET call_site_start_offset=NULL,
        call_site_end_offset=NULL WHERE id=?`).run(emitId);
      expect(() => linkWorkspace(db, workspaceId)).toThrow(/reindex_required/);
      expect(db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
        .get(workspaceId)?.count).toBe(1);

      db.prepare(`UPDATE outbound_calls SET call_site_start_offset=100,
        call_site_end_offset=110 WHERE id=?`).run(emitId);
      const linked = linkWorkspace(db, workspaceId);
      expect(linked.edgeCount).toBe(1);
      expect(db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
        .get(workspaceId)?.count).toBe(1);
      expect(db.prepare('SELECT edge_type edgeType FROM graph_edges WHERE workspace_id=?')
        .get(workspaceId)?.edgeType).toBe('HANDLER_EMITS_EVENT');
      expect(db.prepare('SELECT graph_stale_reason reason FROM repositories WHERE id=?')
        .get(repoId)?.reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it('checks every repository lifecycle state inside the link transaction before deletion', async () => {
    const db = await temporaryDatabase('event-linker-repository-lifecycle');
    try {
      const workspaceId = insertWorkspace(db, 'repository-lifecycle');
      const pendingRepo = insertRepository(db, workspaceId, 'pending-events');
      const failedRepo = insertRepository(db, workspaceId, 'failed-events');
      const missingAnalyzerRepo = insertRepository(
        db, workspaceId, 'missing-analyzer-events', '@neutral/missing-analyzer-events',
      );
      db.prepare("UPDATE repositories SET index_status='pending' WHERE id=?")
        .run(pendingRepo);
      db.prepare("UPDATE repositories SET index_status='failed' WHERE id=?")
        .run(failedRepo);
      db.prepare('UPDATE repositories SET fact_analyzer_version=NULL WHERE id=?')
        .run(missingAnalyzerRepo);
      db.prepare(`INSERT INTO graph_edges(
        workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,
        confidence,evidence_json,is_dynamic,generation
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        workspaceId, 'REPO_IMPORTS_HELPER_PACKAGE', 'resolved', 'repo',
        String(pendingRepo), 'repo', String(failedRepo), 1, '{"sentinel":true}', 0, 4,
      );

      let transactionActive = false;
      let lifecycleCheckedInTransaction = false;
      let graphDeletionPrepared = false;
      const observedDb: Db = {
        ...db,
        prepare: (sql) => {
          if (sql.includes('FROM repositories') && sql.includes('index_status'))
            lifecycleCheckedInTransaction = transactionActive;
          if (sql.includes('DELETE FROM graph_edges')) graphDeletionPrepared = true;
          return db.prepare(sql);
        },
        transaction: <T>(fn: () => T): T => db.transaction(() => {
          transactionActive = true;
          try {
            return fn();
          } finally {
            transactionActive = false;
          }
        }),
      };

      expect(factLifecycleDiagnostic(observedDb, workspaceId)).toMatchObject({
        code: 'reindex_required', staleRepositoryCount: 3,
      });
      lifecycleCheckedInTransaction = false;
      expect(() => linkWorkspace(observedDb, workspaceId)).toThrow(/reindex_required/);
      expect(lifecycleCheckedInTransaction).toBe(true);
      expect(graphDeletionPrepared).toBe(false);
      expect(db.prepare('SELECT COUNT(*) count FROM graph_edges WHERE workspace_id=?')
        .get(workspaceId)?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('scopes lifecycle doctor and link warnings to the selected workspace', async () => {
    const db = await temporaryDatabase('event-linker-doctor-workspace');
    try {
      const freshWorkspace = insertWorkspace(db, 'fresh-doctor');
      insertRepository(db, freshWorkspace, 'fresh-events');
      const staleWorkspace = insertWorkspace(db, 'stale-doctor');
      const staleRepo = insertRepository(db, staleWorkspace, 'stale-events');
      db.prepare(`UPDATE repositories SET index_status='pending',
        fact_analyzer_version=NULL WHERE id=?`).run(staleRepo);

      expect(linkUpgradeWarnings(db, freshWorkspace)).toEqual([]);
      expect(doctorDiagnostics(db, true, { workspaceId: freshWorkspace })
        .some((item) => item.code === 'reindex_required')).toBe(false);
      expect(linkUpgradeWarnings(db, staleWorkspace)).toEqual([
        expect.objectContaining({ code: 'reindex_required', staleRepositoryCount: 1 }),
      ]);
      expect(doctorDiagnostics(db, true, { workspaceId: staleWorkspace }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'reindex_required' }),
        ]));
    } finally {
      db.close();
    }
  });
});
