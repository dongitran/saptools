import type { TraceEdge } from '../types.js';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nodesByLabel(
  nodes: Map<string, Record<string, unknown>>,
): Map<string, Array<[string, Record<string, unknown>]>> {
  const grouped = new Map<
    string,
    Array<[string, Record<string, unknown>]>
  >();
  for (const entry of nodes) {
    const label = text(entry[1].label);
    if (!label) continue;
    grouped.set(label, [...(grouped.get(label) ?? []), entry]);
  }
  return grouped;
}

function retargetUniqueNode(
  nodes: Map<string, Record<string, unknown>>,
  target: string,
  candidates: Array<[string, Record<string, unknown>]> | undefined,
): boolean {
  if (candidates?.length !== 1 || !candidates[0]) return false;
  const [oldKey, node] = candidates[0];
  nodes.delete(oldKey);
  nodes.set(target, { ...node, id: target });
  return true;
}

export function closeTraceEdgeTargets(
  nodes: Map<string, Record<string, unknown>>,
  edges: TraceEdge[],
): void {
  const ids = new Set([...nodes.values()].flatMap((node) => {
    const id = text(node.id);
    return id ? [id] : [];
  }));
  const labels = nodesByLabel(nodes);
  for (const edge of edges) {
    if (ids.has(edge.to)) continue;
    if (retargetUniqueNode(nodes, edge.to, labels.get(edge.to))) {
      ids.add(edge.to);
      continue;
    }
    nodes.set(edge.to, {
      id: edge.to,
      kind: 'unresolved_target',
      label: edge.to,
      unresolved: true,
    });
    ids.add(edge.to);
  }
}
