import type { TraceResult } from '../types.js';
import { endpointCaption } from './endpoint-caption.js';
export const DETAILED_TRACE_SCHEMA = 'service-flow/detailed-trace@3';
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
      const fromCaption = endpointCaption(trace, edge.from, fromNodeId);
      const toCaption = endpointCaption(trace, edge.to, toNodeId);
      return {
        ...rest,
        from: fromNodeId ?? edge.from,
        to: toNodeId ?? edge.to,
        fromLabel: fromCaption.caption,
        toLabel: toCaption.caption,
        ...(fromCaption.ambiguousMatches === undefined ? {} : {
          fromLabelAmbiguousMatches: fromCaption.ambiguousMatches,
        }),
        ...(toCaption.ambiguousMatches === undefined ? {} : {
          toLabelAmbiguousMatches: toCaption.ambiguousMatches,
        }),
      };
    }),
  });
}
