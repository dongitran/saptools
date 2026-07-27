import { describe, expect, it } from 'vitest';
import type { TraceEdge } from '../../src/types.js';
import { closeTraceEdgeTargets } from
  '../../src/trace/trace-node-closure.js';

function edge(type: string, to: string): TraceEdge {
  return {
    step: 1,
    type,
    from: 'source',
    to,
    evidence: {},
    confidence: 0.8,
  };
}

describe('rendered trace target closure', () => {
  it('keeps stable semantic targets and registers every edge target', () => {
    const nodes = new Map<string, Record<string, unknown>>([
      ['symbol:17', {
        id: 'symbol:17',
        kind: 'symbol',
        label: 'repo-a:Handler.run',
      }],
      ['operation:29', {
        id: 'operation:29',
        kind: 'operation',
        label: '/TargetService/execute',
      }],
    ]);
    const edges = [
      edge('local_symbol_call', 'repo-a:Handler.run'),
      edge('remote_action', '/TargetService/execute'),
      edge('local_db_query', 'Entity: Records'),
      edge('event_shape_candidate_subscriber',
        'repo-b:src/Subscriber.ts:Subscriber.handle'),
    ];

    closeTraceEdgeTargets(nodes, edges);

    const nodeIds = new Set([...nodes.values()].map((node) => node.id));
    expect(edges.map((item) => item.to)).toEqual([
      'repo-a:Handler.run',
      '/TargetService/execute',
      'Entity: Records',
      'repo-b:src/Subscriber.ts:Subscriber.handle',
    ]);
    expect(edges.every((item) => nodeIds.has(item.to))).toBe(true);
    expect(nodes.get('Entity: Records')).toMatchObject({
      kind: 'unresolved_target',
      unresolved: true,
    });
  });
});
