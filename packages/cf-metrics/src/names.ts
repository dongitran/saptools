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

/**
 * Every value a metric name reports for one sub-aggregation, not just the
 * most common one. Showing only the top bucket hid two distinct anomalies
 * this command exists to surface: `container.cpu.usage` publishing two units
 * (`unit="1"` and `unit="cpu"`, differing by ~17x) while its DOC_COUNT counted
 * both (see `query-builder.ts`'s `unit` filter) — and, the same way, a name
 * reporting more than one `kind` (GAUGE/SUM/HISTOGRAM), a data anomaly rather
 * than an expected shape (see `history.ts`'s `KindResolution`). Either way,
 * the discovery command was actively concealing the one thing a user needs to
 * know before aggregating on the name.
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
    KIND: allBucketKeys(bucket, "by_kind"),
    UNIT: allBucketKeys(bucket, "by_unit"),
    DOC_COUNT: typeof bucket["doc_count"] === "number" ? bucket["doc_count"] : 0,
  }));
  return { rows, truncated: termsTruncated(byName) };
}
