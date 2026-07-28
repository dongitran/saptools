import type { TraceResult } from '../types.js';
import { readableIdentifier } from './identifier-label.js';

function ambiguousLabel(
  idOrLabel: string,
  count: number,
): string {
  const readable = readableIdentifier(idOrLabel);
  return `${readable} [ambiguous node label: ${count} matches]`;
}

function label(
  trace: TraceResult,
  idOrLabel: string,
  nodeId?: string,
): string {
  const node = trace.nodes.find((item) => item.id === nodeId)
    ?? trace.nodes.find((item) => item.id === idOrLabel);
  if (node)
    return readableIdentifier(
      String(node.qualifiedLabel ?? node.label ?? idOrLabel),
    );
  const matches = trace.nodes.filter((item) => item.label === idOrLabel);
  if (matches.length > 1) return ambiguousLabel(idOrLabel, matches.length);
  const fallback = matches[0];
  return readableIdentifier(
    String(fallback?.qualifiedLabel ?? fallback?.label ?? idOrLabel),
  );
}
function edgeLabel(edge: TraceResult['edges'][number]): string {
  const basis = edge.evidence.selectionBasis;
  return typeof basis === 'string'
    ? `${edge.type} [basis=${basis}]`
    : edge.type;
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
      `  ${nodeId(e.fromNodeId ?? e.from)}["${label(trace, e.from, e.fromNodeId)}"] -->|${edgeLabel(e)}| ${nodeId(e.toNodeId ?? e.to)}["${label(trace, e.to, e.toNodeId)}"]`
    );
  return `${lines.join('\n')}\n`;
}
