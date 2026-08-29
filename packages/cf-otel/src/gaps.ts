import { toEpochNanos } from "./timestamps.js";
import type { GapEntry, GapRegression, GapStats, GapsResult, Span } from "./types.js";

interface TimedSpan {
  readonly span: Span;
  readonly startNanos: bigint;
  readonly endNanos: bigint;
}

function toTimedSpan(span: Span): TimedSpan {
  const startNanos = toEpochNanos(span.startTime);
  return { span, startNanos, endNanos: startNanos + BigInt(span.durationInNanos) };
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => (match === "*" ? ".*" : `\\${match}`));
  return new RegExp(`^${escaped}$`);
}

function computeMedian(sortedValues: readonly number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedValues[mid] ?? 0;
  }
  const lower = sortedValues[mid - 1] ?? 0;
  const upper = sortedValues[mid] ?? 0;
  return (lower + upper) / 2;
}

function computeGapStats(values: readonly number[]): GapStats {
  const count = values.length;
  if (count === 0) {
    return { count: 0, sumNanos: 0, minNanos: 0, maxNanos: 0, meanNanos: 0, medianNanos: 0, stdevNanos: 0 };
  }
  const sumNanos = values.reduce((a, b) => a + b, 0);
  const meanNanos = sumNanos / count;
  const variance = values.reduce((acc, value) => acc + (value - meanNanos) ** 2, 0) / count;
  return {
    count,
    sumNanos,
    minNanos: Math.min(...values),
    maxNanos: Math.max(...values),
    meanNanos,
    medianNanos: computeMedian([...values].sort((a, b) => a - b)),
    stdevNanos: Math.sqrt(variance),
  };
}

function formatBoundary(nanos: number): string {
  if (nanos < 1_000_000_000) {
    const ms = nanos / 1_000_000;
    return `${Number.isInteger(ms) ? String(ms) : ms.toFixed(1)}ms`;
  }
  const seconds = nanos / 1_000_000_000;
  return `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)}s`;
}

function buildBucketLabels(sortedEdges: readonly number[]): string[] {
  const labels: string[] = [];
  for (let index = 0; index < sortedEdges.length; index++) {
    const edge = sortedEdges[index];
    if (edge === undefined) {
      continue;
    }
    if (index === 0) {
      labels.push(`<${formatBoundary(edge)}`);
    } else {
      labels.push(`${formatBoundary(sortedEdges[index - 1] ?? 0)}-${formatBoundary(edge)}`);
    }
  }
  labels.push(`>=${formatBoundary(sortedEdges[sortedEdges.length - 1] ?? 0)}`);
  return labels;
}

/** Only non-empty buckets are included, matching how a real trace's histogram is reported. */
function buildHistogram(values: readonly number[], bucketEdgesNanos: readonly number[]): Record<string, number> {
  const sortedEdges = [...bucketEdgesNanos].sort((a, b) => a - b);
  const labels = buildBucketLabels(sortedEdges);
  const counts: number[] = labels.map(() => 0);
  for (const value of values) {
    let bucketIndex = sortedEdges.length;
    for (const [index, edge] of sortedEdges.entries()) {
      if (value < edge) {
        bucketIndex = index;
        break;
      }
    }
    counts[bucketIndex] = (counts[bucketIndex] ?? 0) + 1;
  }
  const result: Record<string, number> = {};
  for (const [index, label] of labels.entries()) {
    const count = counts[index] ?? 0;
    if (count > 0) {
      result[label] = count;
    }
  }
  return result;
}

/** Least-squares linear regression of gap size against occurrence index within the filtered set. */
export function computeRegression(filteredGaps: readonly GapEntry[]): GapRegression {
  const n = filteredGaps.length;
  const meanX = (n - 1) / 2;
  const meanY = filteredGaps.reduce((sum, gap) => sum + gap.gapNanos, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [index, gap] of filteredGaps.entries()) {
    numerator += (index - meanX) * (gap.gapNanos - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const predictedFirstNanos = intercept;
  const predictedLastNanos = intercept + slope * (n - 1);
  const delta = Math.abs(predictedLastNanos - predictedFirstNanos);
  // Math.abs(meanY): gaps are legitimately negative when children overlap, and
  // a threshold scaled by the raw signed mean would collapse to a near-zero
  // floor whenever meanY < 1 (always true for a negative mean), flagging any
  // trivial drift as "growing" regardless of its real magnitude. Scaling by
  // magnitude keeps the threshold symmetric regardless of sign.
  const verdict: "flat" | "growing" = delta > 0.25 * Math.max(1, Math.abs(meanY)) ? "growing" : "flat";
  return { interceptNanos: intercept, slopeNanosPerOccurrence: slope, predictedFirstNanos, predictedLastNanos, verdict, sampleCount: n };
}

export interface ComputeGapsOptions {
  readonly filterNextPattern?: string;
  readonly bucketEdgesNanos?: readonly number[];
  readonly topN?: number;
}

const DEFAULT_HISTOGRAM_EDGES_NANOS = [50, 100, 300, 600, 1_000, 3_000].map((ms) => ms * 1_000_000);
const DEFAULT_TOP_N = 3;

/**
 * Analyze timing gaps between one parent span's direct children. Each gap is
 * `child.startTime - prevEnd`, where `prevEnd` tracks the running end of
 * coverage via `max(prevEnd, child.endTime)` (not plain assignment) so a
 * child nested inside an earlier one doesn't roll coverage backward and
 * corrupt a later, genuinely-non-overlapping child's gap.
 *
 * Gaps are signed, not clamped to zero: an overlapping child produces a
 * *negative* gap by design (confirmed against real production data, where a
 * reported gap sequence's own minimum has been negative) — clamping to zero
 * would silently discard that information. This is deliberately NOT treated
 * as a guaranteed reconciliation against self-time: a gap value measures how
 * far *before the running frontier* a child started, which only equals
 * "minus that child's own duration" in the special case where the child's
 * end exactly ties the frontier already established by an earlier sibling.
 * A child nested well inside existing coverage with slack to spare (ending
 * before the frontier, not at it) breaks that equivalence, so the raw gap
 * sum can legitimately diverge from {@link GapsResult.selfTimeNanos} by more
 * than a rounding error. Both numbers are still individually correct; they
 * are reported side by side as an approximate cross-check (mirroring how
 * `selftime` independently computes the same span's self-time), not as
 * values guaranteed to match. {@link GapsResult.overlappingPairCount}
 * separately flags exactly which consecutive pairs overlap, without
 * altering the gap values themselves.
 */
export function computeGaps(parent: Span, children: readonly Span[], options: ComputeGapsOptions = {}): GapsResult {
  const parentStart = toEpochNanos(parent.startTime);
  const parentEnd = parentStart + BigInt(parent.durationInNanos);
  const sorted = children.map(toTimedSpan).sort((a, b) => compareBigint(a.startNanos, b.startNanos));

  let overlappingPairCount = 0;
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && current.startNanos < previous.endNanos) {
      overlappingPairCount += 1;
    }
  }

  const gaps: GapEntry[] = [];
  let prevEnd = parentStart;
  for (const [index, entry] of sorted.entries()) {
    gaps.push({ index, gapNanos: Number(entry.startNanos - prevEnd), nextSpan: entry.span });
    prevEnd = entry.endNanos > prevEnd ? entry.endNanos : prevEnd;
  }
  gaps.push({ index: sorted.length, gapNanos: Number(parentEnd - prevEnd), nextSpan: parent });

  const gapValues = gaps.map((gap) => gap.gapNanos);
  const topN = options.topN ?? DEFAULT_TOP_N;
  const topGaps = [...gaps].sort((a, b) => b.gapNanos - a.gapNanos).slice(0, topN);

  const filtered = options.filterNextPattern === undefined
    ? gaps
    : gaps.filter((gap) => wildcardToRegExp(options.filterNextPattern ?? "").test(gap.nextSpan.name));

  const childrenDurationSum = children.reduce((sum, child) => sum + child.durationInNanos, 0);
  const selfTimeNanos = Math.max(0, parent.durationInNanos - childrenDurationSum);

  return {
    parent,
    children: sorted.map((entry) => entry.span),
    gaps,
    stats: computeGapStats(gapValues),
    histogram: buildHistogram(gapValues, options.bucketEdgesNanos ?? DEFAULT_HISTOGRAM_EDGES_NANOS),
    topGaps,
    regression: filtered.length >= 2 ? computeRegression(filtered) : undefined,
    overlappingPairCount,
    totalPairCount: Math.max(0, sorted.length - 1),
    selfTimeNanos,
  };
}
