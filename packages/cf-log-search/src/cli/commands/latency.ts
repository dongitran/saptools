import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { buildRtrFilterClauses } from "../../rtr-analytics.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { LatencyOpts } from "../commandTypes.js";
import { emitRows, parseFormat, parseNonNegativeIntOption } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

const ALL_BUCKETS_TERMS_SIZE = 10_000;
const DEFAULT_LATENCY_LIMIT = 20;
const PERCENTS = [50, 95, 99];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bucketField(by: string): string {
  return by === "route" ? "request" : "app_name.keyword";
}

function parseByOption(value: string): string {
  if (value !== "app" && value !== "route") {
    throw new Error(`--by must be "app" or "route", got "${value}"`);
  }
  return value;
}

interface LatencyRow {
  readonly BUCKET: string;
  readonly P50_MS: number | null;
  readonly P95_MS: number | null;
  readonly P99_MS: number | null;
  readonly DOC_COUNT: number;
}

function readPercentile(values: Record<string, unknown>, key: string): number | null {
  const value = values[key];
  return typeof value === "number" ? value : null;
}

function parseLatencyBuckets(aggregations: Record<string, unknown> | undefined): readonly LatencyRow[] {
  const byBucket = aggregations?.["by_bucket"];
  if (!isRecord(byBucket) || !Array.isArray(byBucket["buckets"])) {
    return [];
  }
  const rows: LatencyRow[] = [];
  for (const bucket of byBucket["buckets"]) {
    if (!isRecord(bucket) || typeof bucket["key"] !== "string" || typeof bucket["doc_count"] !== "number") {
      continue;
    }
    const percentiles = bucket["latency_percentiles"];
    const values = isRecord(percentiles) && isRecord(percentiles["values"]) ? percentiles["values"] : {};
    rows.push({
      BUCKET: bucket["key"],
      P50_MS: readPercentile(values, "50.0"),
      P95_MS: readPercentile(values, "95.0"),
      P99_MS: readPercentile(values, "99.0"),
      DOC_COUNT: bucket["doc_count"],
    });
  }
  return rows;
}

async function runLatency(opts: LatencyOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const clauses = buildRtrFilterClauses({
      ...(opts.app === undefined ? {} : { app: opts.app }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    const size = opts.limit === 0 ? ALL_BUCKETS_TERMS_SIZE : Math.min(opts.limit, ALL_BUCKETS_TERMS_SIZE);
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query: { bool: { filter: clauses } },
      aggs: { by_bucket: { terms: { field: bucketField(opts.by), size }, aggs: { latency_percentiles: { percentiles: { field: "response_time_ms", percents: PERCENTS } } } } },
    });
    const rows = parseLatencyBuckets(response.aggregations);
    await emitRows({ command: "latency", format, save: opts.save, rows: rows as unknown as Record<string, unknown>[] });
  });
}

export function registerLatencyCommand(program: Command): void {
  const command = program
    .command("latency")
    .description(`RTR-only: p50/p95/p99 response_time_ms, bucketed by app or route, over a time window (${DEFAULT_INDEX_PATTERN})`)
    .option("--app <name>", "restrict to one CF app name")
    .option("--by <bucket>", 'bucket by "app" or "route"', parseByOption, "app")
    .option("--limit <n>", "maximum buckets to return, 0 for no limit", parseNonNegativeIntOption, DEFAULT_LATENCY_LIMIT);
  withTimeRangeOptions(command);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runLatency(command.opts<LatencyOpts>());
  });
}
