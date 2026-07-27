import type { TraceResult } from '../types.js';
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function renderTraceJson(trace: TraceResult): string {
  return renderJson({
    ...trace,
    edges: trace.edges.map((edge) => {
      const {
        fromNodeId,
        toNodeId,
        ...rest
      } = edge;
      return {
        ...rest,
        from: fromNodeId ?? edge.from,
        to: toNodeId ?? edge.to,
        fromLabel: edge.from,
        toLabel: edge.to,
      };
    }),
  });
}
