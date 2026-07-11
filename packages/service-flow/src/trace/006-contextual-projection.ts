import { projectBounded } from '../utils/000-bounded-projection.js';

export function boundedContextCandidates(values: unknown[]): {
  candidates: Array<Record<string, unknown>>;
  candidateCount: number;
  shownCandidateCount: number;
  omittedCandidateCount: number;
} {
  const candidates = values.flatMap((value): Array<Record<string, unknown>> => {
    return isRecord(value) ? [value] : [];
  });
  const projection = projectBounded(candidates, (left, right) =>
    Number(right.score ?? 0) - Number(left.score ?? 0)
    || String(left.repoName ?? '').localeCompare(String(right.repoName ?? ''))
    || String(left.servicePath ?? '').localeCompare(String(right.servicePath ?? ''))
    || String(left.sourceFile ?? '').localeCompare(String(right.sourceFile ?? ''))
    || Number(left.sourceLine ?? 0) - Number(right.sourceLine ?? 0)
    || Number(left.bindingId ?? left.operationId ?? 0)
      - Number(right.bindingId ?? right.operationId ?? 0));
  return {
    candidates: projection.items,
    candidateCount: projection.totalCount,
    shownCandidateCount: projection.shownCount,
    omittedCandidateCount: projection.omittedCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
