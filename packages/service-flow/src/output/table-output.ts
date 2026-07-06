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
export function renderTraceTable(result: TraceResult): string {
  const lines = ['Step  Type                 From                                To                                  Evidence'];
  for (const e of result.edges) {
    lines.push(`${String(e.step).padEnd(5)} ${e.type.padEnd(20)} ${e.from.slice(0, 34).padEnd(35)} ${e.to.slice(0, 35).padEnd(36)} ${location(e.evidence)}`);
    const hint = firstHint(e.evidence);
    if (e.unresolvedReason && hint) lines.push(`      try ${hint}`);
  }
  if (result.diagnostics.length > 0) lines.push('', 'Diagnostics:', ...result.diagnostics.flatMap(diagnosticLines));
  return `${lines.join('\n')}\n`;
}

function diagnosticLines(diagnostic: Record<string, unknown>): string[] {
  const first = `${String(diagnostic.severity ?? 'info')} ${String(diagnostic.code ?? 'diagnostic')} ${String(diagnostic.message ?? '')}`;
  const hint = firstHint(diagnostic);
  return hint ? [first, `  try ${hint}`] : [first];
}

function firstHint(evidence: Record<string, unknown>): string | undefined {
  const suggestions = evidence.implementationHintSuggestions;
  if (!Array.isArray(suggestions)) return undefined;
  const first = suggestions.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  return typeof first?.cli === 'string' ? first.cli : undefined;
}
