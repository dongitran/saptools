import type { TraceResult } from '../types.js';

function location(evidence: Record<string, unknown>): string {
  const file = evidence.file ?? evidence.sourceFile ?? evidence.handlerSourceFile ?? evidence.operationSourceFile ?? evidence.registrationSourceFile;
  const line = evidence.line ?? evidence.sourceLine ?? evidence.handlerSourceLine ?? evidence.operationSourceLine ?? evidence.registrationSourceLine;
  if (file || line) return `${String(file ?? '')}:${String(line ?? '')}`;
  const candidates = evidence.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0] as Record<string, unknown>;
    return `${String(first.sourceFile ?? '')}:${String(first.sourceLine ?? '')}`;
  }
  return ':';
}
function displayTarget(value: string, evidence: Record<string, unknown>): string {
  if (/^\d+$/.test(value) && evidence.parserWarning) return 'Entity: unknown';
  return value;
}
export function renderTraceTable(result: TraceResult): string {
  const lines = ['Step  Type                 From                                To                                  Evidence'];
  for (const e of result.edges) {
    lines.push(`${String(e.step).padEnd(5)} ${e.type.padEnd(20)} ${e.from.slice(0, 34).padEnd(35)} ${displayTarget(e.to, e.evidence).slice(0, 35).padEnd(36)} ${location(e.evidence)}`);
  }
  if (result.diagnostics.length > 0) lines.push('', 'Diagnostics:', ...result.diagnostics.map((d) => `${String(d.severity ?? 'info')} ${String(d.code ?? 'diagnostic')} ${String(d.message ?? '')}`));
  return `${lines.join('\n')}\n`;
}
