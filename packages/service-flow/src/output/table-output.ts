import type { TraceResult } from '../types.js';
import { startLabel } from '../trace/selectors.js';
export function renderTraceTable(trace: TraceResult): string { const lines = [`Start: ${startLabel(trace.start)}`, '', 'Step  Type                 From                                To                                  Evidence']; for (const e of trace.edges) lines.push(`${String(e.step).padEnd(5)} ${e.type.padEnd(20)} ${e.from.slice(0,34).padEnd(35)} ${e.to.slice(0,35).padEnd(36)} ${String(e.evidence.file ?? '')}:${String(e.evidence.line ?? '')}`); return `${lines.join('\n')}\n`; }
