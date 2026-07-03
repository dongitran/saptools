import type { TraceEdge } from '../types.js';
export function limitDepth(edges: TraceEdge[], depth: number): TraceEdge[] { return edges.filter((edge) => edge.step <= depth); }
