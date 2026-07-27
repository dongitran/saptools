import type { TraceEdge } from '../types.js';

type NodeEntry = [string, Record<string, unknown>];
type EndpointSide = 'from' | 'to';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nodesByLabel(
  nodes: Map<string, Record<string, unknown>>,
): Map<string, NodeEntry[]> {
  const grouped = new Map<string, NodeEntry[]>();
  for (const entry of nodes) {
    const labels = [
      text(entry[1].label),
      ...(Array.isArray(entry[1].aliases)
        ? entry[1].aliases.filter(
            (item): item is string => typeof item === 'string',
          ) : []),
    ].filter((item): item is string => Boolean(item));
    for (const label of labels)
      grouped.set(label, [...(grouped.get(label) ?? []), entry]);
  }
  return grouped;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function evidenceRepository(
  evidence: Record<string, unknown>,
): string | undefined {
  const selected = record(evidence.selectedHandler);
  const selectedRepository = record(selected.repository);
  return text(
    evidence.subscriptionConsumerRepositoryName
      ?? evidence.subscriptionRepositoryName
      ?? evidence.repositoryName
      ?? evidence.repoName
      ?? evidence.targetRepo
      ?? selectedRepository.name,
  );
}

function candidateId(
  candidates: NodeEntry[] | undefined,
  repository: string | undefined,
): string | undefined {
  if (candidates?.length === 1) return text(candidates[0]?.[1].id);
  if (!repository) return undefined;
  const scoped = candidates?.filter(([, node]) =>
    text(node.repoName ?? node.repo) === repository);
  return scoped?.length === 1 ? text(scoped[0]?.[1].id) : undefined;
}

function qualifiedLabel(label: string, repository: string | undefined): string {
  return repository && !label.startsWith(`${repository}:`)
    ? `${repository}:${label}` : label;
}

function syntheticEndpoint(
  nodes: Map<string, Record<string, unknown>>,
  side: EndpointSide,
  label: string,
  repository: string | undefined,
  ordinal: number,
): string {
  const scope = repository ?? `repository_unavailable:${ordinal}`;
  const id = `unresolved_${side}:${scope}:${label}`;
  nodes.set(id, {
    id,
    kind: `unresolved_${side}`,
    label: qualifiedLabel(label, repository),
    repoName: repository ?? 'repository_unavailable',
    repositoryStatus: repository ? 'attributed' : 'unavailable',
    unresolved: true,
  });
  return id;
}

function closeEndpoint(
  nodes: Map<string, Record<string, unknown>>,
  labels: ReadonlyMap<string, NodeEntry[]>,
  ids: Set<string>,
  edge: TraceEdge,
  side: EndpointSide,
  ordinal: number,
): void {
  const explicit = side === 'from' ? edge.fromNodeId : edge.toNodeId;
  if (explicit && ids.has(explicit)) return;
  const endpoint = edge[side];
  if (ids.has(endpoint)) {
    if (side === 'from') edge.fromNodeId = endpoint;
    else edge.toNodeId = endpoint;
    return;
  }
  const repository = evidenceRepository(edge.evidence);
  const existing = candidateId(labels.get(endpoint), repository);
  const id = existing ?? syntheticEndpoint(
    nodes, side, endpoint, repository, ordinal,
  );
  if (side === 'from') edge.fromNodeId = id;
  else edge.toNodeId = id;
  ids.add(id);
}

export function closeTraceEdgeEndpoints(
  nodes: Map<string, Record<string, unknown>>,
  edges: TraceEdge[],
): void {
  const ids = new Set([...nodes.values()].flatMap((node) => {
    const id = text(node.id);
    return id ? [id] : [];
  }));
  const labels = nodesByLabel(nodes);
  edges.forEach((edge, index) => {
    closeEndpoint(nodes, labels, ids, edge, 'from', index);
    closeEndpoint(nodes, labels, ids, edge, 'to', index);
  });
}
