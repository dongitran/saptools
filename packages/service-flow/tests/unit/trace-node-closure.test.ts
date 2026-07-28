import { describe, expect, it } from 'vitest';
import { renderTraceJson } from '../../src/output/json-output.js';
import type { TraceEdge } from '../../src/types.js';
import { closeTraceEdgeEndpoints } from
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

    closeTraceEdgeEndpoints(nodes, edges);

    const nodeIds = new Set([...nodes.values()].map((node) => node.id));
    expect(edges.map((item) => item.toNodeId)).toEqual([
      'symbol:17',
      'operation:29',
      'unresolved_endpoint:repository_unavailable:Entity: Records',
      'unresolved_endpoint:repository_unavailable:repo-b:src/Subscriber.ts:Subscriber.handle',
    ]);
    expect(edges.every((item) => nodeIds.has(item.fromNodeId))).toBe(true);
    expect(edges.every((item) => nodeIds.has(item.toNodeId))).toBe(true);
    expect(nodes.get(
      'unresolved_endpoint:repository_unavailable:Entity: Records',
    )).toMatchObject({
      kind: 'unresolved_endpoint',
      repoName: 'repository_unavailable',
      unresolved: true,
    });
  });

  it('renders every JSON endpoint as a registered node id', () => {
    const nodes = new Map<string, Record<string, unknown>>([
      ['source:1', { id: 'source:1', kind: 'symbol', label: 'source' }],
      ['target:1', { id: 'target:1', kind: 'symbol', label: 'target' }],
    ]);
    const edges = [edge('local_symbol_call', 'target')];
    closeTraceEdgeEndpoints(nodes, edges);
    const rendered = JSON.parse(renderTraceJson({
      start: {},
      nodes: [...nodes.values()],
      edges,
      diagnostics: [],
    })) as {
      nodes: Array<{ id?: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const ids = new Set(rendered.nodes.map((node) => node.id));
    expect(rendered.edges.every((item) =>
      ids.has(item.from) && ids.has(item.to))).toBe(true);
  });

  it('keeps equal unresolved labels distinct across repositories', () => {
    const nodes = new Map<string, Record<string, unknown>>([
      ['source:1', { id: 'source:1', kind: 'symbol', label: 'source' }],
    ]);
    const first = edge('event_shape_candidate_subscriber', 'Handler.run');
    first.evidence = { subscriptionRepositoryName: 'repo-a' };
    const second = edge('event_shape_candidate_subscriber', 'Handler.run');
    second.evidence = { subscriptionRepositoryName: 'repo-b' };

    closeTraceEdgeEndpoints(nodes, [first, second]);

    expect(first.toNodeId).toBe('unresolved_endpoint:repo-a:Handler.run');
    expect(second.toNodeId).toBe('unresolved_endpoint:repo-b:Handler.run');
    expect(first.toNodeId).not.toBe(second.toNodeId);
    expect(nodes.get(String(first.toNodeId))).toMatchObject({
      label: 'repo-a:Handler.run',
      repoName: 'repo-a',
    });
    expect(nodes.get(String(second.toNodeId))).toMatchObject({
      label: 'repo-b:Handler.run',
      repoName: 'repo-b',
    });
  });

  it('deduplicates synthetic nodes by their structural scope', () => {
    const scope = '[1,26,["srv/events/Handler.ts"],[5161]]';
    const nodes = new Map<string, Record<string, unknown>>([
      ['source:1', { id: 'source:1', kind: 'symbol', label: 'source' }],
    ]);
    const first = edge('local_symbol_call', scope);
    const second = edge('local_symbol_call', scope);

    closeTraceEdgeEndpoints(nodes, [first, second]);

    expect(first.to).toBe('scope:1/26/srv/events/Handler.ts#5161');
    expect(first.toNodeId).toBe(second.toNodeId);
    expect([...nodes.values()].filter((node) =>
      node.kind === 'unresolved_endpoint')).toHaveLength(1);
  });
});
