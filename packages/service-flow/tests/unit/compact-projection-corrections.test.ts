import { describe, expect, it } from 'vitest';
import {
  CompactObservationCollector,
  type CompactDecisionV1,
} from '../../src/trace/compact-contract.js';
import {
  compactDecisionFromEvidence,
  TraceEdgeRecorder,
} from '../../src/trace/trace-edge-recorder.js';
import { recordOutboundObservation } from
  '../../src/trace/trace-edge-semantics.js';
import {
  compactMissingRemediation,
  isSafeCompactMissingName,
  normalizeCompactDecisionEquivalence,
  projectCompactMissingNames,
} from '../../src/trace/compact-decision-normalization.js';
import {
  projectCompactDecision,
  projectCompactDiagnostics,
} from '../../src/trace/compact-field-projection.js';
import { projectObservationDecision } from
  '../../src/trace/compact-observation-decision.js';

const safeNames = [
  'region',
  'tenantInfo.region',
  'req?.user?.id',
  'tenantInfo.region?.toLowerCase()',
  'domainInfo.shortName.toUpperCase()',
  'items[0].service',
  'items?.[0].service',
];

describe('compact missing-name projection', () => {
  it('retains diagnostic multiplicity after detailed deduplication', () => {
    const diagnostic = projectCompactDiagnostics([{
      severity: 'warning',
      code: 'neutral_repeated_warning',
      message: 'Repeated warning.',
      multiplicity: 7,
    }])[0];
    expect(diagnostic?.details).toMatchObject({ multiplicity: 7 });
  });

  it('retains the documented safe grammar with binary ordering', () => {
    const projection = projectCompactMissingNames(
      [...safeNames].reverse(), safeNames.length,
    );

    expect(projection).toEqual({
      names: [...safeNames].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0),
      total: safeNames.length,
      shown: safeNames.length,
      omitted: 0,
    });
    expect(safeNames.every(isSafeCompactMissingName)).toBe(true);
  });

  it('uses the same exact complex key and cardinality for edges and diagnostics', () => {
    const key = 'tenantInfo.region?.toLowerCase()';
    const edge = projectCompactDecision({
      missingVariableNames: [key],
      missingVariableCount: 1,
      remediationCode: 'provide_runtime_variables',
    });
    const diagnostic = projectCompactDiagnostics([{
      severity: 'warning',
      code: 'trace_runtime_variables_missing',
      missingVariables: [key],
      missingVariableCount: 1,
    }])[0];

    expect(edge).toMatchObject({
      missingVariableNames: [key],
      missingVariableCount: 1,
      shownMissingVariableCount: 1,
      omittedMissingVariableCount: 0,
      remediationHint: 'Provide the missing variable names listed in details.',
    });
    expect(diagnostic?.details).toMatchObject({
      missingVariableNames: [key],
      missingVariableCount: 1,
      shownMissingVariableCount: 1,
      omittedMissingVariableCount: 0,
      remediationHint: 'Provide the missing variable names listed in details.',
    });
  });

});

describe('compact missing-name bounds and privacy', () => {
  it('rejects controls before applying surrounding-space normalization', () => {
    for (const value of [
      'region\r', 'region\n', 'region\t', 'region\r\n', 'region\u0000',
    ]) expect(isSafeCompactMissingName(value)).toBe(false);
    expect(isSafeCompactMissingName('region')).toBe(true);
    expect(isSafeCompactMissingName(' region ')).toBe(true);
    expect(projectCompactMissingNames(['\nregion\t'], undefined)).toEqual({
      names: [], total: 1, shown: 0, omitted: 1,
    });
    const diagnostic = projectCompactDiagnostics([{
      severity: 'warning',
      code: 'trace_runtime_variables_missing',
      missingVariables: ['\nregion\t'],
      missingVariableCount: 1,
    }])[0];
    expect(diagnostic?.details).toMatchObject({
      missingVariableCount: 1,
      shownMissingVariableCount: 0,
      omittedMissingVariableCount: 1,
      remediationHint:
        'Inspect the correlated detailed diagnostic for missing variable names.',
    });
    expect(diagnostic?.details?.missingVariableNames).toBeUndefined();
  });

  it('shows eight of ten safe names and counts every omitted name', () => {
    const values = Array.from({ length: 10 }, (_, index) => `scope.value${index}`);
    const projection = projectCompactMissingNames(values, 10);

    expect(projection.names).toEqual(values.slice(0, 8));
    expect(projection).toMatchObject({ total: 10, shown: 8, omitted: 2 });
  });

  it('keeps authoritative totals while excluding unsafe names', () => {
    const unsafe = [
      "lookup['secret']",
      'choose(value)',
      'value = sentinel',
      'https://private.invalid/token',
      'Bearer credential',
      'line\nbreak',
      'x'.repeat(161),
    ];
    const partial = projectCompactMissingNames(
      ['safe.name', 'safe.name', ...unsafe], 12,
    );
    const hidden = projectCompactMissingNames(unsafe, unsafe.length);

    expect(partial).toEqual({
      names: ['safe.name'], total: 12, shown: 1, omitted: 11,
    });
    expect(hidden).toEqual({
      names: [], total: unsafe.length, shown: 0, omitted: unsafe.length,
    });
    expect(unsafe.every((value) => !isSafeCompactMissingName(value))).toBe(true);
    expect(compactMissingRemediation(
      partial, 'detailed trace edge',
    )).toContain('omitted names');
    expect(compactMissingRemediation(
      hidden, 'detailed diagnostic',
    )).toBe('Inspect the correlated detailed diagnostic for missing variable names.');
  });

  it('does not project arbitrary missingVariables from unknown diagnostics', () => {
    const diagnostic = projectCompactDiagnostics([{
      severity: 'info',
      code: 'unknown_shape',
      missingVariables: ['safe.name'],
      missingVariableCount: 1,
    }])[0];

    expect(diagnostic?.details).toBeUndefined();
  });
});

describe('compact tuple-equivalent decision normalization', () => {
  it('omits effective fields only when canonical tuple cells prove equality', () => {
    const decision: CompactDecisionV1 = {
      effectiveResolutionStatus: 'resolved',
      effectiveTarget: 'symbol:repo-a:src/handler.ts:10:80:Handler.run',
      candidateCount: 1,
    };

    normalizeCompactDecisionEquivalence(
      decision,
      'resolved',
      'symbol:repo-a:src/handler.ts:10:80:Handler.run',
      true,
    );

    expect(decision).toEqual({ candidateCount: 1 });
  });

  it('retains persisted-versus-effective differences', () => {
    const decision: CompactDecisionV1 = {
      effectiveResolutionStatus: 'resolved',
      effectiveTarget: 'symbol:repo-a:src/current.ts:10:80:Handler.run',
      persistedResolutionStatus: 'unresolved',
      persistedTarget: 'symbol:repo-a:src/legacy.ts:10:80:Handler.run',
    };

    normalizeCompactDecisionEquivalence(
      decision,
      'resolved',
      'symbol:repo-a:src/current.ts:10:80:Handler.run',
      true,
    );

    expect(decision).toEqual({
      persistedResolutionStatus: 'unresolved',
      persistedTarget: 'symbol:repo-a:src/legacy.ts:10:80:Handler.run',
    });
  });

});

describe('compact differing target identity', () => {
  it('retains an effective target whose canonical node differs from the row', () => {
    const decision = projectObservationDecision({
      ordinal: 0,
      step: 1,
      type: 'local_symbol_call',
      source: { kind: 'symbol', symbolId: 1 },
      target: { kind: 'symbol', symbolId: 2 },
      status: 'resolved',
      confidence: 1,
      decision: {
        effectiveResolutionStatus: 'resolved',
        effectiveTarget: { kind: 'symbol', id: '3' },
      },
    }, {
      key: 'symbol\u00002',
      decisionTarget: 'symbol:repo:src/same.ts:10:20:Handler.run',
    }, () => ({
      key: 'symbol\u00003',
      decisionTarget: 'symbol:repo:src/same.ts:10:20:Handler.run',
    }));

    expect(decision).toEqual({
      effectiveTarget: 'symbol:repo:src/same.ts:10:20:Handler.run',
    });
  });
});

describe('compact equal target identity', () => {
  it('elides only an independently resolved canonical target identity', () => {
    const decision = projectObservationDecision({
      ordinal: 0,
      step: 1,
      type: 'local_symbol_call',
      source: { kind: 'symbol', symbolId: 1 },
      target: { kind: 'symbol', symbolId: 2 },
      status: 'resolved',
      confidence: 1,
      decision: {
        effectiveResolutionStatus: 'resolved',
        effectiveTarget: { kind: 'symbol', id: '2' },
      },
    }, {
      key: 'symbol\u00002',
      decisionTarget: 'symbol:repo:src/handler.ts:10:20:Handler.run',
    }, () => ({
      key: 'symbol\u00002',
      decisionTarget: 'symbol:repo:src/handler.ts:10:20:Handler.run',
    }));

    expect(decision).toEqual({});
  });
});

describe('compact persisted target identity', () => {
  it('elides the complete persisted tuple when raw and canonical values agree', () => {
    const label = 'db_entity:Orders';
    const decision = projectObservationDecision({
      ordinal: 0,
      step: 1,
      type: 'local_db_query',
      source: {
        kind: 'call_site',
        workspaceId: 1,
        repositoryId: 1,
        repositoryName: 'repo',
        sourceFile: 'src/handler.ts',
        sourceLine: 10,
        callId: 1,
      },
      target: {
        kind: 'target',
        workspaceId: 1,
        targetKind: 'db_entity',
        targetId: 'Orders',
      },
      status: 'terminal',
      confidence: 1,
      decision: {
        effectiveResolutionStatus: 'terminal',
        effectiveTarget: { kind: 'db_entity', id: 'Orders' },
        persistedResolutionStatus: 'terminal',
        persistedTarget: { kind: 'db_entity', id: 'Orders' },
      },
    }, {
      key: '["target",1,"repo","db_entity","Orders"]',
      decisionTarget: label,
    }, () => ({
      key: label,
      decisionTarget: label,
      projectedIdentity: true,
    }));

    expect(decision).toEqual({});
  });

  it('retains same-label persisted and effective targets with different identities', () => {
    const label = 'symbol:repo:src/same.ts:10:20:Handler.run';
    const decision = projectObservationDecision({
      ordinal: 0,
      step: 1,
      type: 'local_symbol_call',
      source: { kind: 'symbol', symbolId: 1 },
      target: { kind: 'symbol', symbolId: 2 },
      status: 'resolved',
      confidence: 1,
      decision: {
        effectiveResolutionStatus: 'resolved',
        effectiveTarget: { kind: 'symbol', id: '2' },
        persistedResolutionStatus: 'resolved',
        persistedTarget: { kind: 'symbol', id: '3' },
      },
    }, {
      key: 'symbol\u00002',
      decisionTarget: label,
    }, (value) => ({
      key: `symbol\u0000${value.id}`,
      decisionTarget: label,
    }));

    expect(decision).toEqual({
      persistedResolutionStatus: 'resolved',
      persistedTarget: label,
    });
  });
});

describe('compact actionability projections', () => {
  it('projects only multi-repository ambiguous implementation ties', () => {
    const evidence = {
      effectiveResolution: { status: 'ambiguous' },
      candidateCount: 3,
      candidates: [
        { accepted: true, methodId: 1, handlerPackage: { name: 'repo-c' } },
        { accepted: true, methodId: 2, handlerPackage: { name: 'repo-a' } },
        { accepted: true, methodId: 3, handlerPackage: { name: 'repo-b' } },
      ],
    };
    const input = compactDecisionFromEvidence(evidence);
    expect(projectCompactDecision(input).tiedCandidateRepos).toEqual({
      values: ['repo-a', 'repo-b', 'repo-c'],
      total: 3,
      shown: 3,
      omitted: 0,
    });
    expect(compactDecisionFromEvidence({
      ...evidence,
      effectiveResolution: { status: 'resolved' },
    }).tiedCandidateRepos).toBeUndefined();
    expect(compactDecisionFromEvidence({
      ...evidence,
      candidateCount: 1,
    }).tiedCandidateRepos).toBeUndefined();
    expect(compactDecisionFromEvidence({
      effectiveResolution: { status: 'ambiguous' },
      candidateCount: 2,
      candidates: [
        { accepted: true, methodId: 1, handlerPackage: { name: 'repo-a' } },
        { accepted: true, methodId: 2, handlerPackage: { name: 'repo-a' } },
      ],
    }).tiedCandidateRepos).toBeUndefined();
  });

  it('caps safe tied repositories and counts private omissions', () => {
    const repos = [
      'repo-f', 'repo-e', 'repo-d', 'repo-c', 'repo-b', 'repo-a',
      'PRIVATE_DESTINATION_SENTINEL',
    ];
    const input = compactDecisionFromEvidence({
      effectiveResolution: { status: 'ambiguous' },
      candidateCount: repos.length,
      candidates: repos.map((name, index) => ({
        accepted: true,
        methodId: index + 1,
        handlerPackage: { name },
      })),
    });

    expect(input.tiedCandidateRepos).toEqual({
      values: ['repo-a', 'repo-b', 'repo-c', 'repo-d', 'repo-e'],
      total: repos.length,
      shown: 5,
      omitted: 2,
    });
    expect(JSON.stringify(input)).not.toContain('PRIVATE_DESTINATION_SENTINEL');
  });

  it('projects bounded selector and invalid-fact summaries only for known codes', () => {
    const diagnostics = projectCompactDiagnostics([
      {
        severity: 'warning',
        code: 'trace_start_ambiguous',
        selectorKind: 'operation',
        selectorSuggestions: [
          '--repo repo-b --service /Svc --path /run',
          '--repo repo-a --service /Svc --path /run',
          '--repo PRIVATE_DESTINATION_SENTINEL',
        ],
        selectorSuggestionCount: 3,
      },
      {
        severity: 'error',
        code: 'reindex_required',
        invalidFactCategories: [
          { category: 'symbol_call_owner_invalid', count: 2 },
          { category: 'outbound_json_invalid', count: 1 },
        ],
        invalidFactCategoryCount: 2,
      },
      {
        severity: 'warning',
        code: 'trace_start_not_found',
        selectorKind: 'handler',
      },
      {
        severity: 'info',
        code: 'unknown_shape',
        selectorKind: 'handler',
        selectorSuggestions: ['--handler SafeHandler'],
        invalidFactCategories: [{ category: 'unsafe_injected', count: 1 }],
      },
    ]);
    const ambiguous = diagnostics.find((item) =>
      item.code === 'trace_start_ambiguous');
    const invalid = diagnostics.find((item) => item.code === 'reindex_required');
    const notFound = diagnostics.find((item) =>
      item.code === 'trace_start_not_found');
    const unknown = diagnostics.find((item) => item.code === 'unknown_shape');

    expect(ambiguous).toMatchObject({
      message: 'The trace start selector is ambiguous.',
      details: {
        selectorKind: 'operation',
        selectorSuggestions: {
          values: [
            '--repo repo-a --service /Svc --path /run',
            '--repo repo-b --service /Svc --path /run',
          ],
          total: 3,
          shown: 2,
          omitted: 1,
        },
      },
    });
    expect(invalid?.details?.invalidFactCategories).toEqual({
      values: ['outbound_json_invalid', 'symbol_call_owner_invalid'],
      total: 2,
      shown: 2,
      omitted: 0,
    });
    expect(notFound).toMatchObject({
      message: 'The trace start selector did not match an indexed start.',
      details: { selectorKind: 'handler' },
    });
    expect(unknown?.details).toBeUndefined();
    expect(JSON.stringify(diagnostics))
      .not.toContain('PRIVATE_DESTINATION_SENTINEL');
  });

  it('uses actionable implementation remediation with the accepted key names', () => {
    const edge = projectCompactDecision({
      remediationCode: 'select_implementation',
    });
    const diagnostic = projectCompactDiagnostics([{
      severity: 'warning',
      code: 'implementation_hint_mismatch',
      implementationHintSuggestions: [
        { implementationRepo: 'repo-b' },
        { implementationRepo: 'repo-a' },
      ],
      implementationHintSuggestionCount: 2,
    }])[0];
    for (const value of [
      'service', 'operation', 'package', 'repository', 'family', 'repo',
    ]) {
      expect(edge.remediationHint).toContain(value);
      expect(diagnostic?.details?.remediationHint).toContain(value);
    }
    expect(edge.remediationHint).toContain('repo is required');
    expect(diagnostic?.details?.tiedCandidateRepos).toEqual({
      values: ['repo-a', 'repo-b'],
      total: 2,
      shown: 2,
      omitted: 0,
    });
  });
});

describe('compact parser-warning reasons', () => {
  it('uses a non-sentinel code and the sentinel message through safe projection', () => {
    const explicit = projectCompactDecision(compactDecisionFromEvidence({
      parserWarning: {
        code: 'query_entity_unknown',
        message: 'PRIVATE_DESTINATION_SENTINEL',
      },
    }));
    const sentinel = projectCompactDecision(compactDecisionFromEvidence({
      parserWarning: {
        code: 'parser_warning',
        message: 'dynamic_entity_expression',
      },
    }));
    const unsafe = projectCompactDecision(compactDecisionFromEvidence({
      parserWarning: {
        code: 'parser_warning',
        message: 'private warning with spaces',
      },
    }));

    expect(explicit.reasonCode).toBe('query_entity_unknown');
    expect(sentinel.reasonCode).toBe('dynamic_entity_expression');
    expect(unsafe.reasonCode).toBeUndefined();
    expect(JSON.stringify([explicit, sentinel, unsafe]))
      .not.toContain('PRIVATE_DESTINATION_SENTINEL');
  });

  it('does not erase a parser-warning reason on terminal outbound rows', () => {
    const observations = new CompactObservationCollector();
    const recorder = new TraceEdgeRecorder([], observations);
    recordOutboundObservation(recorder, {
      step: 1,
      type: 'remote_query',
      from: 'source',
      to: 'target',
      evidence: {},
      confidence: 0.5,
    }, {
      call: {
        id: 1,
        repo_id: 1,
        repoName: 'repo',
        source_file: 'src/handler.ts',
        source_line: 1,
      },
      row: {
        to_kind: 'remote_entity',
        to_id: 'Records',
        status: 'resolved',
      },
      evidence: {
        parserWarning: {
          code: 'parser_warning',
          message: 'dynamic_entity_expression',
        },
      },
      workspaceId: 1,
    });

    expect(observations.observations[0]?.status).toBe('terminal');
    expect(projectCompactDecision(
      observations.observations[0]?.decision,
    ).reasonCode).toBe('dynamic_entity_expression');
  });

  it('uses safe parser warnings before the unresolved fallback', () => {
    const safe = outboundReasonDecision({
      code: 'parser_warning',
      message: 'dynamic_entity_expression',
    });
    const unsafe = outboundReasonDecision({
      code: 'parser_warning',
      message: 'Dynamic entity expression could not be resolved.',
    });

    expect(safe.reasonCode).toBe('dynamic_entity_expression');
    expect(unsafe.reasonCode).toBeUndefined();
  });
});

function outboundReasonDecision(
  parserWarning: Record<string, unknown>,
): CompactDecisionV1 {
  const observations = new CompactObservationCollector();
  const recorder = new TraceEdgeRecorder([], observations);
  recordOutboundObservation(recorder, {
    step: 1,
    type: 'remote_query',
    from: 'source',
    to: 'target',
    evidence: {},
    confidence: 0.5,
  }, {
    call: {
      id: 1,
      repo_id: 1,
      repoName: 'repo',
      source_file: 'src/handler.ts',
      source_line: 1,
    },
    row: {
      to_kind: 'operation_candidate',
      to_id: 'dynamic',
      status: 'unresolved',
    },
    evidence: { parserWarning },
    unresolvedReason: 'dynamic_entity_expression',
    workspaceId: 1,
  });
  return projectCompactDecision(observations.observations[0]?.decision);
}

describe('compact target projection safety', () => {
  it('never equates the same display label across canonical identities', () => {
    const decision: CompactDecisionV1 = {
      effectiveResolutionStatus: 'resolved',
      effectiveTarget: 'symbol:repo-a:src/a.ts:10:80:Handler.run',
    };

    normalizeCompactDecisionEquivalence(
      decision,
      'resolved',
      'symbol:repo-b:src/b.ts:10:80:Handler.run',
    );

    expect(decision).toEqual({
      effectiveTarget: 'symbol:repo-a:src/a.ts:10:80:Handler.run',
    });
  });

  it('does not invent target equivalence when projection is unavailable', () => {
    const decision: CompactDecisionV1 = {
      effectiveResolutionStatus: 'resolved',
      effectiveTarget: 'symbol:repo:src/handler.ts:10:80:Handler.run',
    };

    normalizeCompactDecisionEquivalence(decision, 'resolved', undefined);

    expect(decision).toEqual({
      effectiveTarget: 'symbol:repo:src/handler.ts:10:80:Handler.run',
    });
  });
});
