import type { TraceResult } from '../types.js';
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function renderTraceJson(trace: TraceResult): string {
  return renderJson(trace);
}
