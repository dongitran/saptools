interface ImplementationStartEdge {
  id: number;
  status?: string;
}

export function implementationStartDiagnostic(
  edge: ImplementationStartEdge,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    severity: 'warning',
    code: edge.status === 'ambiguous'
      ? 'trace_start_ambiguous'
      : 'trace_start_implementation_unresolved',
    message: `Indexed operation matched but implementation edge is ${String(
      edge.status ?? 'unresolved',
    )}`,
    resolutionStage: 'implementation',
    resolutionStatus: edge.status === 'ambiguous'
      ? 'ambiguous_implementation'
      : 'rejected_implementation',
    implementationEdgeId: edge.id,
    implementationStatus: edge.status,
    implementationAmbiguityReasons: evidence.ambiguityReasons,
    implementationRejectionReasons: implementationRejectionReasons(evidence),
    implementationHintSuggestions: evidence.implementationHintSuggestions,
    implementationHintSuggestionCount: evidence.implementationHintSuggestionCount,
    shownImplementationHintSuggestionCount:
      evidence.shownImplementationHintSuggestionCount,
    omittedImplementationHintSuggestionCount:
      evidence.omittedImplementationHintSuggestionCount,
    candidates: evidence.candidates,
    candidateCount: evidence.candidateCount,
    shownCandidateCount: evidence.shownCandidateCount,
    omittedCandidateCount: evidence.omittedCandidateCount,
  };
}

function implementationRejectionReasons(
  evidence: Record<string, unknown>,
): string[] {
  const candidates = recordArray(evidence.candidates);
  const reasons = candidates.flatMap((candidate) => stringArray(candidate.rejectedReasons));
  return [...new Set(reasons)].sort();
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(isRecord)
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
