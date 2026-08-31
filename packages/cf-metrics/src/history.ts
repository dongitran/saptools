import { bucketArray, readUnitKeys } from "./agg-buckets.js";
import { DEFAULT_INDEX_PATTERN, MAX_UNITS_PER_METRIC } from "./config.js";
import { CfMetricsError } from "./errors.js";
import type { OutputRow } from "./format.js";
import { buildKindSubAggs, isCumulativeTemporality, shapeHistoryBucket } from "./kind.js";
import type { MetricKind } from "./kind.js";
import type { OpenSearchClient } from "./opensearch-client.js";
import { buildMetricBoolQuery } from "./query-builder.js";

export interface HistoryQueryOptions {
  readonly service: string;
  readonly name: string;
  readonly since: string;
  readonly until?: string;
  readonly unit?: string;
  readonly interval: string;
  readonly kind: MetricKind;
}

export interface HistoryResult {
  readonly rows: readonly OutputRow[];
  /** True when a fetched sample doc reports cumulative-temporality SUM (see kind.ts) — the command layer should warn. */
  readonly cumulativeWarning: boolean;
  /**
   * Every distinct `unit` present in the queried window. More than one means
   * the rows above blend incommensurable series and are not meaningful — the
   * command layer warns and points at `--unit`. Collected as a sibling
   * aggregation on the query that was already being sent, so this costs no
   * extra round trip.
   */
  readonly units: readonly string[];
}

/** One metric name's time-bucketed history, shaped according to its kind. */
export async function queryHistory(client: OpenSearchClient, opts: HistoryQueryOptions): Promise<HistoryResult> {
  const query = buildMetricBoolQuery({
    service: opts.service,
    names: [opts.name],
    since: opts.since,
    ...(opts.unit === undefined ? {} : { unit: opts.unit }),
    ...(opts.until === undefined ? {} : { until: opts.until }),
  });

  const [aggResponse, sample] = await Promise.all([
    client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query,
      aggs: {
        over_time: {
          date_histogram: { field: "time", fixed_interval: opts.interval },
          aggs: buildKindSubAggs(opts.kind),
        },
        units: { terms: { field: "unit", size: MAX_UNITS_PER_METRIC } },
      },
    }),
    opts.kind === "SUM"
      ? client.search(DEFAULT_INDEX_PATTERN, { size: 1, query, sort: [{ time: { order: "desc", unmapped_type: "date" } }] })
      : undefined,
  ]);

  const buckets = bucketArray(aggResponse.aggregations?.["over_time"]);
  const rows = buckets.map((bucket) => shapeHistoryBucket(opts.kind, bucket));
  const cumulativeWarning = sample !== undefined && isCumulativeTemporality(sample.hits[0]?._source);
  return { rows, cumulativeWarning, units: readUnitKeys(aggResponse.aggregations) };
}

/**
 * Resolve a metric name's kind with one cheap terms-agg lookup, when the
 * caller didn't already know it. `service` is optional so callers with no
 * per-service scope (e.g. `top`, which ranks cross-app by design) can still
 * resolve a name's kind without a service term filter.
 */
export async function resolveMetricKind(client: OpenSearchClient, service: string | undefined, name: string): Promise<MetricKind> {
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query: buildMetricBoolQuery({ ...(service === undefined ? {} : { service }), names: [name] }),
    aggs: { by_kind: { terms: { field: "kind", size: 1 } } },
  });
  const buckets = bucketArray(response.aggregations?.["by_kind"]);
  const key = buckets[0]?.["key"];
  if (key === "GAUGE" || key === "SUM" || key === "HISTOGRAM") {
    return key;
  }
  const scope = service === undefined ? "" : ` on service "${service}"`;
  throw new CfMetricsError(
    "METRIC_NOT_FOUND",
    `Could not resolve a kind for metric "${name}"${scope} — no matching documents found; ` +
      "check the name with `cf-metrics names --service <app>` first, or pass --kind explicitly.",
  );
}
