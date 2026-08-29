/** Output rendering for CLI results. */
export type OutputFormat = "table" | "json" | "json-compact" | "csv";

/** Whether region/org/space was pinned by the caller or inherited from `cf target`. */
export type SelectorSource = "explicit" | "ambient";

export interface ResolvedTarget {
  readonly apiEndpoint: string;
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly selectorSource: SelectorSource;
  /** False when an ambient region key could not be mapped back to a known API endpoint. */
  readonly regionConfirmed: boolean;
}

export interface DashboardsCredential {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  /** Non-secret provenance, e.g. "service-key:mykey" or "minted:cf-otel-ab12cd34". Safe to log. */
  readonly source: string;
}

/** A single OpenTelemetry span document as read from `otel-v1-apm-span-*`. */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: string;
  readonly serviceName: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly durationInNanos: number;
  readonly statusCode?: number;
  /**
   * The `_source` document, for flat-attribute access — full and unfiltered
   * for every command except `spans`, which requests only the fields it
   * needs via OpenSearch's `_source` filtering (plus `traceId`/`spanId`,
   * which this type always requires); a span built from a `spans` fetch may
   * therefore have a `raw` missing attributes a caller expects. No current
   * code path reads `.raw` on a `spans`-sourced span (only `selftime`, whose
   * own fetch is never `_source`-filtered, reads it), but a future one
   * should not assume this field is always complete.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type AttrOperator = ">=" | "<=" | ">" | "<" | "=" | "~";

export interface AttrFilter {
  readonly key: string;
  readonly operator: AttrOperator;
  readonly value: string;
}

export interface SpanFilterOptions {
  readonly service?: string;
  readonly namePattern?: string;
  readonly since?: string;
  readonly until?: string;
  readonly attrs?: readonly AttrFilter[];
  readonly errorsOnly?: boolean;
  readonly traceIds?: readonly string[];
}

/** One ranked row, grouped either by span `name` or by `serviceName` (see {@link SelftimeResult}). */
export interface SelftimeAggregateRow {
  readonly key: string;
  readonly count: number;
  readonly selfTotalNanos: number;
  readonly selfAvgNanos: number;
  readonly inclusiveTotalNanos: number;
  readonly pctOfRoot: number | undefined;
  readonly sample: Span;
}

export interface SelftimeResult {
  readonly rootDurationNanos: number | undefined;
  readonly rootSpans: readonly Span[];
  readonly clampedCount: number;
  readonly totalSpanCount: number;
  readonly byName: readonly SelftimeAggregateRow[];
  readonly byService: readonly SelftimeAggregateRow[];
}

export interface GapEntry {
  readonly index: number;
  readonly gapNanos: number;
  readonly nextSpan: Span;
}

export interface GapRegression {
  readonly interceptNanos: number;
  readonly slopeNanosPerOccurrence: number;
  readonly predictedFirstNanos: number;
  readonly predictedLastNanos: number;
  readonly verdict: "flat" | "growing";
  readonly sampleCount: number;
}

export interface GapStats {
  readonly count: number;
  readonly sumNanos: number;
  readonly minNanos: number;
  readonly maxNanos: number;
  readonly meanNanos: number;
  readonly medianNanos: number;
  readonly stdevNanos: number;
}

export interface GapsResult {
  readonly parent: Span;
  readonly children: readonly Span[];
  readonly gaps: readonly GapEntry[];
  readonly stats: GapStats;
  readonly histogram: Readonly<Record<string, number>>;
  readonly topGaps: readonly GapEntry[];
  readonly regression: GapRegression | undefined;
  readonly overlappingPairCount: number;
  readonly totalPairCount: number;
  /** `parent.durationInNanos - sum(children durations)`, clamped to zero; an independent cross-check against {@link GapStats.sumNanos}. */
  readonly selfTimeNanos: number;
}

export interface DetachedCandidate {
  readonly traceId: string;
  readonly spanCount: number;
  readonly minStart: string;
  readonly maxDurationNanos: number;
  readonly firstSpanName: string;
}

export interface DetachedResult {
  readonly referenceServiceName: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly candidates: readonly DetachedCandidate[];
  readonly totalCandidateTraceCount: number;
  /** Total candidate spans across every trace found, before the by-trace grouping — distinct from `totalCandidateTraceCount`. */
  readonly totalCandidateSpanCount: number;
  /** True when more than 10,000 distinct candidate traceIds existed and some were dropped before ranking. */
  readonly candidateBucketsTruncated: boolean;
}

export type DiffSort = "delta" | "pct" | "selfA" | "selfB";

export interface DiffRow {
  readonly name: string;
  readonly selfANanos: number;
  readonly selfBNanos: number;
  readonly countA: number;
  readonly countB: number;
}

export interface DiffResult {
  readonly rootANanos: number | undefined;
  readonly rootBNanos: number | undefined;
  readonly rows: readonly DiffRow[];
}
