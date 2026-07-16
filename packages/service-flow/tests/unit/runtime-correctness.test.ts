import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';
import { substituteVariables } from '../../src/linker/dynamic-edge-resolver.js';
import { resolveOperation } from '../../src/linker/service-resolver.js';
import { openDatabase } from '../../src/db/connection.js';
import { schemaSql } from '../../src/db/schema.js';
import {
  runtimeNoCandidateDiagnostics,
  runtimeVariableDiagnostic,
  runtimeResolution,
  type TraceGraphRow,
} from '../../src/trace/evidence.js';

describe('runtime substitution and resolution correctness', () => {
  it('keeps partial substitutions dynamic with missing placeholder names', () => {
    const result = substituteVariables('/svc/${tenant}/${operation}', {
      tenant: 'alpha',
    });
    expect(result.effective).toBe('/svc/alpha/${operation}');
    expect(result.supplied).toEqual(['tenant']);
    expect(result.missing).toEqual(['operation']);
  });

  it('handles unmatched placeholder openers within a bounded time', () => {
    const template = '${{|'.repeat(12_000);
    const startedAt = performance.now();
    const result = substituteVariables(template, {});

    expect(result.effective).toBe(template);
    expect(result.placeholders).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it('clamps explicit runtime confidence to one', () => {
    const db = openDatabase(':memory:');
    db.exec(schemaSql);
    db.prepare("INSERT INTO workspaces(id,root_path,db_path,created_at,updated_at) VALUES(1,'/w',':memory:','n','n')").run();
    db.prepare("INSERT INTO repositories(id,workspace_id,name,absolute_path,relative_path,kind,is_git_repo) VALUES(1,1,'model','/w/model','model','cap-service',0)").run();
    db.prepare("INSERT INTO cds_services(id,repo_id,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(1,1,'SyntheticService','SyntheticService','/synthetic',0,'srv/synthetic.cds',1)").run();
    db.prepare("INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,source_file,source_line) VALUES(1,'action','run','/run','[]','srv/synthetic.cds',2)").run();
    const resolution = resolveOperation(db, {
      servicePath: '/synthetic',
      operationPath: '/run',
      hasExplicitOverride: true,
      isDynamic: true,
    }, 1);
    expect(resolution.target?.score).toBe(1);
    db.close();
  });

  it('never reclassifies terminal or already resolved edges during inference', () => {
    const db = openDatabase(':memory:');
    const candidate = {
      operationId: 91,
      repoName: 'worker-service',
      packageName: '@neutral/worker-service',
      serviceName: 'OrderService',
      qualifiedName: 'OrderService',
      servicePath: '/OrderService',
      operationPath: '/run',
      operationName: 'run',
      sourceFile: 'srv/order.cds',
      sourceLine: 2,
      score: 0.2,
      reasons: ['operation_path_match'],
    };
    const cases = [
      ['HANDLER_RUNS_DB_QUERY', 'terminal', 'db_entity', 'Orders', 'local_db_query'],
      ['HANDLER_RUNS_REMOTE_QUERY', 'terminal', 'remote_entity', 'Orders', 'remote_query'],
      ['HANDLER_CALLS_EXTERNAL_HTTP', 'terminal', 'external_endpoint', 'endpoint:orders', 'external_http'],
      ['HANDLER_EMITS_EVENT', 'terminal', 'event', 'OrdersChanged', 'async_emit'],
      ['REMOTE_CALL_RESOLVES_TO_OPERATION', 'resolved', 'operation', '55', 'remote_action'],
    ] as const;
    for (const [edgeType, status, targetKind, targetId, callType] of cases) {
      const row: TraceGraphRow = {
        id: 10,
        edge_type: edgeType,
        from_id: '7',
        to_kind: targetKind,
        to_id: targetId,
        confidence: 0.8,
        evidence_json: '{}',
        status,
      };
      const resolved = runtimeResolution(db, row, {
        callType,
        servicePath: '/${entityName}Service',
        operationPath: '/run',
        candidates: [candidate, candidate, candidate],
        candidateScores: [candidate, candidate, candidate],
      }, { dynamicMode: 'infer', maxDynamicCandidates: 1 }, 1);
      expect(resolved.row).toMatchObject({
        edge_type: edgeType,
        status,
        to_kind: targetKind,
        to_id: targetId,
      });
      expect(resolved.target).toBeUndefined();
      expect(resolved.evidence).not.toHaveProperty('dynamicTargetInference');
      expect(resolved.evidence.candidates).toEqual([candidate]);
      expect(resolved.evidence.candidateScores).toEqual([candidate]);
      expect(resolved.evidence).toMatchObject({
        persistedCandidateCount: 3,
        persistedCandidateOmittedCount: 2,
      });
    }
    db.close();
  });

  it('reports aggregate shown and omitted counts from the globally bounded list', () => {
    const edge = (suffix: string): { evidence: Record<string, unknown> } => ({
      evidence: {
        effectiveResolution: { status: 'dynamic' },
        runtimeSubstitutions: {
          servicePath: { missing: ['entityName'] },
        },
        dynamicTargetCandidateSuggestions: [
          { repoName: `worker-${suffix}`, servicePath: `/${suffix}Service` },
        ],
        dynamicTargetExploration: {
          maxCandidates: 1,
          candidateCount: 2,
          viableCandidateCount: 2,
          rejectedCandidateCount: 0,
          shownCandidateCount: 1,
          omittedCandidateCount: 1,
          suggestedVarSets: [],
          rejectedCandidates: [],
        },
      },
    });
    const diagnostic = runtimeVariableDiagnostic([edge('alpha'), edge('beta')]);
    expect(diagnostic).toMatchObject({
      candidateCount: 4,
      viableCandidateCount: 4,
      shownCandidateCount: 1,
      omittedCandidateCount: 3,
    });
    expect(diagnostic?.candidateSuggestions).toHaveLength(1);
  });

  it('does not report a no-match when no supplied variable applies to the edge', () => {
    const db = openDatabase(':memory:');
    db.exec(schemaSql);
    const row: TraceGraphRow = {
      id: 10,
      edge_type: 'DYNAMIC_EDGE_CANDIDATE',
      from_id: '7',
      to_kind: 'operation_candidate',
      to_id: '',
      confidence: 0.4,
      evidence_json: '{}',
      status: 'dynamic',
      unresolved_reason: 'Runtime target requires entityName',
    };
    const result = runtimeResolution(db, row, {
      callType: 'remote_action',
      repo: 'gateway',
      repoId: 1,
      servicePath: '/${entityName}Service',
      operationPath: '/collect',
      candidates: [],
    }, { vars: { unrelated: 'value' } }, 1);

    expect(result.unresolvedReason).toBe('Runtime target requires entityName');
    expect(runtimeNoCandidateDiagnostics([{ evidence: result.evidence }]))
      .toEqual([]);
    db.close();
  });

  it('reports a no-match when an applicable runtime value leaves no canonical target', () => {
    const db = openDatabase(':memory:');
    db.exec(schemaSql);
    const row: TraceGraphRow = {
      id: 11,
      edge_type: 'DYNAMIC_EDGE_CANDIDATE',
      from_id: '8',
      to_kind: 'operation_candidate',
      to_id: '',
      confidence: 0.4,
      evidence_json: '{}',
      status: 'dynamic',
      unresolved_reason: 'Runtime target requires entityName',
    };
    const result = runtimeResolution(db, row, {
      callType: 'remote_action',
      repo: 'gateway',
      repoId: 1,
      servicePath: '/${entityName}Service',
      operationPath: '/collect',
      candidates: [],
    }, { vars: { entityName: 'Unknown' } }, 1);

    expect(result.unresolvedReason).toBe('No candidate remained after runtime substitution');
    expect(runtimeNoCandidateDiagnostics([{ evidence: result.evidence }]))
      .toEqual([expect.objectContaining({
        code: 'no_candidate_after_runtime_substitution',
        candidateCount: 0,
        viableCandidateCount: 0,
      })]);
    db.close();
  });
});

import ts from 'typescript';
import { classifyOutboundCallsInSource } from '../../src/parsers/outbound-call-parser.js';

describe('expression placeholder substitution', () => {
  it('supports simple and expression placeholder keys without evaluating expressions', () => {
    const result = substituteVariables('/${domain}/${domainInfo.serviceName}/${domainInfo.shortName?.toLowerCase()}/${items[0].service}/${makeKey()}/${domainInfo.serviceName}', {
      domain: 'main',
      'domainInfo.serviceName': 'Catalog',
      'domainInfo.shortName?.toLowerCase()': 'cat',
      'items[0].service': 'Item',
      'makeKey()': 'made',
    });
    expect(result.placeholders).toEqual(['domain', 'domainInfo.serviceName', 'domainInfo.shortName?.toLowerCase()', 'items[0].service', 'makeKey()']);
    expect(result.missing).toEqual([]);
    expect(result.effective).toBe('/main/Catalog/cat/Item/made/Catalog');
  });

  it('reports missing expression placeholder keys', () => {
    const result = substituteVariables('/${domainInfo.serviceName}Service', {});
    expect(result.missing).toEqual(['domainInfo.serviceName']);
    expect(result.effective).toBe('/${domainInfo.serviceName}Service');
  });
});

describe('remote action dynamic path parser evidence', () => {
  it('records shorthand path as a dynamic operation path identifier', () => {
    const source = ts.createSourceFile('handler.ts', `async function run(client, path) { await client.send({ method: 'GET', path }); }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const [call] = classifyOutboundCallsInSource(source, 'handler.ts');
    expect(call?.fact.operationPathExpr).toBeUndefined();
    expect(call?.fact.unresolvedReason).toBe('dynamic_operation_path_identifier');
    expect(call?.fact.evidence).toMatchObject({ operationPathExpression: 'path', parserWarning: 'dynamic_operation_path_identifier' });
  });
});
