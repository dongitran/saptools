import type { Command } from "commander";

import { extractBuckets } from "../../aggregations.js";
import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { buildRtrFilterClauses } from "../../rtr-analytics.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { TopRoutesOpts } from "../commandTypes.js";
import { emitRows, parseFormat, parsePositiveIntOption } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

const DEFAULT_TOP_ROUTES_LIMIT = 20;

async function runTopRoutes(opts: TopRoutesOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const clauses = buildRtrFilterClauses({
      ...(opts.app === undefined ? {} : { app: opts.app }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query: { bool: { filter: clauses } },
      aggs: { by_route: { terms: { field: "request", size: opts.limit } } },
    });
    const buckets = extractBuckets(response.aggregations, "by_route");
    const rows = buckets.map((bucket) => ({ ROUTE: bucket.key, DOC_COUNT: bucket.docCount }));
    await emitRows({ command: "top-routes", format, save: opts.save, rows });
  });
}

export function registerTopRoutesCommand(program: Command): void {
  const command = program
    .command("top-routes")
    .description(`RTR-only: busiest routes by request count, over a time window (${DEFAULT_INDEX_PATTERN})`)
    .option("--app <name>", "restrict to one CF app name")
    .option("--limit <n>", "how many routes to rank (a deliberate top-N cut, not a truncation)", parsePositiveIntOption, DEFAULT_TOP_ROUTES_LIMIT);
  withTimeRangeOptions(command);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runTopRoutes(command.opts<TopRoutesOpts>());
  });
}
