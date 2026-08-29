import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, DEFAULT_SAMPLE_LIMIT } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { buildSpanBoolQuery } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SampleOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
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
    // Unlike detached/top/spans/diff (where 0 means "all", safe because those
    // slice an already internally-bounded fetch/aggregation), --limit here
    // maps directly to OpenSearch's own `size`, where 0 means "return zero
    // hits" — the opposite of "all". Reject explicitly rather than silently
    // returning nothing, which would look identical to "no matches at all".
    throw new CfOtelError(
      "CONFIG",
      "--limit 0 would return zero results here (size is sent directly to OpenSearch, unlike detached/top/spans/diff's 0-means-all display slice); pass a positive --limit, or narrow/widen --since/--until instead",
    );
  }
}

async function runSample(opts: SampleOpts): Promise<void> {
  checkLimit(opts.limit);
  const format = parseFormat(opts.format);
  const rows = await withOpenSearchClient(opts, async (client) => {
    const query = buildSpanBoolQuery({
      ...(opts.service === undefined ? {} : { service: opts.service }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: opts.limit,
      query,
      sort: [{ startTime: "desc" }],
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
