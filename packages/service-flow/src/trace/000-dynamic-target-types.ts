import type { DynamicMode } from '../types.js';

export interface DynamicTemplates {
  servicePath?: string;
  operationPath?: string;
  alias?: string;
  destination?: string;
}

export interface DynamicVariableProvenance extends Record<string, unknown> {
  sourceKind: string;
  value: string;
  rule: string;
  template?: string;
  matchedName?: string;
  normalizedForm?: string;
  sourceRepo?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface DynamicVariableConflict {
  key: string;
  values: string[];
  reason: string;
  sources: string[];
}

export interface DynamicTargetCandidate {
  candidateOperationId: number;
  repoId?: number;
  repoName: string;
  packageName?: string;
  serviceName: string;
  qualifiedName: string;
  servicePath: string;
  operationPath: string;
  operationName: string;
  sourceFile: string;
  sourceLine: number;
  originalTemplates: DynamicTemplates;
  effectiveValues: DynamicTemplates;
  requiredVariables: string[];
  requiredVariableSources: Record<string, string[]>;
  suppliedVariables: Record<string, string>;
  completeVariables: Record<string, string>;
  derivedVariables: Record<string, string>;
  derivedVariableSources: Record<string, DynamicVariableProvenance>;
  derivationProvenance: Record<string, DynamicVariableProvenance[]>;
  derivationProvenanceCounts?: Record<string, {
    provenanceCount: number;
    shownProvenanceCount: number;
    omittedProvenanceCount: number;
  }>;
  missingVariables: string[];
  conflicts: DynamicVariableConflict[];
  conflictCount?: number;
  shownConflictCount?: number;
  omittedConflictCount?: number;
  score: number;
  explicitSignalStrength: number;
  reasons: string[];
  rejectedReasons: string[];
  inferenceBlockReasons: string[];
  viable: boolean;
  rejected: boolean;
  selected: boolean;
  exploratory: boolean;
  cli?: string;
}

export interface DynamicTargetAnalysis {
  mode: DynamicMode;
  maxCandidates: number;
  candidateCount: number;
  viableCandidateCount: number;
  rejectedCandidateCount: number;
  shownCandidateCount: number;
  omittedCandidateCount: number;
  shownRejectedCandidateCount: number;
  omittedRejectedCandidateCount: number;
  missingVariables: string[];
  requiredVariables: string[];
  suppliedVariables: Record<string, string>;
  appliedSuppliedVariables: Record<string, string>;
  substitutedSignals: DynamicTemplates;
  candidates: DynamicTargetCandidate[];
  shownCandidates: DynamicTargetCandidate[];
  rejectedCandidates: DynamicTargetCandidate[];
  suggestedVarSets: Array<{ variables: Record<string, string>; cli: string }>;
  suggestedVarSetCount: number;
  shownSuggestedVarSetCount: number;
  omittedSuggestedVarSetCount: number;
  inference: Record<string, unknown>;
  routingContext?: Record<string, unknown>;
}
