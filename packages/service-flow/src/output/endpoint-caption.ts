import type { TraceResult } from '../types.js';
import { readableIdentifier } from './identifier-label.js';

function nodeCaption(
  node: Record<string, unknown>,
  fallback: string,
): string {
  return readableIdentifier(
    String(node.qualifiedLabel ?? node.label ?? fallback),
  );
}

function labelMatches(
  trace: TraceResult,
  label: string,
): Array<Record<string, unknown>> {
  return trace.nodes.filter((node) =>
    node.label === label
    || (Array.isArray(node.aliases) && node.aliases.includes(label)));
}

export function endpointCaption(
  trace: TraceResult,
  idOrLabel: string,
  nodeId?: string,
): string {
  const byId = trace.nodes.find((node) => node.id === nodeId)
    ?? trace.nodes.find((node) => node.id === idOrLabel);
  if (byId) return nodeCaption(byId, idOrLabel);
  const matches = labelMatches(trace, idOrLabel);
  if (matches.length > 1)
    return `${readableIdentifier(idOrLabel)} [ambiguous node label: ${
      matches.length} matches]`;
  return matches[0]
    ? nodeCaption(matches[0], idOrLabel)
    : readableIdentifier(idOrLabel);
}
