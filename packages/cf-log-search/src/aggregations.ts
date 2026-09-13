export interface AggregationBucket {
  readonly key: string;
  readonly docCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a standard OpenSearch `terms` aggregation's buckets out of a `SearchResponse.aggregations` object, tolerating an absent or malformed shape. */
export function extractBuckets(aggregations: Record<string, unknown> | undefined, name: string): readonly AggregationBucket[] {
  const aggregation = aggregations?.[name];
  if (!isRecord(aggregation) || !Array.isArray(aggregation["buckets"])) {
    return [];
  }
  const buckets: AggregationBucket[] = [];
  for (const raw of aggregation["buckets"]) {
    if (isRecord(raw) && typeof raw["key"] === "string" && typeof raw["doc_count"] === "number") {
      buckets.push({ key: raw["key"], docCount: raw["doc_count"] });
    }
  }
  return buckets;
}
