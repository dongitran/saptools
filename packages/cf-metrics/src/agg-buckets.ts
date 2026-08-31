/**
 * Shared helpers for reading OpenSearch aggregation-response shapes: a
 * bucket-producing aggregation's `buckets` array, one bucket's own
 * `doc_count`, and a metric sub-aggregation's numeric `.value`. Every command
 * that shapes a `terms`/`date_histogram` aggregation response — `names`,
 * `snapshot`, `top`, `history`, and `kind`'s per-kind bucket shaping — needs
 * the exact same handful of narrow-and-extract steps; this is the one place
 * that logic lives instead of five near-identical copies.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a bucket-aggregation response's `buckets` array, narrowed to plain records; empty when the shape doesn't match. */
export function bucketArray(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value["buckets"])) {
    return [];
  }
  return value["buckets"].filter(isRecord);
}

/** A bucket's own `doc_count` (how many documents fell into it), defaulting to 0 when absent or malformed. */
export function bucketDocCount(bucket: Record<string, unknown>): number {
  return typeof bucket["doc_count"] === "number" ? bucket["doc_count"] : 0;
}

/**
 * Every distinct `unit` string from a `units` terms aggregation. `history` and
 * `top` both attach that aggregation to the query they were already sending so
 * they can detect a metric name that publishes more than one series (see
 * `query-builder.ts`'s `unit` filter) without paying an extra round trip.
 */
export function readUnitKeys(aggregations: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return bucketArray(aggregations?.["units"])
    .map((bucket) => bucket["key"])
    .filter((key): key is string => typeof key === "string");
}

/** A metric sub-aggregation's (`avg`/`min`/`max`/`sum`) numeric `.value` on one bucket, `undefined` when absent or malformed. */
export function aggValue(bucket: Record<string, unknown>, aggName: string): number | undefined {
  const agg = bucket[aggName];
  if (!isRecord(agg)) {
    return undefined;
  }
  const value = agg["value"];
  return typeof value === "number" ? value : undefined;
}
