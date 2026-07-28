import type { TraceResult } from '../types.js';
export const DETAILED_TRACE_SCHEMA = 'service-flow/detailed-trace@2';
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function renderTraceJson(trace: TraceResult): string {
  const { edges, ...rest } = trace;
  return renderJson({
    schema: DETAILED_TRACE_SCHEMA,
    ...rest,
    edges: edges.map((edge) => {
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
