import { bucketArray, isRecord, termsTruncated } from "./agg-buckets.js";
import { ALL_BUCKETS_TERMS_SIZE, DEFAULT_INDEX_PATTERN } from "./config.js";
import type { OutputRow } from "./format.js";
import type { OpenSearchClient } from "./opensearch-client.js";
import { buildMetricBoolQuery } from "./query-builder.js";

export interface SnapshotQueryOptions {
  readonly service: string;
  /** How many metric-name buckets to return; 0 means "no limit", the same convention `names` and `top` use. */
  readonly limit: number;
}

export interface SnapshotResult {
  readonly rows: readonly OutputRow[];
  /**
   * True when the `terms` aggregation dropped metric names to stay inside its
   * `size`. Because the aggregation carries no explicit `order`, OpenSearch
   * selects buckets by `doc_count` descending, so what gets discarded is the
   * *sparsest* metric — precisely the rarely-written custom metric someone is
   * likely hunting for. Silently returning a short list is the failure this
   * flags.
   */
  readonly truncated: boolean;
}

function latestSource(bucket: Record<string, unknown>): Record<string, unknown> | undefined {
  const latest = bucket["latest"];
  if (!isRecord(latest)) {
    return undefined;
  }
  const hits = latest["hits"];
  const hitsArray = isRecord(hits) && Array.isArray(hits["hits"]) ? hits["hits"] : [];
  const first: unknown = hitsArray[0];
  if (!isRecord(first)) {
    return undefined;
  }
  const source = first["_source"];
  return isRecord(source) ? source : undefined;
}

function displayValue(source: Record<string, unknown>): number | undefined {
  const value = source["value"];
  if (typeof value === "number") {
    return value;
  }
  const sum = source["sum"];
  return typeof sum === "number" ? sum : undefined;
}

/**
 * Latest single point per metric name for one service — one `top_hits`
 * aggregation instead of N separate queries, one per metric name.
 */
export async function querySnapshot(client: OpenSearchClient, opts: SnapshotQueryOptions): Promise<SnapshotResult> {
  const size = opts.limit === 0 ? ALL_BUCKETS_TERMS_SIZE : opts.limit;
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query: buildMetricBoolQuery({ service: opts.service }),
    aggs: {
      by_name: {
        terms: { field: "name", size },
        aggs: {
          latest: { top_hits: { size: 1, sort: [{ time: { order: "desc", unmapped_type: "date" } }] } },
        },
      },
    },
  });
  const byName = response.aggregations?.["by_name"];
  const buckets = bucketArray(byName);
  const rows = buckets.map((bucket) => {
    const source = latestSource(bucket);
    return {
      NAME: typeof bucket["key"] === "string" ? bucket["key"] : "",
      KIND: typeof source?.["kind"] === "string" ? source["kind"] : "",
      VALUE: displayValue(source ?? {}) ?? null,
      UNIT: typeof source?.["unit"] === "string" ? source["unit"] : "",
      TIME: typeof source?.["time"] === "string" ? source["time"] : "",
    };
  });
  return { rows, truncated: termsTruncated(byName) };
}
