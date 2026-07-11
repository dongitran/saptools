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
    if (e.unresolvedReason)
      lines.push(...hintLines(e.evidence).map((hint) => `      ${hint}`));
  }
  if (result.diagnostics.length > 0) lines.push('', 'Diagnostics:', ...result.diagnostics.flatMap(diagnosticLines));
  return `${lines.join('\n')}\n`;
}

function diagnosticLines(diagnostic: Record<string, unknown>): string[] {
  const first = `${String(diagnostic.severity ?? 'info')} ${String(diagnostic.code ?? 'diagnostic')} ${String(diagnostic.message ?? '')}`;
  const details = diagnosticDetailLines(diagnostic);
  return [first, ...[...details, ...hintLines(diagnostic)]
    .map((hint) => `  ${hint}`)];
}

function diagnosticDetailLines(diagnostic: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (diagnostic.sourceFile || diagnostic.sourceLine)
    lines.push(`at ${String(diagnostic.sourceFile ?? '')}:${String(diagnostic.sourceLine ?? '')}`);
  const unsupported = stringList(diagnostic.unsupportedDecoratorNames);
  const observed = stringList(diagnostic.observedDecoratorNames);
  if (unsupported.length > 0)
    lines.push(`unsupported decorators: ${unsupported.join(', ')}`);
  else if (observed.length > 0)
    lines.push(`observed decorators: ${observed.join(', ')}`);
  if (typeof diagnostic.remediation === 'string')
    lines.push(`hint: ${diagnostic.remediation}`);
  return lines;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function hintLines(evidence: Record<string, unknown>): string[] {
  const dynamicLines = dynamicHintLines(evidence);
  const suggestions = evidence.implementationHintSuggestions;
  if (!Array.isArray(suggestions)) return dynamicLines;
  const hints = suggestions.flatMap((item) =>
    isRecord(item) && typeof item.cli === 'string'
      ? [item.cli]
      : []);
  const unique = [...new Set(hints)];
  const shown = unique.slice(0, 3).map((hint) => `try ${hint}`);
  const omitted = numberValue(evidence.omittedImplementationHintSuggestionCount);
  const remaining = Math.max(0, unique.length - shown.length) + omitted;
  if (remaining > 0)
    shown.push(`... ${remaining} additional hint(s) omitted; use a scoped --implementation-hint`);
  return [...dynamicLines, ...shown];
}

function dynamicHintLines(evidence: Record<string, unknown>): string[] {
  const exploration = isRecord(evidence.dynamicTargetExploration)
    ? evidence.dynamicTargetExploration
    : evidence;
  const count = numberValue(exploration.candidateCount);
  if (count === 0) return [];
  const shown = numberValue(exploration.shownCandidateCount);
  const omitted = numberValue(exploration.omittedCandidateCount);
  const rejected = numberValue(exploration.rejectedCandidateCount);
  const lines = [
    `viable candidates: ${shown} shown, ${omitted} omitted; rejected: ${rejected}`,
  ];
  lines.push(...varSetHints(exploration.suggestedVarSets));
  if (omitted > 0 || rejected > 0 || shown < count)
    lines.push('use --dynamic-mode candidates --max-dynamic-candidates 20 to explore candidate branches');
  return lines;
}

function varSetHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hints = value.flatMap((item) =>
    isRecord(item) && typeof item.cli === 'string' ? [`try ${item.cli}`] : []);
  return [...new Set(hints)].slice(0, 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
