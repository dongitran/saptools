import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { linkWorkspace, parseOutboundCalls, trace } from '../../src/index.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type Row = Record<string, unknown>;

async function createBindingWorkspace(root: string): Promise<void> {
  await writeFixtureFile(root, 'gateway-app/.git-fixture');
  await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
    name: '@neutral/gateway-app',
    version: '1.0.0',
  }));
  await writeFixtureFile(root, 'gateway-app/srv/handler.ts', `
    import cds from '@sap/cds';

    export async function run(flag: boolean): Promise<void> {
      const directClient = await cds.connect.to('direct-service');
      await directClient.send({ method: 'POST', path: '/directCheck' });

      await futureClient.send({ method: 'POST', path: '/futureCheck' });
      const futureClient = await cds.connect.to('future-service');

      let selectedClient = await cds.connect.to('first-service');
      if (flag) selectedClient = await cds.connect.to('second-service');
      await selectedClient.send({ method: 'POST', path: '/ambiguousCheck' });
    }
  `);
}

describe('service binding persistence safety', () => {
  it('persists unique prior bindings but rejects future and ambiguous assignments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-binding-safety-'));
    await createBindingWorkspace(root);
    const { db, workspaceId } = await prepareWorkspace(root);
    const calls = db.prepare(`
      SELECT operation_path_expr operationPath,service_binding_id serviceBindingId,
        unresolved_reason unresolvedReason,evidence_json evidenceJson
      FROM outbound_calls ORDER BY source_line
    `).all() as Array<{
      operationPath?: string;
      serviceBindingId?: number | null;
      unresolvedReason?: string | null;
      evidenceJson?: string;
    }>;

    expect(calls.find((row) => row.operationPath === '/directCheck')?.serviceBindingId).toEqual(expect.any(Number));
    expect(calls.find((row) => row.operationPath === '/futureCheck')).toMatchObject({
      serviceBindingId: null,
      unresolvedReason: 'service_binding_declared_after_call',
    });
    const ambiguous = calls.find((row) => row.operationPath === '/ambiguousCheck');
    expect(ambiguous).toMatchObject({
      serviceBindingId: null,
      unresolvedReason: 'ambiguous_service_binding_candidates',
    });
    expect(JSON.parse(ambiguous?.evidenceJson ?? '{}')).toMatchObject({
      serviceBindingResolution: {
        status: 'ambiguous',
        candidateCount: 2,
      },
    });
    linkWorkspace(db, workspaceId);
    const result = trace(db, { repo: 'gateway-app' }, { depth: 5 });
    const ambiguousEdge = result.edges.find((edge) =>
      edge.from.includes('handler.ts')
      && (edge.evidence.outboundEvidence as Row | undefined)?.receiver === 'selectedClient');
    expect(ambiguousEdge?.unresolvedReason).toBe('Ambiguous contextual service binding candidates');
    const contextualBinding = ambiguousEdge?.evidence.contextualBinding as Row | undefined;
    expect(contextualBinding?.status).toBe('tied');
    const aliases = Array.isArray(contextualBinding?.candidates)
      ? contextualBinding.candidates.map((candidate) =>
          typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
            ? (candidate as Row).alias
            : undefined)
      : [];
    expect(aliases).toEqual(expect.arrayContaining(['first-service', 'second-service']));
    db.close();
  });

  it('keeps same-named client bindings inside their executable symbol scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-binding-scope-'));
    await writeFixtureFile(root, 'gateway-app/.git-fixture');
    await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
      name: '@neutral/gateway-app',
      version: '1.0.0',
    }));
    await writeFixtureFile(root, 'gateway-app/srv/handler.ts', `
      import cds from '@sap/cds';
      export async function first(): Promise<void> {
        const client = await cds.connect.to('first-service');
        await client.send({ method: 'POST', path: '/firstCheck' });
      }
      export async function second(): Promise<void> {
        const client = await cds.connect.to('second-service');
        await client.send({ method: 'POST', path: '/secondCheck' });
      }
    `);
    const { db } = await prepareWorkspace(root);
    const rows = db.prepare(`
      SELECT c.operation_path_expr operationPath,b.alias
      FROM outbound_calls c
      LEFT JOIN service_bindings b ON b.id=c.service_binding_id
      ORDER BY c.source_line
    `).all() as Array<{ operationPath?: string; alias?: string | null }>;
    expect(rows).toEqual([
      { operationPath: '/firstCheck', alias: 'first-service' },
      { operationPath: '/secondCheck', alias: 'second-service' },
    ]);
    db.close();
  });

  it('reports separate strict doctor binding categories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-binding-doctor-'));
    await createBindingWorkspace(root);
    const { db } = await prepareWorkspace(root);
    const quality = doctorDiagnostics(db, true).find((item) =>
      item.code === 'strict_service_binding_quality') as {
      categories?: Array<{ category?: string; count?: number; examples?: Row[] }>;
    };
    expect(quality.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'direct_binding_missing', count: 1 }),
      expect.objectContaining({ category: 'ambiguous_binding_candidates', count: 1 }),
    ]));
    db.close();
  });
});

describe('central operation path candidate analysis', () => {
  it('applies the same candidate semantics to direct sends', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-path-analysis-'));
    await writeFixtureFile(root, 'handler.ts', `
      import cds from '@sap/cds';
      export async function run(mode: string, input: { path: string }): Promise<void> {
        const client = await cds.connect.to('remote-service');
        const conditionalPath = mode === 'preview' ? '/previewCheck' : '/runCheck';
        await client.send({ method: 'POST', path: conditionalPath });

        let branchPath = '/runCheck';
        if (mode === 'preview') branchPath = '/previewCheck';
        await client.send({ method: 'POST', path: branchPath });

        let dynamicPath = '/runCheck';
        dynamicPath = input.path;
        await client.send({ method: 'POST', path: dynamicPath });
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    for (const identifier of ['conditionalPath', 'branchPath']) {
      const call = calls.find((item) =>
        (item.evidence?.pathAnalysis as Row | undefined)?.candidateIdentifier === identifier);
      expect(call).toMatchObject({
        operationPathExpr: undefined,
        unresolvedReason: 'ambiguous_operation_path_candidates',
      });
      expect(call?.evidence?.pathAnalysis).toMatchObject({
        status: 'ambiguous',
        candidateRawPaths: ['/previewCheck', '/runCheck'],
        candidateNormalizedOperationPaths: ['/previewCheck', '/runCheck'],
      });
    }
    const dynamic = calls.find((item) =>
      (item.evidence?.pathAnalysis as Row | undefined)?.candidateIdentifier === 'dynamicPath');
    expect(dynamic).toMatchObject({
      operationPathExpr: '${input.path}',
      unresolvedReason: 'dynamic_operation_path_identifier',
    });
    expect(dynamic?.evidence?.pathAnalysis).toMatchObject({
      status: 'dynamic',
      placeholderKeys: ['input.path'],
    });
  });

  it('applies candidate semantics to nested imported wrappers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-imported-path-analysis-'));
    await writeFixtureFile(root, 'inner.ts', `
      export async function sendInner(client: { send(input: unknown): Promise<unknown> }, path: string) {
        return client.send({ method: 'POST', path });
      }
    `);
    await writeFixtureFile(root, 'outer.ts', `
      import { sendInner } from './inner.js';
      export async function sendOuter(client: { send(input: unknown): Promise<unknown> }, path: string) {
        return sendInner(client, path);
      }
    `);
    await writeFixtureFile(root, 'handler.ts', `
      import cds from '@sap/cds';
      import { sendOuter } from './outer.js';
      export async function run(mode: string): Promise<void> {
        const client = await cds.connect.to('remote-service');
        const path = mode === 'preview' ? '/previewCheck' : '/runCheck';
        await sendOuter(client, path);
      }
    `);
    const calls = await parseOutboundCalls(root, 'handler.ts');
    const call = calls.find((item) => item.evidence?.wrapperFunction === 'sendOuter');
    expect(call).toMatchObject({
      operationPathExpr: undefined,
      unresolvedReason: 'ambiguous_operation_path_candidates',
    });
    expect(call?.evidence?.pathAnalysis).toMatchObject({
      status: 'ambiguous',
      candidateRawPaths: ['/previewCheck', '/runCheck'],
      candidateNormalizedOperationPaths: ['/previewCheck', '/runCheck'],
    });
  });

  it('persists ambiguous path candidates as an ambiguous graph edge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-path-graph-'));
    await writeFixtureFile(root, 'gateway-app/.git-fixture');
    await writeFixtureFile(root, 'gateway-app/package.json', JSON.stringify({
      name: '@neutral/gateway-app',
      version: '1.0.0',
    }));
    await writeFixtureFile(root, 'gateway-app/srv/handler.ts', `
      import cds from '@sap/cds';
      export async function run(mode: string): Promise<void> {
        const client = await cds.connect.to('remote-service');
        const path = mode === 'preview' ? '/previewCheck' : '/runCheck';
        await client.send({ method: 'POST', path });
      }
    `);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);
    const edge = db.prepare(`
      SELECT status,unresolved_reason unresolvedReason,evidence_json evidenceJson
      FROM graph_edges WHERE from_kind='call'
    `).get() as { status?: string; unresolvedReason?: string; evidenceJson?: string };
    expect(edge).toMatchObject({
      status: 'ambiguous',
      unresolvedReason: 'Ambiguous operation path candidates require explicit disambiguation',
    });
    expect(JSON.parse(edge.evidenceJson ?? '{}')).toMatchObject({
      outboundEvidence: {
        pathAnalysis: {
          status: 'ambiguous',
          candidateRawPaths: ['/previewCheck', '/runCheck'],
        },
      },
    });
    db.close();
  });
});

describe('trace and OData remediation evidence', () => {
  it('keeps entity precedence explicit and suggests service selectors for ambiguous starts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'service-flow-trace-remediation-'));
    await writeFixtureFile(root, 'domain-service/.git-fixture');
    await writeFixtureFile(root, 'domain-service/package.json', JSON.stringify({
      name: '@neutral/domain-service',
      version: '1.0.0',
    }));
    await writeFixtureFile(root, 'domain-service/srv/domain.cds', `
      service FirstDomainService { function readSnapshot(id: String) returns String; }
      service SecondDomainService { function readSnapshot(id: String) returns String; }
    `);
    await writeFixtureFile(root, 'domain-service/srv/handler.ts', `
      import cds from '@sap/cds';
      export async function inspect(id: string): Promise<void> {
        const client = await cds.connect.to('first', { credentials: { path: '/FirstDomainService' } });
        await client.send({ method: 'GET', path: \`/DomainItems(id='\${id}')/children?$top=10\` });
      }
    `);
    const { db, workspaceId } = await prepareWorkspace(root);
    linkWorkspace(db, workspaceId);

    const ambiguous = trace(db, { repo: 'domain-service', operation: 'readSnapshot' }, { depth: 5 });
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_start_ambiguous',
      serviceSuggestions: [
        '--service /FirstDomainService',
        '--service /SecondDomainService',
      ],
    }));
    const candidates = ambiguous.diagnostics.find((item) =>
      item.code === 'trace_start_ambiguous')?.candidates;
    const candidateRows = Array.isArray(candidates)
      ? candidates.filter((candidate): candidate is Row =>
          typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate))
      : [];
    expect(candidateRows.some((candidate) =>
      candidate.sourceFile === 'srv/domain.cds'
      && typeof candidate.sourceLine === 'number')).toBe(true);

    const entityEdge = db.prepare(`
      SELECT e.evidence_json evidenceJson
      FROM graph_edges e JOIN outbound_calls c
        ON e.from_kind='call' AND e.from_id=CAST(c.id AS TEXT)
      WHERE c.operation_path_expr LIKE '/DomainItems%'
    `).get() as { evidenceJson?: string };
    const entityEvidence = JSON.parse(entityEdge.evidenceJson ?? '{}') as Row;
    const precedence = entityEvidence.entityOperationPrecedence as Row;
    const intent = entityEvidence.odataPathIntent as Row;
    expect(precedence.decision).toBe('entity');
    expect(typeof precedence.rejectionReason).toBe('string');
    expect(intent.kind).toBe('entity_navigation_query');
    expect(String(intent.rawPath)).toContain('/DomainItems');
    db.close();
  });
});
