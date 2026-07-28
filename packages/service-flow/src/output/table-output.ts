import type { TraceResult } from '../types.js';
import { endpointCaption } from './endpoint-caption.js';

function location(evidence: Record<string, unknown>): string {
  const selected = isRecord(evidence.selectedHandler)
    ? evidence.selectedHandler : undefined;
  const selectedFile = selected?.sourceFile;
  const selectedLine = selected?.sourceLine;
  if (selectedFile || selectedLine)
    return `${String(selectedFile ?? '')}:${String(selectedLine ?? '')}`;
  const file = evidence.file ?? evidence.sourceFile ?? evidence.handlerSourceFile ?? evidence.operationSourceFile ?? evidence.registrationSourceFile;
  const line = evidence.line ?? evidence.sourceLine ?? evidence.handlerSourceLine ?? evidence.operationSourceLine ?? evidence.registrationSourceLine;
  if (file || line) return `${String(file ?? '')}:${String(line ?? '')}`;
  const candidates = evidence.candidates;
  if (Array.isArray(candidates) && candidates.some((candidate) =>
    isRecord(candidate) && candidate.methodId !== undefined)) return ':';
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates.find(isRecord);
    if (first)
      return `${String(first.sourceFile ?? '')}:${String(first.sourceLine ?? '')}`;
  }
  return ':';
}
export function renderTraceTable(result: TraceResult): string {
  const rows = result.edges.map((edge) => ({
    edge,
    from: nodeLabel(result, edge.from, edge.fromNodeId),
    to: nodeLabel(result, edge.to, edge.toNodeId),
  }));
  const widths = {
    step: Math.max(4, ...rows.map(({ edge }) => String(edge.step).length)),
    type: Math.max(4, ...rows.map(({ edge }) => edge.type.length)),
    from: Math.max(4, ...rows.map((row) => row.from.length)),
    to: Math.max(2, ...rows.map((row) => row.to.length)),
  };
  const lines = [
    `${'Step'.padEnd(widths.step)}  ${'Type'.padEnd(widths.type)}  ${
      'From'.padEnd(widths.from)}  ${'To'.padEnd(widths.to)}  Evidence`,
  ];
  for (const { edge, from, to } of rows) {
    lines.push(`${String(edge.step).padEnd(widths.step)}  ${
      edge.type.padEnd(widths.type)}  ${from.padEnd(widths.from)}  ${
      to.padEnd(widths.to)}  ${evidenceSummary(edge.evidence)}`);
    if (edge.unresolvedReason)
      lines.push(...hintLines(edge.evidence).map((hint) => `      ${hint}`));
  }
  if (result.diagnostics.length > 0) lines.push('', 'Diagnostics:', ...result.diagnostics.flatMap(diagnosticLines));
  return `${lines.join('\n')}\n`;
}

function nodeLabel(
  result: TraceResult,
  label: string,
  nodeId: string | undefined,
): string {
  return endpointCaption(result, label, nodeId);
}

function evidenceSummary(evidence: Record<string, unknown>): string {
  const labels = [
    typeof evidence.dispatchScope === 'string'
      ? `scope=${evidence.dispatchScope}` : undefined,
    typeof evidence.dispatchCertainty === 'string'
      ? `certainty=${evidence.dispatchCertainty}` : undefined,
    typeof evidence.selectionBasis === 'string'
      ? `basis=${evidence.selectionBasis}` : undefined,
    numberValue(evidence.rejectedCandidateCount) > 0
      ? `rejected=${numberValue(evidence.rejectedCandidateCount)}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return labels.length > 0
    ? `${location(evidence)} [${labels.join(',')}]`
    : location(evidence);
}

function diagnosticLines(diagnostic: Record<string, unknown>): string[] {
  const multiplicity = numberValue(diagnostic.multiplicity);
  const first = `${String(diagnostic.severity ?? 'info')} ${
    String(diagnostic.code ?? 'diagnostic')} ${
    String(diagnostic.message ?? '')}${
    multiplicity > 1 ? ` [multiplicity=${multiplicity}]` : ''}`;
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
  const candidateCount = numberValue(diagnostic.candidateCount);
  const shownCandidateCount = numberValue(diagnostic.shownCandidateCount);
  const omittedCandidateCount = numberValue(diagnostic.omittedCandidateCount);
  if (candidateCount > 0)
    lines.push(
      `candidates: ${shownCandidateCount} shown, ${
        omittedCandidateCount} omitted, ${candidateCount} total${
        numberValue(diagnostic.maxDynamicCandidates) > 0
          ? `; effective cap ${numberValue(diagnostic.maxDynamicCandidates)}`
          : ''}`,
    );
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
