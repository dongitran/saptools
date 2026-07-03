import type { TraceResult } from '../types.js';
function safe(value: string): string { return value.replace(/[^\w-]/g, '_').slice(0, 60); }
export function renderMermaid(trace: TraceResult): string { const lines = ['flowchart TD']; for (const e of trace.edges) lines.push(`  ${safe(e.from)}["${e.from}"] -->|${e.type}| ${safe(e.to)}["${e.to}"]`); return `${lines.join('\n')}\n`; }
