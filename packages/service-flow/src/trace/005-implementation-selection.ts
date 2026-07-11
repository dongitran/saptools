import type { Db } from '../db/connection.js';
import { canonicalImplementationEvidence } from '../linker/000-implementation-candidates.js';
import type { ImplementationHint } from '../types.js';
import { projectBounded } from '../utils/000-bounded-projection.js';
import {
  selectImplementation,
  type ImplementationSelection,
} from './implementation-hints.js';

export interface ImplementationGraphEdge {
  status?: string;
  evidence_json?: string;
}

export interface ImplementationSelectionOptions {
  implementationRepo?: string;
  implementationHints?: ImplementationHint[];
}

export function hintedImplementationSelection(
  db: Db,
  edge: ImplementationGraphEdge | undefined,
  operationId: string,
  options: ImplementationSelectionOptions,
): ImplementationSelection {
  if (!edge || edge.status !== 'ambiguous')
    return { blocksAutomatic: false, evidence: { status: 'not_applicable' } };
  return selectImplementation(
    parsedEvidence(edge.evidence_json), options.implementationHints,
    options.implementationRepo, canonicalImplementationEvidence(db, operationId),
  );
}

export function contextualImplementationSelection(
  db: Db,
  edge: ImplementationGraphEdge | undefined,
  operationId: string,
  callerRepoId: number | undefined,
  remoteEvidence: Record<string, unknown>,
  options: ImplementationSelectionOptions,
): ImplementationSelection {
  const hinted = hintedImplementationSelection(db, edge, operationId, options);
  if (hinted.methodId || hinted.blocksAutomatic || !edge
    || edge.status !== 'ambiguous' || callerRepoId === undefined) return hinted;
  const candidates = implementationCandidates(
    canonicalImplementationEvidence(db, operationId) ?? parsedEvidence(edge.evidence_json),
  );
  const scores = candidates.filter((candidate) => candidate.accepted)
    .map((candidate) => contextualScore(candidate, callerRepoId, remoteEvidence))
    .sort(compareScore);
  if (scores.length === 0)
    return { blocksAutomatic: false, evidence: { status: 'not_applicable', candidateScores: [] } };
  const [first, second] = scores;
  if (first?.methodId !== undefined && first.score > 0
    && (!second || first.score > second.score))
    return selectedContext(first, scores);
  return tiedContext(hinted, scores);
}

function selectedContext(
  first: ContextScore,
  scores: ContextScore[],
): ImplementationSelection {
  const projection = projectBounded(scores, compareScore);
  return {
    methodId: String(first.methodId),
    blocksAutomatic: false,
    evidence: {
      status: 'selected',
      selectedMethodId: first.methodId,
      candidateScores: projection.items,
      candidateScoreCount: projection.totalCount,
      shownCandidateScoreCount: projection.shownCount,
      omittedCandidateScoreCount: projection.omittedCount,
    },
  };
}

function tiedContext(
  hinted: ImplementationSelection,
  scores: ContextScore[],
): ImplementationSelection {
  if (hinted.evidence.reason === 'no_scoped_hint_matched_edge') return hinted;
  const projection = projectBounded(scores, compareScore);
  return {
    blocksAutomatic: false,
    evidence: {
      status: 'tied',
      tieReason: scores.length > 1
        ? 'duplicate_helper_implementation_candidates'
        : 'no_unique_materially_stronger_candidate',
      candidateScores: projection.items,
      candidateScoreCount: projection.totalCount,
      shownCandidateScoreCount: projection.shownCount,
      omittedCandidateScoreCount: projection.omittedCount,
    },
  };
}

interface ImplementationCandidate {
  accepted: boolean;
  methodId?: number;
  score: number;
  handlerPackage: Record<string, unknown>;
  applicationPackage: Record<string, unknown>;
}

interface ContextScore {
  methodId?: number;
  score: number;
  reasons: string[];
  handlerPackage: Record<string, unknown>;
  applicationPackage: Record<string, unknown>;
}

function implementationCandidates(evidence: Record<string, unknown>): ImplementationCandidate[] {
  const rows = Array.isArray(evidence.candidates) ? evidence.candidates : [];
  return rows.flatMap((value) => {
    const row = record(value);
    return Object.keys(row).length === 0 ? [] : [{
      accepted: row.accepted === true,
      methodId: numberValue(row.methodId),
      score: numberValue(row.score) ?? 0,
      handlerPackage: record(row.handlerPackage),
      applicationPackage: record(row.applicationPackage),
    }];
  });
}

function contextualScore(
  candidate: ImplementationCandidate,
  callerRepoId: number,
  remoteEvidence: Record<string, unknown>,
): ContextScore {
  const reasons: string[] = [];
  let score = candidate.score;
  if (numberValue(candidate.handlerPackage.id) === callerRepoId) {
    score += 10;
    reasons.push('handler_package_matches_caller_repository');
  }
  if (numberValue(candidate.applicationPackage.id) === callerRepoId) {
    score += 10;
    reasons.push('registration_package_matches_caller_repository');
  }
  if (hasRemoteContext(remoteEvidence)) {
    score += 1;
    reasons.push('remote_call_context_available');
  }
  return {
    methodId: candidate.methodId,
    score,
    reasons,
    handlerPackage: candidate.handlerPackage,
    applicationPackage: candidate.applicationPackage,
  };
}

function hasRemoteContext(evidence: Record<string, unknown>): boolean {
  return typeof evidence.effectiveServicePath === 'string'
    || typeof evidence.effectiveDestination === 'string'
    || typeof evidence.effectiveAlias === 'string';
}

function compareScore(left: ContextScore, right: ContextScore): number {
  return right.score - left.score
    || Number(left.methodId ?? 0) - Number(right.methodId ?? 0);
}

function parsedEvidence(value: string | undefined): Record<string, unknown> {
  try {
    return record(JSON.parse(String(value ?? '{}')) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
