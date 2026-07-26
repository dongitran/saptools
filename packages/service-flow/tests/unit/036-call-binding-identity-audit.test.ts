import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  factLifecycleDiagnostic,
  type FactLifecycleDiagnostic,
} from '../../src/db/001-fact-lifecycle.js';
import type { Db } from '../../src/db/connection.js';
import { linkWorkspace } from '../../src/linker/cross-repo-linker.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

const sourceFile = 'src/register.ts';
const source = `
function createdHandler(): void {}
function rejectedHandler(): void {}
function guard<T>(handler: T): T { return handler; }
function ordinaryTarget(): void {}
function ordinaryCaller(): void { ordinaryTarget(); }
export async function register(): Promise<void> {
  const customBus = await cds.connect.messaging();
  customBus.on('Created', createdHandler); customBus.on('Rejected', rejectedHandler); customBus.on('Repeated', createdHandler); customBus.on('Repeated', rejectedHandler); customBus.on('Wrapped', guard(createdHandler));
}
export async function reassignInBlock(): Promise<void> {
  let remote = await cds.connect.to('base-service');
  {
    remote = await cds.connect.to('updated-service');
    remote.send({ method: 'POST', path: '/updated' });
  }
}
`;

interface RegistrationRow {
  eventName: string;
  sourceLine: number;
  sourceOwnerId: number;
  callerOwnerId: number;
  ownerKind: string;
  ownerQualifiedName: string;
  callStart: number;
  callEnd: number;
  ownerStart: number;
  ownerEnd: number;
  bindingId: number;
  bindingStatus: string;
  bindingOwnerResolution: string;
  bindingIdentityMatches: number;
}

function registrationRow(row: Record<string, unknown>): RegistrationRow {
  return {
    eventName: String(row.eventName),
    sourceLine: Number(row.sourceLine),
    sourceOwnerId: Number(row.sourceOwnerId),
    callerOwnerId: Number(row.callerOwnerId),
    ownerKind: String(row.ownerKind),
    ownerQualifiedName: String(row.ownerQualifiedName),
    callStart: Number(row.callStart),
    callEnd: Number(row.callEnd),
    ownerStart: Number(row.ownerStart),
    ownerEnd: Number(row.ownerEnd),
    bindingId: Number(row.bindingId),
    bindingStatus: String(row.bindingStatus),
    bindingOwnerResolution: String(row.bindingOwnerResolution),
    bindingIdentityMatches: Number(row.bindingIdentityMatches),
  };
}

async function fixture(): Promise<{
  db: Db;
  workspaceId: number;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-call-identity-'));
  await writeFixtureFile(root, 'neutral/.git-fixture');
  await writeFixtureFile(root, 'neutral/package.json', JSON.stringify({
    name: '@neutral/call-identity',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, `neutral/${sourceFile}`, source);
  return prepareWorkspace(root);
}

function registrationRows(db: Db): RegistrationRow[] {
  const rows = db.prepare(`SELECT outbound.event_name_expr eventName,
    outbound.source_line sourceLine,outbound.source_symbol_id sourceOwnerId,
    handler.caller_symbol_id callerOwnerId,
    owner.kind ownerKind,owner.qualified_name ownerQualifiedName,
    outbound.call_site_start_offset callStart,
    outbound.call_site_end_offset callEnd,
    owner.start_offset ownerStart,owner.end_offset ownerEnd,
    outbound.service_binding_id bindingId,
    json_extract(outbound.evidence_json,
      '$.serviceBindingReference.status') bindingStatus,
    binding.owner_resolution bindingOwnerResolution,
    CASE WHEN binding.source_file=json_extract(outbound.evidence_json,
      '$.serviceBindingReference.bindingSourceFile')
      AND binding.variable_name=json_extract(outbound.evidence_json,
        '$.serviceBindingReference.variableName')
      AND binding.binding_site_start_offset=json_extract(
        outbound.evidence_json,
        '$.serviceBindingReference.bindingSiteStartOffset')
      AND binding.binding_site_end_offset=json_extract(
        outbound.evidence_json,
        '$.serviceBindingReference.bindingSiteEndOffset')
      THEN 1 ELSE 0 END bindingIdentityMatches
    FROM outbound_calls outbound
    JOIN symbol_calls handler
      ON handler.repo_id=outbound.repo_id
      AND handler.source_file=outbound.source_file
      AND handler.call_site_start_offset=outbound.call_site_start_offset
      AND handler.call_site_end_offset=outbound.call_site_end_offset
      AND handler.call_role='event_subscribe_handler'
    JOIN symbols owner ON owner.id=outbound.source_symbol_id
    JOIN service_bindings binding ON binding.id=outbound.service_binding_id
    WHERE outbound.call_type='async_subscribe'
    ORDER BY outbound.call_site_start_offset`).all();
  return rows.map(registrationRow);
}

function categories(
  diagnostic: FactLifecycleDiagnostic | undefined,
): string[] {
  const values: unknown = diagnostic?.invalidFactCategories;
  if (!Array.isArray(values)) return [];
  return (values as unknown[]).flatMap((value): string[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return [];
    const category = (value as Record<string, unknown>).category;
    return typeof category === 'string'
      ? [category]
      : [];
  });
}

function duplicateOrdinaryCall(db: Db): void {
  db.prepare(`INSERT INTO symbol_calls(
    repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    import_source,source_file,source_line,
    call_site_start_offset,call_site_end_offset,call_role,status,
    confidence,evidence_json,unresolved_reason
  )
  SELECT repo_id,caller_symbol_id,callee_symbol_id,callee_expression,
    import_source,source_file,source_line,
    call_site_start_offset,call_site_end_offset,call_role,status,
    confidence,evidence_json,unresolved_reason
  FROM symbol_calls WHERE call_role='ordinary_call' LIMIT 1`).run();
}

function graphSnapshot(db: Db): string {
  return JSON.stringify(db.prepare(
    'SELECT * FROM graph_edges ORDER BY id',
  ).all());
}

function wrappedOrdinaryOwner(db: Db): {
  ownerId: number;
  callStart: number;
  callEnd: number;
} {
  const row = db.prepare(`SELECT caller_symbol_id ownerId,
    call_site_start_offset callStart,call_site_end_offset callEnd
    FROM symbol_calls WHERE call_role='ordinary_call'
      AND callee_expression='guard'`).get();
  return {
    ownerId: Number(row?.ownerId),
    callStart: Number(row?.callStart),
    callEnd: Number(row?.callEnd),
  };
}

function reassignedBinding(db: Db): {
  alias: string;
  strategy: string;
  scopeIndex: number;
  scopeTotal: number;
} {
  const row = db.prepare(`SELECT binding.alias,
    json_extract(call.evidence_json,
      '$.serviceBindingReference.resolutionStrategy') strategy,
    json_extract(call.evidence_json,
      '$.serviceBindingReference.bindingScopeIndex') scopeIndex,
    json_extract(call.evidence_json,
      '$.serviceBindingReference.scopeChainTotal') scopeTotal
    FROM outbound_calls call
    JOIN service_bindings binding ON binding.id=call.service_binding_id
    WHERE call.operation_path_expr='/updated'`).get();
  return {
    alias: String(row?.alias),
    strategy: String(row?.strategy),
    scopeIndex: Number(row?.scopeIndex),
    scopeTotal: Number(row?.scopeTotal),
  };
}

function exactRegistration(row: RegistrationRow): boolean {
  return [
    row.sourceOwnerId === row.callerOwnerId,
    row.ownerKind === 'event_registration',
    row.callStart === row.ownerStart,
    row.callEnd === row.ownerEnd,
    row.bindingId > 0,
    row.bindingStatus === 'resolved_exact',
    row.bindingOwnerResolution === 'owned_exact',
    row.bindingIdentityMatches === 1,
  ].every(Boolean);
}

function expectRegistrationIdentity(rows: RegistrationRow[]): void {
  expect(rows).toHaveLength(5);
  expect(new Set(rows.map((row) => row.sourceLine)).size).toBe(1);
  expect(new Set(rows.map((row) => row.sourceOwnerId)).size).toBe(5);
  expect(rows.every(exactRegistration)).toBe(true);
  expect(new Set(rows.map((row) => row.bindingId)).size).toBe(1);
  const repeated = rows.filter((row) => row.eventName === 'Repeated');
  expect(repeated).toHaveLength(2);
  expect(repeated[0]?.ownerQualifiedName)
    .toBe(repeated[1]?.ownerQualifiedName);
  expect(repeated[0]?.sourceOwnerId).not.toBe(repeated[1]?.sourceOwnerId);
}

function expectWrappedOwner(db: Db, rows: RegistrationRow[]): void {
  const wrapped = rows.find((row) => row.eventName === 'Wrapped');
  const wrapper = wrappedOrdinaryOwner(db);
  expect(wrapper.ownerId).toBe(wrapped?.sourceOwnerId);
  expect(wrapper.callStart).toBeGreaterThan(wrapped?.callStart ?? 0);
  expect(wrapper.callEnd).toBeLessThan(wrapped?.callEnd ?? 0);
}

function expectReachingAssignment(db: Db): void {
  expect(reassignedBinding(db)).toEqual({
    alias: 'updated-service',
    strategy: 'deterministic_reaching_assignment',
    scopeIndex: 2,
    scopeTotal: 4,
  });
}

describe('exact call and binding identity audit', () => {
  it('persists distinct exact owners for same-line custom subscriptions', async () => {
    const { db, workspaceId } = await fixture();
    try {
      const rows = registrationRows(db);
      expectRegistrationIdentity(rows);
      expectWrappedOwner(db, rows);
      expectReachingAssignment(db);
      expect(factLifecycleDiagnostic(db, workspaceId)).toBeUndefined();
      linkWorkspace(db, workspaceId);
      expect(db.prepare(`SELECT COUNT(*) count FROM graph_edges
        WHERE edge_type='EVENT_SUBSCRIPTION_HANDLED_BY'
          AND status='resolved'`).get()?.count).toBe(5);
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate ordinary semantic call before graph mutation', async () => {
    const { db, workspaceId } = await fixture();
    try {
      linkWorkspace(db, workspaceId);
      const before = graphSnapshot(db);
      duplicateOrdinaryCall(db);
      const diagnostic = factLifecycleDiagnostic(db, workspaceId);
      expect(diagnostic).toMatchObject({ code: 'reindex_required' });
      expect(categories(diagnostic)).toContain('symbol_call_site_duplicate');
      expect(() => linkWorkspace(db, workspaceId)).toThrow(/reindex_required/);
      expect(graphSnapshot(db)).toBe(before);
    } finally {
      db.close();
    }
  });
});
