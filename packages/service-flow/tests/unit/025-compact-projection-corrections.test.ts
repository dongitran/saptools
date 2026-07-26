import { describe, expect, it } from 'vitest';
import type { CompactDecisionV1 } from '../../src/trace/014-compact-contract.js';
import {
  compactMissingRemediation,
  isSafeCompactMissingName,
  normalizeCompactDecisionEquivalence,
  projectCompactMissingNames,
} from '../../src/trace/021-compact-decision-normalization.js';
import {
  projectCompactDecision,
  projectCompactDiagnostics,
} from '../../src/trace/020-compact-field-projection.js';
import { projectObservationDecision } from
  '../../src/trace/024-compact-observation-decision.js';

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
