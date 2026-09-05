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

export interface KindResolution {
  readonly kind: MetricKind;
  /**
   * Every other kind bucket also found for this metric name/scope, when more
   * than one exists. Unlike `units` (an expected multi-series case, e.g.
   * `container.cpu.usage`), a name reporting more than one `kind` is a data
   * anomaly — usually an instrumentation change mid-rollout, or two unrelated
   * emitters sharing a name — and the terms agg below silently keeps only the
   * most common one. Empty when there is exactly one kind.
   */
  readonly otherKinds: readonly string[];
}

// The full MetricKind enum has exactly 3 members, so sizing the terms agg to
// all of them costs nothing extra and is what makes a second kind visible as
// `otherKinds` instead of silently vanishing the way `size: 1` did.
const KIND_TERMS_SIZE = 3;

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

/** The window a kind lookup should cover: the caller's own, so it sees the data the caller will. */
export interface KindLookupWindow {
  readonly since?: string;
  readonly until?: string;
}

/**
 * Resolve a metric name's kind with one cheap terms-agg lookup, when the
 * caller didn't already know it. `service` is optional so callers with no
 * per-service scope (e.g. `top`, which ranks cross-app by design) can still
 * resolve a name's kind without a service term filter.
 *
 * `window` is not optional in spirit even though it is in the type: without
 * it this scanned the whole retention period on every run, across all 40
 * backing indices, and answered with the kind that dominated *all time* rather
 * than the one the caller is about to chart. A name whose instrumentation
 * changed — GAUGE for a month, HISTOGRAM since yesterday — then shaped a
 * "last 2h" query with GAUGE sub-aggregations, which read a `value` field
 * HISTOGRAM documents do not carry, and returned real doc counts beside
 * all-null values. It also made the ambiguity warning's own words untrue: it
 * says "in this window" while looking at every window there has ever been.
 */
export async function resolveMetricKind(
  client: OpenSearchClient,
  service: string | undefined,
  name: string,
  window: KindLookupWindow = {},
): Promise<KindResolution> {
  const response = await client.search(DEFAULT_INDEX_PATTERN, {
    size: 0,
    query: buildMetricBoolQuery({
      ...(service === undefined ? {} : { service }),
      names: [name],
      ...(window.since === undefined ? {} : { since: window.since }),
      ...(window.until === undefined ? {} : { until: window.until }),
    }),
    aggs: { by_kind: { terms: { field: "kind", size: KIND_TERMS_SIZE } } },
  });
  const buckets = bucketArray(response.aggregations?.["by_kind"]);
  const key = buckets[0]?.["key"];
  if (key === "GAUGE" || key === "SUM" || key === "HISTOGRAM") {
    return {
      kind: key,
      otherKinds: buckets
        .slice(1)
        .map((bucket) => bucket["key"])
        .filter((otherKey): otherKey is string => typeof otherKey === "string"),
    };
  }
  const scope = service === undefined ? "" : ` on service "${service}"`;
  throw new CfMetricsError(
    "METRIC_NOT_FOUND",
    `Could not resolve a kind for metric "${name}"${scope} — no matching documents found; ` +
      "check the name with `cf-metrics names --service <app>` first, or pass --kind explicitly.",
  );
}
