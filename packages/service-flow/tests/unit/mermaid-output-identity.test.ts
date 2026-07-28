import { describe, expect, it } from 'vitest';
import type { TraceEdge, TraceResult } from '../../src/types.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { readableIdentifier } from '../../src/output/identifier-label.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';
import { closeTraceEdgeEndpoints } from
  '../../src/trace/trace-node-closure.js';

interface RenderedEndpoint {
  id: string;
  label: string;
}

function edge(step: number, from: string, to: string): TraceEdge {
  return { step, type: `edge_${step}`, from, to, evidence: {}, confidence: 1 };
}

function trace(edges: TraceEdge[], nodes: Array<Record<string, unknown>> = []): TraceResult {
  return { start: {}, nodes, edges, diagnostics: [] };
}

function renderedEndpoints(output: string): RenderedEndpoint[] {
  const edgeLine = /^\s+([\w-]+)\["([^"]*)"\] -->\|[^|]+\| ([\w-]+)\["([^"]*)"\]$/;
  return output.split('\n').flatMap((line) => {
    const match = edgeLine.exec(line);
    if (!match) return [];
    return [
      { id: String(match[1]), label: String(match[2]) },
      { id: String(match[3]), label: String(match[4]) },
    ];
  });
}

describe('Mermaid node identity', () => {
  it('keeps long node strings with a shared 60-character prefix distinct', () => {
    const prefix = 'pkg/very/long/shared/path/prefix/exceeding/sixty/characters/NeutralHelper.';
    const first = `${prefix}alpha`;
    const second = `${prefix}beta`;
    const endpoints = renderedEndpoints(renderMermaid(trace([
      edge(1, first, 'terminal:first'),
      edge(2, second, 'terminal:second'),
    ])));

    expect(prefix.length).toBeGreaterThan(60);
    expect(first.slice(0, 60)).toBe(second.slice(0, 60));
    expect(endpoints.find((endpoint) => endpoint.label === first)?.id).toBeDefined();
    expect(endpoints.find((endpoint) => endpoint.label === second)?.id).toBeDefined();
    expect(endpoints.find((endpoint) => endpoint.label === first)?.id)
      .not.toBe(endpoints.find((endpoint) => endpoint.label === second)?.id);
  });

  it('reuses one deterministic id when a node changes edge position', () => {
    const result = trace([
      edge(1, 'A', 'B'),
      edge(2, 'B', 'C'),
    ]);
    const firstRender = renderMermaid(result);
    const sharedIds = renderedEndpoints(firstRender)
      .filter((endpoint) => endpoint.label === 'B')
      .map((endpoint) => endpoint.id);

    expect(sharedIds).toHaveLength(2);
    expect(new Set(sharedIds).size).toBe(1);
    expect(renderMermaid(result)).toBe(firstRender);
  });

  it('renders as many distinct ids as full endpoint strings', () => {
    const prefix = 'pkg/another/neutral/shared/path/that/is/longer/than/sixty/characters/Worker.';
    const result = trace([
      edge(1, `${prefix}one`, 'short-a'),
      edge(2, `${prefix}two`, 'short-b'),
      edge(3, 'short-b', 'short-c'),
    ]);
    const output = renderMermaid(result);
    const originalIds = new Set(result.edges.flatMap((item) => [item.from, item.to]));
    const renderedIds = new Set(renderedEndpoints(output)
      .map((endpoint) => endpoint.id));
    const shortIds = renderedEndpoints(output)
      .filter((endpoint) => endpoint.label === 'short-a' || endpoint.label === 'short-b')
      .map((endpoint) => endpoint.id);
    const renderedTypes = [...output.matchAll(/-->\|([^|]+)\|/g)]
      .map((match) => String(match[1]));

    expect(renderedIds.size).toBe(originalIds.size);
    expect(new Set(shortIds).size).toBe(2);
    expect(renderedTypes).toEqual(result.edges.map((item) => item.type));
  });

  it('keeps node lookup labels unchanged', () => {
    const result = trace(
      [edge(1, 'source-id', 'target-id')],
      [
        { id: 'source-id', label: 'Full neutral source label' },
        { id: 'target-id', label: 'Full neutral target label' },
      ],
    );
    const labels = renderedEndpoints(renderMermaid(result))
      .map((endpoint) => endpoint.label);

    expect(labels).toEqual(['Full neutral source label', 'Full neutral target label']);
  });

  it('resolves canonical ids before a colliding earlier label', () => {
    const result = trace(
      [{
        ...edge(1, 'source-id', 'Shared target'),
        fromNodeId: 'source-id',
        toNodeId: 'target-b',
      }],
      [
        { id: 'source-id', label: 'Source', qualifiedLabel: 'repo:Source' },
        {
          id: 'target-a',
          label: 'Shared target',
          qualifiedLabel: 'repo-a:Shared target',
        },
        {
          id: 'target-b',
          label: 'Shared target',
          qualifiedLabel: 'repo-b:Shared target',
        },
      ],
    );
    const mermaid = renderMermaid(result);
    const table = renderTraceTable(result);

    expect(mermaid).toContain('repo-b:Shared target');
    expect(table).toContain('repo-b:Shared target');
    expect(mermaid).not.toContain('repo-a:Shared target');
  });

  it('discloses an ambiguous label-only fallback', () => {
    const result = trace(
      [edge(1, 'source', 'Shared target')],
      [
        { id: 'target-a', label: 'Shared target' },
        { id: 'target-b', label: 'Shared target' },
      ],
    );
    expect(renderMermaid(result)).toContain(
      'Shared target [ambiguous node label: 2 matches]',
    );
    expect(renderTraceTable(result)).toContain(
      'Shared target [ambiguous node label: 2 matches]',
    );
  });

  it('escapes quoted Mermaid labels and edge types', () => {
    const result = trace([
      {
        ...edge(1, 'source "quoted"', 'target'),
        type: 'edge|quoted',
      },
    ]);
    const output = renderMermaid(result);

    expect(output).toContain('source &quot;quoted&quot;');
    expect(output).toContain('edge&#124;quoted');
    expect(output).not.toContain('["source "quoted""]');
  });

  it('renders structural scope ids readably in every format', () => {
    const raw = '[1,26,["srv/events/Neutral.ts"],[5161]]';
    const result = trace([edge(1, 'source', raw)]);
    const nodes = new Map(result.nodes.map((node) =>
      [String(node.id), node]));
    closeTraceEdgeEndpoints(nodes, result.edges);
    result.nodes = [...nodes.values()];

    const expected = 'scope:1/26/srv/events/Neutral.ts#5161';
    expect(renderTraceTable(result)).toContain(expected);
    expect(renderMermaid(result)).toContain(expected);
    expect(renderTraceJson(result)).toContain(expected);
    expect(renderTraceJson(result)).not.toContain(raw);
  });

  it('keeps escaped and empty structural scopes injective', () => {
    const values = [
      '[1,2,[],[]]',
      '[1,2,[""],[]]',
      '[1,2,["%"],[3]]',
      '[1,2,["("],[3]]',
      '[1,2,[")"],[3]]',
      '[1,2,[","],[3]]',
      '[1,2,["#"],[3]]',
    ].map(readableIdentifier);

    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([
      'scope:1/2/0()#0()',
      'scope:1/2/#0()',
      'scope:1/2/%25#3',
      'scope:1/2/%28#3',
      'scope:1/2/%29#3',
      'scope:1/2/%2C#3',
      'scope:1/2/%23#3',
    ]);
  });

  it('does not mutate table or JSON rendering', () => {
    const result = trace([
      edge(1, 'neutral-source', 'neutral-target'),
    ]);
    const resultBefore = JSON.stringify(result);
    const tableBefore = renderTraceTable(result);
    const jsonBefore = renderTraceJson(result);

    renderMermaid(result);

    expect(renderTraceTable(result)).toBe(tableBefore);
    expect(renderTraceJson(result)).toBe(jsonBefore);
    expect(JSON.stringify(result)).toBe(resultBefore);
    expect(JSON.parse(jsonBefore)).toMatchObject({
      schema: 'service-flow/detailed-trace@2',
      edges: [{
        from: 'neutral-source',
        to: 'neutral-target',
        fromLabel: 'neutral-source',
        toLabel: 'neutral-target',
      }],
    });
  });
});
