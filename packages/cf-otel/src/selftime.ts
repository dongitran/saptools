import type { SelftimeAggregateRow, SelftimeResult, Span } from "./types.js";

function singleRootDuration(rootSpans: readonly Span[]): number | undefined {
  if (rootSpans.length !== 1) {
    return undefined;
  }
  const [only] = rootSpans;
  return only === undefined ? undefined : only.durationInNanos;
}

interface Accumulator {
  count: number;
  selfTotal: number;
  inclusiveTotal: number;
  sample: Span;
}

function aggregateBy(
  spans: readonly Span[],
  selfById: ReadonlyMap<string, number>,
  keyOf: (span: Span) => string,
  rootDurationNanos: number | undefined,
): SelftimeAggregateRow[] {
  const byKey = new Map<string, Accumulator>();
  for (const span of spans) {
    const self = selfById.get(span.spanId) ?? 0;
    const key = keyOf(span);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { count: 1, selfTotal: self, inclusiveTotal: span.durationInNanos, sample: span });
    } else {
      existing.count += 1;
      existing.selfTotal += self;
      existing.inclusiveTotal += span.durationInNanos;
    }
  }
  const rows = [...byKey.entries()].map(([key, agg]) => ({
    key,
    count: agg.count,
    selfTotalNanos: agg.selfTotal,
    selfAvgNanos: agg.selfTotal / agg.count,
    inclusiveTotalNanos: agg.inclusiveTotal,
    pctOfRoot:
      rootDurationNanos === undefined || rootDurationNanos === 0
        ? undefined
        : (100 * agg.selfTotal) / rootDurationNanos,
    sample: agg.sample,
  }));
  rows.sort((a, b) => b.selfTotalNanos - a.selfTotalNanos);
  return rows;
}

/**
 * The core self-time algorithm: for every span, self-time is its own
 * duration minus the sum of its direct children's durations, clamped to
 * zero. A clamp only happens when the children-sum exceeds the parent's own
 * duration — expected across a network hop between services with clock
 * skew, but a red flag if it happens for a parent/children pair that are
 * all within one service, so the count is always reported.
 */
export function computeSelftime(spans: readonly Span[]): SelftimeResult {
  const childrenOf = new Map<string, Span[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined) {
      continue;
    }
    const list = childrenOf.get(span.parentSpanId);
    if (list === undefined) {
      childrenOf.set(span.parentSpanId, [span]);
    } else {
      list.push(span);
    }
  }

  let clampedCount = 0;
  const selfById = new Map<string, number>();
  for (const span of spans) {
    const children = childrenOf.get(span.spanId) ?? [];
    const childrenSum = children.reduce((sum, child) => sum + child.durationInNanos, 0);
    const rawSelf = span.durationInNanos - childrenSum;
    if (rawSelf < 0) {
      clampedCount += 1;
    }
    selfById.set(span.spanId, Math.max(0, rawSelf));
  }

  const rootSpans = spans.filter((span) => span.parentSpanId === undefined);
  const rootDurationNanos = singleRootDuration(rootSpans);

  return {
    rootDurationNanos,
    rootSpans,
    clampedCount,
    totalSpanCount: spans.length,
    byName: aggregateBy(spans, selfById, (span) => span.name, rootDurationNanos),
    byService: aggregateBy(spans, selfById, (span) => span.serviceName, rootDurationNanos),
  };
}
