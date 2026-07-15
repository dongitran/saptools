import { describe, expect, it } from 'vitest';
import type { TraceEdge, TraceResult } from '../../src/types.js';
import { renderTraceJson } from '../../src/output/json-output.js';
import { renderMermaid } from '../../src/output/mermaid-output.js';
import { renderTraceTable } from '../../src/output/table-output.js';

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

  it('does not mutate table or JSON rendering', () => {
    const result = trace([
      edge(1, 'neutral-source', 'neutral-target'),
    ]);
    const tableBefore = renderTraceTable(result);
    const jsonBefore = renderTraceJson(result);

    renderMermaid(result);

    expect(renderTraceTable(result)).toBe(tableBefore);
    expect(renderTraceJson(result)).toBe(jsonBefore);
    expect(JSON.parse(jsonBefore) as unknown).toEqual(result);
  });
});
