import { aggValue, bucketArray, bucketDocCount, readUnitKeys } from "./agg-buckets.js";
import { ALL_BUCKETS_TERMS_SIZE, DEFAULT_INDEX_PATTERN, MAX_UNITS_PER_METRIC } from "./config.js";
import { CfMetricsError } from "./errors.js";
import type { OutputRow } from "./format.js";
import type { KindResolution } from "./history.js";
import { resolveMetricKind } from "./history.js";
import { buildKindSubAggs } from "./kind.js";
import type { MetricKind } from "./kind.js";
import type { OpenSearchClient } from "./opensearch-client.js";
import { buildMetricBoolQuery } from "./query-builder.js";

export interface TopQueryOptions {
  readonly name: string;
  readonly since?: string;
  readonly until?: string;
  /** Restrict to one `unit` — see {@link MetricFilterOptions.unit}; without it a multi-unit name ranks on a blend of incommensurable series. */
  readonly unit?: string;
  readonly limit: number;
  /** Skip kind auto-resolution when the caller already knows it (or leave undefined when no data matched at all — ranking then falls back to the value-based query, which naturally returns no rows). */
  readonly kind?: MetricKind;
}

export interface TopResult {
  readonly rows: readonly OutputRow[];
  /** Every distinct `unit` present in the window; more than one means the ranking blends series (see {@link TopQueryOptions.unit}). */
  readonly units: readonly string[];
}

const APP_NAME_FIELD = "resource.attributes.sap@cf@app_name";

/** Sibling aggregation carried on the ranking query itself, so ambiguity detection costs no extra round trip. */
const UNITS_AGG = { units: { terms: { field: "unit", size: MAX_UNITS_PER_METRIC } } };

function bucketApp(bucket: Record<string, unknown>): string {
  return typeof bucket["key"] === "string" ? bucket["key"] : "";
}

/**
 * GAUGE/SUM ranking (and the fallback for a name with no matching data at
 * all): both kinds carry a real numeric `value` field, so OpenSearch can rank
 * and bound the `terms` agg server-side in one query.
 *
 * The `order: {avg_value: "desc"}` on the `terms` agg is required, not
 * optional: a `terms` aggregation's bucket selection defaults to `_count`
 * ordering, so without an explicit order tied to the sub-aggregation, a
 * high-value but comparatively low-frequency app could be dropped before
 * this query's own client-side sort ever sees it — the same lesson already
 * documented against `cf-otel`'s CHANGELOG for its own `top` command.
 */
async function queryTopByValue(client: OpenSearchClient, query: Record<string, unknown>, limit: number): Promise<TopResult> {
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query,
    aggs: {
      by_app: {
        terms: {
          field: APP_NAME_FIELD,
          size: limit === 0 ? ALL_BUCKETS_TERMS_SIZE : limit,
          order: { avg_value: "desc" },
        },
        aggs: {
          avg_value: { avg: { field: "value" } },
          max_value: { max: { field: "value" } },
        },
      },
      ...UNITS_AGG,
    },
  });
  const buckets = bucketArray(response.aggregations?.["by_app"]);
  const rows = buckets.map((bucket) => ({
    APP: bucketApp(bucket),
    AVG: aggValue(bucket, "avg_value") ?? null,
    MAX: aggValue(bucket, "max_value") ?? null,
    DOC_COUNT: bucketDocCount(bucket),
  }));
  return { rows, units: readUnitKeys(response.aggregations) };
}

/**
 * HISTOGRAM ranking: histogram documents carry no `value` field (only
 * `count`/`sum`, see `kind.ts`), so an `avg`/`max` agg on `value` silently
 * matches nothing — confirmed live against real `http.client.duration` data,
 * every row came back with a null AVG/MAX and a meaningless bucket order.
 * Ranking by *average* duration also can't be done with a plain metric
 * sub-agg the way GAUGE/SUM can: `sum(sum)/sum(count)` is a ratio, and
 * ordering a `terms` agg by a ratio needs a `bucket_script` pipeline agg,
 * whose availability through the Dashboards console-proxy is unverified
 * (the same unverified-scripting concern `kind.ts` already documents for
 * percentile approximation). Sidestep it entirely: fetch every app's
 * `sum_count`/`sum_sum` (bounded at the same `ALL_BUCKETS_TERMS_SIZE` ceiling
 * used for `--limit 0`), derive the avg client-side, sort, then slice to the
 * requested limit — no scripting required, and `--limit` no longer needs to
 * be trusted to OpenSearch's own (irrelevant here) bucket selection.
 */
async function queryTopHistogram(client: OpenSearchClient, query: Record<string, unknown>, limit: number): Promise<TopResult> {
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query,
    aggs: {
      by_app: {
        terms: { field: APP_NAME_FIELD, size: ALL_BUCKETS_TERMS_SIZE },
        aggs: buildKindSubAggs("HISTOGRAM"),
      },
      ...UNITS_AGG,
    },
  });
  const buckets = bucketArray(response.aggregations?.["by_app"]);
  const ranked = buckets
    .map((bucket) => {
      const sumCount = aggValue(bucket, "sum_count") ?? 0;
      const sumSum = aggValue(bucket, "sum_sum") ?? 0;
      return { APP: bucketApp(bucket), AVG: sumCount > 0 ? sumSum / sumCount : null, DOC_COUNT: bucketDocCount(bucket) };
    })
    .sort((a, b) => (typeof b.AVG === "number" ? b.AVG : -Infinity) - (typeof a.AVG === "number" ? a.AVG : -Infinity));
  return { rows: limit === 0 ? ranked : ranked.slice(0, limit), units: readUnitKeys(response.aggregations) };
}

/**
 * Resolve `name`'s kind for `top`'s cross-app (unscoped) ranking, degrading
 * to `undefined` — not throwing — when no documents match at all. Unlike
 * `history`, `top` has no single `--service` to blame a typo'd name on, and
 * an empty ranking table is already a perfectly clear "nothing reports this"
 * signal; a hard error here would only regress the previously-working
 * behavior for an unknown `--name` from an empty table to a crash.
 */
export async function resolveTopMetricKind(client: OpenSearchClient, name: string): Promise<KindResolution | undefined> {
  try {
    return await resolveMetricKind(client, undefined, name);
  } catch (error) {
    if (error instanceof CfMetricsError && error.code === "METRIC_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Cross-app outlier ranking for one metric name — deliberately no
 * `--service` filter, that is the point: rank every app in the targeted
 * space reporting this metric. Kind-aware: HISTOGRAM metrics need a
 * different query shape than GAUGE/SUM (see {@link queryTopHistogram}).
 */
export async function queryTop(client: OpenSearchClient, opts: TopQueryOptions): Promise<TopResult> {
  const query = buildMetricBoolQuery({
    names: [opts.name],
    ...(opts.since === undefined ? {} : { since: opts.since }),
    ...(opts.until === undefined ? {} : { until: opts.until }),
    ...(opts.unit === undefined ? {} : { unit: opts.unit }),
  });
  if (opts.kind === "HISTOGRAM") {
    return await queryTopHistogram(client, query, opts.limit);
  }
  return await queryTopByValue(client, query, opts.limit);
}
