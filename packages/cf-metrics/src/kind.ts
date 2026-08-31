import { aggValue, bucketDocCount } from "./agg-buckets.js";
import { CfMetricsError } from "./errors.js";
import type { OutputRow } from "./format.js";

export type MetricKind = "GAUGE" | "SUM" | "HISTOGRAM";

export function parseMetricKind(value: string): MetricKind {
  if (value === "GAUGE" || value === "SUM" || value === "HISTOGRAM") {
    return value;
  }
  throw new CfMetricsError("CONFIG", `Unknown metric kind "${value}" (expected GAUGE, SUM, or HISTOGRAM)`);
}

function bucketTime(bucket: Record<string, unknown>): string {
  const keyAsString = bucket["key_as_string"];
  if (typeof keyAsString === "string") {
    return keyAsString;
  }
  const key = bucket["key"];
  return typeof key === "number" || typeof key === "string" ? String(key) : "";
}

/**
 * Sub-aggregations to attach to a `date_histogram` (or any bucket agg) for
 * each metric kind. GAUGE reports the distribution shape (avg/min/max) since
 * a raw average alone hides spikes within a bucket; SUM assumes
 * `AGGREGATION_TEMPORALITY_DELTA` (the only temporality observed live — see
 * {@link shapeSumBucket}); HISTOGRAM aggregates the two real numeric fields
 * every OTel histogram data point already carries (`count`/`sum`) rather
 * than attempting to merge `bucketCounts`/`explicitBounds` across documents
 * for a percentile estimate, which would need either a scripted metric agg
 * (scripting availability through the Dashboards console-proxy is
 * unverified) or non-trivial client-side bucket-boundary alignment with no
 * live example to validate against — an honest v1 scope, not an oversight.
 */
export function buildKindSubAggs(kind: MetricKind): Record<string, unknown> {
  switch (kind) {
    case "GAUGE":
      return {
        avg_value: { avg: { field: "value" } },
        min_value: { min: { field: "value" } },
        max_value: { max: { field: "value" } },
      };
    case "SUM":
      return { sum_value: { sum: { field: "value" } } };
    case "HISTOGRAM":
      return { sum_count: { sum: { field: "count" } }, sum_sum: { sum: { field: "sum" } } };
  }
}

function shapeGaugeBucket(bucket: Record<string, unknown>): OutputRow {
  return {
    TIME: bucketTime(bucket),
    AVG: aggValue(bucket, "avg_value") ?? null,
    MIN: aggValue(bucket, "min_value") ?? null,
    MAX: aggValue(bucket, "max_value") ?? null,
    DOC_COUNT: bucketDocCount(bucket),
  };
}

/**
 * SUM metrics observed live (`queue.incoming_messages`/`outgoing_messages`/
 * `processing_failures`) all carry `AGGREGATION_TEMPORALITY_DELTA`, meaning
 * each document's `value` is already the delta since the previous point —
 * summing them per bucket is correct. A `CUMULATIVE`-temporality SUM would
 * need last-minus-first stitching instead; that path is deliberately not
 * implemented (no real example exists to validate it against) — callers
 * should pass `warnCumulative: true` when a fetched sample's
 * `aggregationTemporality` is `AGGREGATION_TEMPORALITY_CUMULATIVE` so the
 * command layer can surface a one-line warning instead of silently
 * mis-reporting the sum as delta.
 */
function shapeSumBucket(bucket: Record<string, unknown>): OutputRow {
  return {
    TIME: bucketTime(bucket),
    SUM: aggValue(bucket, "sum_value") ?? 0,
    DOC_COUNT: bucketDocCount(bucket),
  };
}

function shapeHistogramBucket(bucket: Record<string, unknown>): OutputRow {
  const sumCount = aggValue(bucket, "sum_count") ?? 0;
  const sumSum = aggValue(bucket, "sum_sum") ?? 0;
  return {
    TIME: bucketTime(bucket),
    COUNT: sumCount,
    SUM: sumSum,
    AVG: sumCount > 0 ? sumSum / sumCount : null,
    DOC_COUNT: bucketDocCount(bucket),
  };
}

/** Shape one raw `date_histogram` bucket into a display row, branching on the metric's kind. */
export function shapeHistoryBucket(kind: MetricKind, bucket: Record<string, unknown>): OutputRow {
  switch (kind) {
    case "GAUGE":
      return shapeGaugeBucket(bucket);
    case "SUM":
      return shapeSumBucket(bucket);
    case "HISTOGRAM":
      return shapeHistogramBucket(bucket);
  }
}

const CUMULATIVE_TEMPORALITY_VALUE = "AGGREGATION_TEMPORALITY_CUMULATIVE";

/** True when a sample document's `aggregationTemporality` field is the cumulative variant. */
export function isCumulativeTemporality(sampleDoc: Readonly<Record<string, unknown>> | undefined): boolean {
  return sampleDoc?.["aggregationTemporality"] === CUMULATIVE_TEMPORALITY_VALUE;
}
