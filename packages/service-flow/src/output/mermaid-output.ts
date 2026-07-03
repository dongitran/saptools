import type { TraceResult } from '../types.js';
function safe(value: string): string {
  return value.replace(/[^\w-]/g, '_').slice(0, 60);
}
function label(trace: TraceResult, idOrLabel: string): string {
  const node = trace.nodes.find((item) => item.id === idOrLabel || item.label === idOrLabel);
  return String(node?.label ?? idOrLabel);
}
export function renderMermaid(trace: TraceResult): string {
  const lines = ['flowchart TD'];
  for (const e of trace.edges)
    lines.push(
      `  ${safe(e.from)}["${label(trace, e.from)}"] -->|${e.type}| ${safe(e.to)}["${label(trace, e.to)}"]`
    );
  return `${lines.join('\n')}\n`;
}
