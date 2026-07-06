import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { linkWorkspace, trace } from '../../src/index.js';
import { schemaVersion } from '../../src/db/migrations.js';
import { prepareWorkspace } from './test-workspace.js';

const fixture = path.resolve('tests/fixtures/trace-correctness-workspace');

async function prepareNeutralWorkspace(): ReturnType<typeof prepareWorkspace> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'service-flow-neutral-workspace-'));
  const workspace = path.join(tempRoot, 'workspace');
  await cp(fixture, workspace, { recursive: true });
  return prepareWorkspace(workspace);
}

describe('neutral multi-repository trace workspace', () => {
  it('resolves runtime and contextual flows while preserving conservative graph state', async () => {
    const { db, workspaceId } = await prepareNeutralWorkspace();
    const linked = linkWorkspace(db, workspaceId);
    expect(linked.implementationAmbiguousCount).toBeGreaterThanOrEqual(1);

    const runtime = trace(db, {
      repo: 'gateway-app',
      servicePath: '/GatewayService',
      operation: 'runCompositeCheck',
    }, {
      depth: 12,
      includeDb: true,
      includeExternal: true,
      includeAsync: true,
      vars: { domain: 'Product', shortName: 'prod' },
    });
    expect(runtime.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.to === '/ProductProcessService/runDeepCheck')).toBe(true);
    expect(runtime.edges.some((edge) =>
      edge.type === 'remote_action'
      && edge.evidence.contextualBinding
      && edge.to.includes('/UserProfileService/getScope'))).toBe(true);
    expect(runtime.edges.some((edge) =>
      edge.type === 'remote_query'
      && String(edge.to).includes('DomainItems'))).toBe(true);
    expect(runtime.edges.filter((edge) => edge.unresolvedReason)).toEqual([]);

    const missing = trace(db, {
      repo: 'gateway-app',
      servicePath: '/GatewayService',
      operation: 'runCompositeCheck',
    }, {
      depth: 12,
      includeDb: true,
      includeExternal: true,
      includeAsync: true,
    });
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
      missingVariables: ['domain', 'shortName'],
      suggestions: ['--var domain=<value>', '--var shortName=<value>'],
    }));

    const ambiguous = trace(db, {
      repo: 'process-service',
      servicePath: '/ProductProcessService',
      operation: 'activate',
    }, { depth: 8, includeDb: true });
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({
      resolutionStatus: 'ambiguous_implementation',
    }));

    const guided = trace(db, {
      repo: 'process-service',
      servicePath: '/ProductProcessService',
      operation: 'activate',
    }, {
      depth: 8,
      includeDb: true,
      implementationHints: [{
        servicePath: '/ProductProcessService',
        operationPath: '/activate',
        implementationRepo: 'process-helper-a',
      }],
    });
    const guidedImplementation = guided.edges.find((edge) =>
      edge.type === 'operation_implemented_by_handler');
    expect(guidedImplementation?.to).toContain('ActivateHandlerA.activate');
    expect(guidedImplementation?.unresolvedReason).toBeUndefined();
    expect(guided.edges.some((edge) =>
      edge.type === 'local_db_query'
      && edge.to === 'Entity: ActivationA')).toBe(true);
    db.close();
  });

  it('keeps SQLite evidence and integrity checks machine-verifiable', async () => {
    const { db, workspaceId } = await prepareNeutralWorkspace();
    linkWorkspace(db, workspaceId);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(schemaVersion(db)).toBeGreaterThan(0);

    const invalidOutbound = db.prepare(`
      SELECT COUNT(*) count FROM outbound_calls
      WHERE evidence_json IS NULL OR json_valid(evidence_json)=0
        OR json_type(evidence_json)<>'object'
    `).get() as { count?: number };
    const invalidEdges = db.prepare(`
      SELECT COUNT(*) count FROM graph_edges
      WHERE json_valid(evidence_json)=0 OR json_type(evidence_json)<>'object'
    `).get() as { count?: number };
    expect(invalidOutbound.count).toBe(0);
    expect(invalidEdges.count).toBe(0);

    const contextual = db.prepare(`
      SELECT service_binding_id serviceBindingId,unresolved_reason unresolvedReason,
        evidence_json evidenceJson
      FROM outbound_calls
      WHERE source_file='srv/context-helper.ts' AND operation_path_expr='/getScope'
    `).get() as {
      serviceBindingId?: number | null;
      unresolvedReason?: string;
      evidenceJson?: string;
    };
    expect(contextual.serviceBindingId).toBeNull();
    expect(contextual.unresolvedReason).toBeNull();
    expect(JSON.parse(contextual.evidenceJson ?? '{}')).toMatchObject({
      serviceBindingResolution: { status: 'unrecoverable' },
    });

    const bindingChains = db.prepare(`
      SELECT COUNT(*) count FROM service_bindings
      WHERE helper_chain_json IS NOT NULL AND json_valid(helper_chain_json)=1
    `).get() as { count?: number };
    expect(Number(bindingChains.count ?? 0)).toBeGreaterThan(0);

    const statuses = db.prepare(`
      SELECT edge_type edgeType,status,COUNT(*) count
      FROM graph_edges GROUP BY edge_type,status ORDER BY edge_type,status
    `).all() as Array<{ edgeType?: string; status?: string; count?: number }>;
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edgeType: 'OPERATION_IMPLEMENTED_BY_HANDLER',
        status: 'ambiguous',
      }),
      expect.objectContaining({
        edgeType: 'DYNAMIC_EDGE_CANDIDATE',
        status: 'dynamic',
      }),
    ]));
    const dynamicEdge = db.prepare(`
      SELECT edge_type edgeType,status,is_dynamic isDynamic,evidence_json evidenceJson
      FROM graph_edges WHERE status='dynamic' ORDER BY id LIMIT 1
    `).get() as {
      edgeType?: string;
      status?: string;
      isDynamic?: number;
      evidenceJson?: string;
    };
    expect(dynamicEdge).toMatchObject({
      edgeType: 'DYNAMIC_EDGE_CANDIDATE',
      status: 'dynamic',
      isDynamic: 1,
    });
    const dynamicEvidence = JSON.parse(dynamicEdge.evidenceJson ?? '{}') as unknown;
    expect(typeof dynamicEvidence).toBe('object');
    expect(Array.isArray(dynamicEvidence)).toBe(false);

    const diagnosticRows = db.prepare(`
      SELECT severity,code,message,source_file sourceFile,source_line sourceLine
      FROM diagnostics ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(diagnosticRows.every((row) =>
      typeof row.severity === 'string'
      && typeof row.code === 'string'
      && typeof row.message === 'string')).toBe(true);

    const strict = doctorDiagnostics(db, true);
    const bindingQuality = strict.find((item) =>
      item.code === 'strict_service_binding_quality');
    expect(Array.isArray(bindingQuality?.categories)).toBe(true);
    db.close();
  });
});
