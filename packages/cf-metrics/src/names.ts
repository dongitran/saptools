import { bucketArray, termsTruncated } from "./agg-buckets.js";
import { ALL_BUCKETS_TERMS_SIZE, DEFAULT_INDEX_PATTERN } from "./config.js";
import type { OutputRow } from "./format.js";
import type { OpenSearchClient } from "./opensearch-client.js";
import { buildMetricBoolQuery } from "./query-builder.js";

export interface NamesQueryOptions {
  readonly service: string;
  readonly since: string;
  readonly until?: string;
  /** How many metric-name buckets to return; 0 means "no limit" (same convention as `top`, see `ALL_BUCKETS_TERMS_SIZE`). */
  readonly limit: number;
}

function topBucketKey(bucket: Record<string, unknown>, aggName: string): string | undefined {
  const agg = bucket[aggName];
  const first = bucketArray(agg)[0];
  const key = first?.["key"];
  return typeof key === "string" ? key : undefined;
}

/**
 * Every unit a metric name reports, not just the most common one. Showing only
 * the top bucket hid the fact that `container.cpu.usage` publishes two series
 * (`unit="1"` and `unit="cpu"`, differing by ~17x) while its DOC_COUNT counted
 * both — the discovery command was actively concealing the one thing a user
 * needs to know before aggregating it. See `query-builder.ts`'s `unit` filter.
 */
function allBucketKeys(bucket: Record<string, unknown>, aggName: string): string {
  return bucketArray(bucket[aggName])
    .map((entry) => entry["key"])
    .filter((key): key is string => typeof key === "string")
    .join(", ");
}

/** Which metric names exist for one service/time-range, with their kind and unit. */
export interface NamesResult {
  readonly rows: readonly OutputRow[];
  /** True when the `terms` aggregation dropped names — see {@link SnapshotResult.truncated} for why the sparsest go first. */
  readonly truncated: boolean;
}

export async function queryNames(client: OpenSearchClient, opts: NamesQueryOptions): Promise<NamesResult> {
  const query = buildMetricBoolQuery({
    service: opts.service,
    since: opts.since,
    ...(opts.until === undefined ? {} : { until: opts.until }),
  });
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query,
    aggs: {
      by_name: {
        terms: { field: "name", size: opts.limit === 0 ? ALL_BUCKETS_TERMS_SIZE : opts.limit },
        aggs: {
          by_kind: { terms: { field: "kind", size: 5 } },
          by_unit: { terms: { field: "unit", size: 3 } },
        },
      },
    },
  });
  const byName = response.aggregations?.["by_name"];
  const rows = bucketArray(byName).map((bucket) => ({
    NAME: typeof bucket["key"] === "string" ? bucket["key"] : "",
    KIND: topBucketKey(bucket, "by_kind") ?? "",
    UNIT: allBucketKeys(bucket, "by_unit"),
    DOC_COUNT: typeof bucket["doc_count"] === "number" ? bucket["doc_count"] : 0,
  }));
  return { rows, truncated: termsTruncated(byName) };
}
