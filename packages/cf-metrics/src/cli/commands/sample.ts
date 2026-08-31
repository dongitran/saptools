import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, DEFAULT_SAMPLE_LIMIT } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import { assertValidTimeBoundShape, buildMetricBoolQuery } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SampleOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat } from "../output.js";
import {
  withCredentialOptions,
  withLimitOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
  withFormatOption,
  withTimeRangeOptions,
} from "../shared-options.js";

function checkLimit(limit: number): void {
  if (limit === 0) {
    throw new CfMetricsError(
      "CONFIG",
      "--limit 0 would return zero results (size is sent directly to OpenSearch); pass a positive --limit",
    );
  }
  checkUpperLimit(limit);
}

/** Fail fast on an unparseable --since/--until before any CF login or network call. */
function checkTimeRange(opts: { readonly since?: string; readonly until?: string }): void {
  if (opts.since !== undefined) {
    assertValidTimeBoundShape("--since", opts.since);
  }
  if (opts.until !== undefined) {
    assertValidTimeBoundShape("--until", opts.until);
  }
}

async function runSample(opts: SampleOpts): Promise<void> {
  checkLimit(opts.limit);
  checkTimeRange(opts);
  const format = parseFormat(opts.format);
  const rows = await withOpenSearchClient(opts, async (client) => {
    const query = buildMetricBoolQuery({
      ...(opts.service === undefined ? {} : { service: opts.service }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: opts.limit,
      query,
      sort: [{ time: { order: "desc", unmapped_type: "date" } }],
    });
    return response.hits.map((hit) => hit._source);
  });
  await emitRows({ command: "sample", rows, format, save: opts.save });
}

export function registerSampleCommand(program: Command): void {
  const command = program
    .command("sample")
    .description("dump the N most recent full documents, unfiltered — the entry point when you know nothing yet");
  withServiceOption(command, false);
  withTimeRangeOptions(command);
  withLimitOption(command, DEFAULT_SAMPLE_LIMIT);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runSample(command.opts<SampleOpts>());
  });
}

