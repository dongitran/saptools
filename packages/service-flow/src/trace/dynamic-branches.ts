import type { TraceEdge } from '../types.js';

interface DynamicBranchCall {
  repoName: string;
  source_file: string;
  source_line: number;
}

export interface DynamicCandidateBranch {
  edge: TraceEdge;
  operationId?: number;
  repositoryId?: number;
  servicePath?: string;
  operationPath?: string;
}

export function dynamicCandidateBranches(
  depth: number,
  call: DynamicBranchCall,
  evidence: Record<string, unknown>,
): DynamicCandidateBranch[] {
  const exploration = objectRecord(evidence.dynamicTargetExploration);
  return recordArray(evidence.dynamicTargetCandidateSuggestions).map((candidate) => ({
    edge: {
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
    },
    operationId: optionalNumber(candidate.candidateOperationId),
    repositoryId: optionalNumber(candidate.repoId),
    servicePath: optionalString(candidate.servicePath),
    operationPath: optionalString(candidate.operationPath),
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
