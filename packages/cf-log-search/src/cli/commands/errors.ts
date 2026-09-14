import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { buildRtrFilterClauses } from "../../rtr-analytics.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { ErrorsOpts } from "../commandTypes.js";
import { emitRows, parseFormat, parseNonNegativeIntOption } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

const ALL_BUCKETS_TERMS_SIZE = 10_000;
const STATUS_BUCKETS_PER_APP = 10;
const DEFAULT_ERRORS_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ErrorRow {
  readonly APP: string;
  readonly STATUS: string;
  readonly DOC_COUNT: number;
}

function parseErrorBuckets(aggregations: Record<string, unknown> | undefined): readonly ErrorRow[] {
  const byApp = aggregations?.["by_app"];
  if (!isRecord(byApp) || !Array.isArray(byApp["buckets"])) {
    return [];
  }
  const rows: ErrorRow[] = [];
  for (const appBucket of byApp["buckets"]) {
    if (!isRecord(appBucket) || typeof appBucket["key"] !== "string") {
      continue;
    }
    const byStatus = appBucket["by_status"];
    if (!isRecord(byStatus) || !Array.isArray(byStatus["buckets"])) {
      continue;
    }
    for (const statusBucket of byStatus["buckets"]) {
      if (!isRecord(statusBucket) || typeof statusBucket["doc_count"] !== "number") {
        continue;
      }
      rows.push({ APP: appBucket["key"], STATUS: String(statusBucket["key"]), DOC_COUNT: statusBucket["doc_count"] });
    }
  }
  return rows;
}

async function runErrors(opts: ErrorsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const clauses = buildRtrFilterClauses({
      ...(opts.app === undefined ? {} : { app: opts.app }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    clauses.push({ range: { response_status: { gte: 400 } } });
    const size = opts.limit === 0 ? ALL_BUCKETS_TERMS_SIZE : Math.min(opts.limit, ALL_BUCKETS_TERMS_SIZE);
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query: { bool: { filter: clauses } },
      aggs: { by_app: { terms: { field: "app_name.keyword", size }, aggs: { by_status: { terms: { field: "response_status", size: STATUS_BUCKETS_PER_APP } } } } },
    });
    const rows = parseErrorBuckets(response.aggregations);
    await emitRows({ command: "errors", format, save: opts.save, rows: rows as unknown as Record<string, unknown>[] });
  });
}

export function registerErrorsCommand(program: Command): void {
  const command = program
    .command("errors")
    .description(`RTR-only: HTTP status-code breakdown (>=400) by app, over a time window (${DEFAULT_INDEX_PATTERN}); shows up to ${String(STATUS_BUCKETS_PER_APP)} distinct status codes per app`)
    .option("--app <name>", "restrict to one CF app name")
    .option("--limit <n>", "maximum apps to break down, 0 for no limit", parseNonNegativeIntOption, DEFAULT_ERRORS_LIMIT);
  withTimeRangeOptions(command);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runErrors(command.opts<ErrorsOpts>());
  });
}
