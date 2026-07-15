import type { TraceResult } from '../types.js';
function label(trace: TraceResult, idOrLabel: string): string {
  const node = trace.nodes.find((item) => item.id === idOrLabel || item.label === idOrLabel);
  return String(node?.label ?? idOrLabel);
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
      `  ${nodeId(e.from)}["${label(trace, e.from)}"] -->|${e.type}| ${nodeId(e.to)}["${label(trace, e.to)}"]`
    );
  return `${lines.join('\n')}\n`;
}
