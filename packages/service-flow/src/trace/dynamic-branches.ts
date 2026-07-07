import type { TraceEdge } from '../types.js';

interface DynamicBranchCall {
  repoName: string;
  source_file: string;
  source_line: number;
}

export function dynamicCandidateBranches(
  depth: number,
  call: DynamicBranchCall,
  evidence: Record<string, unknown>,
): TraceEdge[] {
  const exploration = objectRecord(evidence.dynamicTargetExploration);
  return recordArray(evidence.dynamicTargetCandidateSuggestions).map((candidate) => ({
    step: depth,
    type: 'dynamic_candidate_branch',
    from: `${call.repoName}:${call.source_file}:${call.source_line}`,
    to: `${String(candidate.servicePath ?? '')}${String(candidate.operationPath ?? '')}`,
    evidence: {
      ...candidate,
      exploratory: true,
      dynamicMode: String(exploration.mode ?? 'candidates'),
      selected: false,
      omittedCandidateCount: numericValue(exploration.omittedCandidateCount),
    },
    confidence: numericValue(candidate.score),
    unresolvedReason: 'Exploratory dynamic target candidate; provide runtime variables to select it',
  }));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
