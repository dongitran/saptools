import type { TraceResult } from '../types.js';
import { endpointCaption } from './endpoint-caption.js';

function mermaidText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n]+/g, ' ');
}

function edgeLabel(edge: TraceResult['edges'][number]): string {
  const basis = edge.evidence.selectionBasis;
  return mermaidText(typeof basis === 'string'
    ? `${edge.type} [basis=${basis}]`
    : edge.type);
}
export function renderMermaid(trace: TraceResult): string {
  const ids = new Map<string, string>();
  const nodeId = (value: string): string => {
    const existing = ids.get(value);
    if (existing) return existing;
    const id = `n${ids.size}`;
    ids.set(value, id);
    return id;
  };
  const lines = ['flowchart TD'];
  for (const e of trace.edges)
    lines.push(
      `  ${nodeId(e.fromNodeId ?? e.from)}["${mermaidText(
        endpointCaption(trace, e.from, e.fromNodeId),
      )}"] -->|${edgeLabel(e)}| ${nodeId(e.toNodeId ?? e.to)}["${mermaidText(
        endpointCaption(trace, e.to, e.toNodeId),
      )}"]`,
    );
  return `${lines.join('\n')}\n`;
}
