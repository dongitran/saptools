import type { Command } from "commander";

import { extractBuckets } from "../../aggregations.js";
import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { resolveTimeRange } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { AppsOpts } from "../commandTypes.js";
import { emitRows, parseFormat, parseNonNegativeIntOption } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

const ALL_BUCKETS_TERMS_SIZE = 10_000;
const DEFAULT_APPS_LIMIT = 50;

async function runApps(opts: AppsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const range = resolveTimeRange(opts.since, opts.until);
    const query = range === undefined ? { match_all: {} } : { bool: { filter: [{ range: { "@timestamp": range } }] } };
    const size = opts.limit === 0 ? ALL_BUCKETS_TERMS_SIZE : Math.min(opts.limit, ALL_BUCKETS_TERMS_SIZE);
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query,
      aggs: { by_app: { terms: { field: "app_name.keyword", size } } },
    });
    const buckets = extractBuckets(response.aggregations, "by_app");
    const rows = buckets.map((bucket) => ({ APP: bucket.key, DOC_COUNT: bucket.docCount }));
    await emitRows({ command: "apps", format, save: opts.save, rows });
  });
}

export function registerAppsCommand(program: Command): void {
  const command = program
    .command("apps")
    .description(`which CF apps are logging in ${DEFAULT_INDEX_PATTERN}, and how much, over a time window`)
    .option("--limit <n>", "maximum apps to return, 0 for no limit", parseNonNegativeIntOption, DEFAULT_APPS_LIMIT);
  withTimeRangeOptions(command);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runApps(command.opts<AppsOpts>());
  });
}
