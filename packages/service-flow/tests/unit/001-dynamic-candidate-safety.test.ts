import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { schemaSql } from '../../src/db/schema.js';
import { analyzeDynamicTargetCandidates } from '../../src/trace/dynamic-targets.js';

function dynamicDb(): Db {
  const db = openDatabase(':memory:');
  db.exec(schemaSql);
  db.prepare(
    "INSERT INTO workspaces(id,root_path,db_path,created_at,updated_at) VALUES(1,'workspace',':memory:','now','now')",
  ).run();
  db.prepare(
    "INSERT INTO repositories(id,workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo) VALUES(1,1,'gateway','workspace/gateway','gateway','@neutral/gateway','cap-service',0)",
  ).run();
  return db;
}

function addBinding(
  db: Db,
  alias: string,
  servicePath: string,
  line: number,
): void {
  db.prepare(`INSERT INTO service_bindings(
    repo_id,variable_name,alias,alias_expr,destination_expr,service_path_expr,
    is_dynamic,placeholders_json,source_file,source_line
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    1, `client${line}`, alias, alias, alias, servicePath,
    0, '[]', 'srv/bindings.ts', line,
  );
}

function candidate(
  operationId: number,
  repoName: string,
  servicePath: string,
  score: number,
): Record<string, unknown> {
  return {
    operationId,
    repoId: operationId + 10,
    repoName,
    packageName: `@neutral/${repoName}`,
    serviceName: servicePath.slice(1),
    qualifiedName: servicePath.slice(1),
    servicePath,
    operationPath: '/collect',
    operationName: 'collect',
    sourceFile: 'srv/service.cds',
    sourceLine: 2,
    score,
    reasons: ['operation_path_match'],
  };
}

function evidence(candidates: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    repo: 'gateway',
    servicePath: '/${entityName}Service',
    serviceAliasExpr: 'worker_${entityCode}_service',
    candidates,
  };
}

function addImplementedCandidate(
  db: Db,
  operationId: number,
  absolutePath: string,
  servicePath: string,
): void {
  const repoId = operationId + 10;
  db.prepare(`INSERT INTO repositories(
    id,workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
  ) VALUES(?,1,'worker_or_service',?,?,?,'cap-service',0)`).run(
    repoId, absolutePath, absolutePath, `@neutral/worker-${operationId}`,
  );
  db.prepare(`INSERT INTO cds_services(
    id,repo_id,service_name,qualified_name,service_path,is_extend,source_file,source_line
  ) VALUES(?,?,?, ?,?,0,'srv/service.cds',1)`).run(
    repoId, repoId, servicePath.slice(1), servicePath.slice(1), servicePath,
  );
  db.prepare(`INSERT INTO cds_operations(
    id,service_id,operation_type,operation_name,operation_path,params_json,
    source_file,source_line
  ) VALUES(?,?,'action','collect','/collect','[]','srv/service.cds',2)`).run(
    operationId, repoId,
  );
  db.prepare(`INSERT INTO handler_classes(
    id,repo_id,class_name,source_file,source_line
  ) VALUES(?,?,?,'srv/Handler.ts',1)`).run(
    repoId, repoId, `Handler${operationId}`,
  );
  db.prepare(`INSERT INTO handler_methods(
    id,handler_class_id,method_name,decorator_kind,decorator_raw_expression,
    decorator_resolution_json,source_file,source_line
  ) VALUES(?,?, 'collect','Action','collect','{}','srv/Handler.ts',2)`).run(
    repoId, repoId,
  );
  db.prepare(`INSERT INTO graph_edges(
    workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,
    evidence_json,is_dynamic
  ) VALUES(1,'OPERATION_IMPLEMENTED_BY_HANDLER','resolved','operation',?,
    'handler_method',?,1,'{}',0)`).run(String(operationId), String(repoId));
}

describe('dynamic candidate safety invariants', () => {
  it('scores a repeated reference signal once and bounds its provenance', () => {
    const db = dynamicDb();
    for (let line = 1; line <= 6; line += 1)
      addBinding(db, 'worker_or_service', '/OrderService', line);

    const analysis = analyzeDynamicTargetCandidates(
      db,
      evidence([candidate(10, 'worker-order', '/OrderService', 0.2)]),
      1,
      'infer',
      1,
    );
    const shown = analysis?.shownCandidates[0];
    expect(shown?.score).toBeCloseTo(0.9);
    expect(shown?.reasons.filter((reason) =>
      reason === 'alias_template_match')).toHaveLength(1);
    expect(shown?.derivationProvenance.entityCode).toHaveLength(1);
    db.close();
  });

  it('does not skip a stronger viable candidate that still lacks a value', () => {
    const db = dynamicDb();
    addBinding(db, 'worker_in_service', '/InvoiceService', 1);
    const analysis = analyzeDynamicTargetCandidates(
      db,
      evidence([
        candidate(10, 'worker-order', '/OrderService', 0.7),
        candidate(11, 'worker-invoice', '/InvoiceService', 0.2),
      ]),
      1,
      'infer',
      5,
    );

    expect(analysis?.shownCandidates[0]).toMatchObject({
      repoName: 'worker-order',
      missingVariables: ['entityCode'],
      viable: true,
    });
    expect(analysis?.inference).toMatchObject({
      status: 'unresolved',
      reason: 'missing_required_runtime_variable',
    });
    expect(analysis?.shownCandidates.every((item) => !item.selected)).toBe(true);
    db.close();
  });

  it('rejects identity fallback when duplicate repository names have different ids', () => {
    const db = dynamicDb();
    addImplementedCandidate(db, 10, 'workspace/worker-a', '/OrderService');
    addImplementedCandidate(db, 11, 'workspace/worker-b', '/InvoiceService');
    const input = evidence([
      candidate(10, 'worker_or_service', '/OrderService', 0.2),
      candidate(11, 'worker_or_service', '/InvoiceService', 0.2),
    ]);
    input.runtimeSubstitutions = {
      servicePath: {
        original: '/${entityName}Service',
        effective: '/OrderService',
      },
    };
    input.suppliedRuntimeVariables = { entityName: 'Order' };
    const analysis = analyzeDynamicTargetCandidates(db, input, 1, 'infer', 5);
    const order = analysis?.shownCandidates.find((item) =>
      item.servicePath === '/OrderService');
    expect(order).toMatchObject({
      completeVariables: { entityName: 'Order' },
      derivedVariables: {},
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(order?.derivedVariableSources).not.toHaveProperty('entityCode');
    db.close();
  });

  it('rejects identity fallback when a non-candidate repository duplicates the identity', () => {
    const db = dynamicDb();
    addImplementedCandidate(db, 10, 'workspace/worker-a', '/OrderService');
    db.prepare(`INSERT INTO repositories(
      id,workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
    ) VALUES(99,1,'identity-holder','workspace/identity-holder',
      'identity-holder','@neutral/worker_or_service','helper-package',0)`).run();
    const analysis = analyzeDynamicTargetCandidates(
      db,
      evidence([candidate(10, 'worker_or_service', '/OrderService', 0.2)]),
      1,
      'infer',
      5,
    );

    expect(analysis?.shownCandidates[0]).toMatchObject({
      derivedVariables: { entityName: 'Order' },
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(analysis?.inference).toMatchObject({
      status: 'unresolved',
      reason: 'missing_required_runtime_variable',
    });
    db.close();
  });

  it('requires one exact implementation owner before using identity evidence', () => {
    const db = dynamicDb();
    addImplementedCandidate(db, 10, 'workspace/worker-a', '/OrderService');
    db.prepare(`INSERT INTO repositories(
      id,workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
    ) VALUES(30,1,'implementation-helper','workspace/implementation-helper',
      'implementation-helper','@neutral/implementation-helper','helper-package',0)`).run();
    db.prepare(`INSERT INTO handler_classes(
      id,repo_id,class_name,source_file,source_line
    ) VALUES(30,30,'SecondHandler','src/SecondHandler.ts',1)`).run();
    db.prepare(`INSERT INTO handler_methods(
      id,handler_class_id,method_name,decorator_kind,decorator_raw_expression,
      decorator_resolution_json,source_file,source_line
    ) VALUES(30,30,'collect','Action','collect','{}','src/SecondHandler.ts',2)`).run();
    db.prepare(`INSERT INTO graph_edges(
      workspace_id,edge_type,status,from_kind,from_id,to_kind,to_id,confidence,
      evidence_json,is_dynamic
    ) VALUES(1,'OPERATION_IMPLEMENTED_BY_HANDLER','resolved','operation','10',
      'handler_method','30',1,'{}',0)`).run();

    const analysis = analyzeDynamicTargetCandidates(
      db,
      evidence([candidate(10, 'worker_or_service', '/OrderService', 0.2)]),
      1,
      'infer',
      5,
    );
    expect(analysis?.shownCandidates[0]).toMatchObject({
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(analysis?.shownCandidates[0]?.derivedVariableSources)
      .not.toHaveProperty('entityCode');
    db.close();
  });

  it('does not treat a repository path segment as the entire repository identity', () => {
    const db = dynamicDb();
    addImplementedCandidate(db, 10, 'workspace/worker-a', '/OrderService');
    db.prepare(`UPDATE repositories SET name='group/worker_or_service',
      package_name='@neutral/unrelated' WHERE id=20`).run();
    const analysis = analyzeDynamicTargetCandidates(db, evidence([
      candidate(10, 'group/worker_or_service', '/OrderService', 0.2),
    ]), 1, 'infer', 5);

    expect(analysis?.shownCandidates[0]).toMatchObject({
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(analysis?.shownCandidates[0]?.derivedVariableSources)
      .not.toHaveProperty('entityCode');
    db.close();
  });

  it('uses an exact caller repository id for binding evidence', () => {
    const db = dynamicDb();
    db.prepare(`INSERT INTO repositories(
      id,workspace_id,name,absolute_path,relative_path,package_name,kind,is_git_repo
    ) VALUES(2,1,'gateway','workspace/other-gateway','other-gateway',
      '@neutral/other-gateway','cap-service',0)`).run();
    db.prepare(`INSERT INTO service_bindings(
      repo_id,variable_name,alias,alias_expr,destination_expr,service_path_expr,
      is_dynamic,placeholders_json,source_file,source_line
    ) VALUES(2,'client','worker_or_service','worker_or_service',
      'worker_or_service','/OrderService',0,'[]','srv/other.ts',1)`).run();
    const input = evidence([
      candidate(10, 'worker-order', '/OrderService', 0.2),
    ]);
    input.repoId = 1;

    const analysis = analyzeDynamicTargetCandidates(db, input, 1, 'infer', 5);
    expect(analysis?.shownCandidates[0]).toMatchObject({
      completeVariables: { entityName: 'Order' },
      missingVariables: ['entityCode'],
      selected: false,
    });
    expect(analysis?.shownCandidates[0]?.derivedVariableSources)
      .not.toHaveProperty('entityCode');
    db.close();
  });

  it('does not blend multiple fallback bindings into one routing derivation', () => {
    const db = dynamicDb();
    addBinding(db, 'worker_or_service', '/OrderService', 1);
    addBinding(db, 'worker_wrong_service', '/OrderService', 2);

    const analysis = analyzeDynamicTargetCandidates(db, evidence([
      candidate(10, 'worker-order', '/OrderService', 0.2),
    ]), 1, 'infer', 5);
    const shown = analysis?.shownCandidates[0];

    expect(shown).toMatchObject({
      derivedVariables: { entityName: 'Order' },
      missingVariables: ['entityCode'],
    });
    expect(shown?.derivedVariableSources).not.toHaveProperty('entityCode');
    expect(shown?.reasons).toContain('fallback_reference_ambiguous');
    expect(shown?.inferenceBlockReasons).toContain('fallback_reference_ambiguous');
    expect(analysis?.inference).toMatchObject({
      status: 'unresolved',
      reason: 'missing_required_runtime_variable',
    });
    db.close();
  });

  it('distinguishes exact ties from candidates within the inference margin', () => {
    const db = dynamicDb();
    const input = {
      repo: 'gateway',
      repoId: 1,
      servicePath: '/${entityName}Service',
      candidates: [
        candidate(10, 'worker-alpha', '/AlphaService', 0.35),
        candidate(11, 'worker-beta', '/BetaService', 0.32),
      ],
    };
    const withinMargin = analyzeDynamicTargetCandidates(
      db, input, 1, 'infer', 5,
    );
    expect(withinMargin?.inference).toMatchObject({
      status: 'ambiguous',
      reason: 'candidate_within_inference_margin',
    });
    expect(withinMargin?.shownCandidates[0]?.inferenceBlockReasons)
      .toContain('candidate_within_inference_margin');
    expect(withinMargin?.shownCandidates[0]?.rejected).toBe(false);

    input.candidates[1] = candidate(11, 'worker-beta', '/BetaService', 0.35);
    const tied = analyzeDynamicTargetCandidates(db, input, 1, 'infer', 5);
    expect(tied?.inference).toMatchObject({
      status: 'ambiguous',
      reason: 'candidate_tied_with_equal_score',
    });
    db.close();
  });

  it('enforces the inference threshold and margin boundaries', () => {
    const db = dynamicDb();
    const analyze = (
      firstScore: number,
      secondScore?: number,
    ): ReturnType<typeof analyzeDynamicTargetCandidates> =>
      analyzeDynamicTargetCandidates(db, {
        repo: 'gateway',
        repoId: 1,
        servicePath: '/${entityName}Service',
        candidates: [
          candidate(10, 'worker-alpha', '/AlphaService', firstScore),
          ...(secondScore === undefined ? [] : [
            candidate(11, 'worker-beta', '/BetaService', secondScore),
          ]),
        ],
      }, 1, 'infer', 5);

    expect(analyze(0.34)?.inference).toMatchObject({
      status: 'unresolved',
      reason: 'candidate_score_below_inference_threshold',
    });
    expect(analyze(0.35, 0.30)?.inference).toMatchObject({
      status: 'ambiguous',
    });
    expect(analyze(0.35, 0.29)?.inference).toMatchObject({
      status: 'resolved',
      candidateOperationId: 10,
    });
    db.close();
  });

  it('quotes copyable runtime arguments without evaluating shell syntax', () => {
    const db = dynamicDb();
    const key = 'domainInfo.shortName?.toLowerCase()';
    const value = "or value;$(ignored)'suffix";
    const analysis = analyzeDynamicTargetCandidates(db, {
      repo: 'gateway',
      repoId: 1,
      servicePath: `/service/${'${'}${key}}`,
      candidates: [{
        ...candidate(10, 'worker-order', `/service/${value}`, 0.35),
        servicePath: `/service/${value}`,
      }],
    }, 1, 'strict', 5);

    expect(analysis?.shownCandidates[0]?.cli).toBe(
      `--var '${key}=or value;$(ignored)'"'"'suffix'`,
    );
    db.close();
  });
});
