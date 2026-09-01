import type { Command } from "commander";

import { DEFAULT_NAMES_LIMIT, DEFAULT_SINCE } from "../../config.js";
import { queryNames } from "../../names.js";
import { assertValidTimeRange } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { NamesOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat, printNotice, truncationNotice } from "../output.js";
import {
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
  withTimeRangeOptions,
} from "../shared-options.js";

/** Fail fast on an unparseable --since/--until before any CF login or network call. */
async function runNames(opts: NamesOpts): Promise<void> {
  checkUpperLimit(opts.limit);
  const format = parseFormat(opts.format);
  assertValidTimeRange(opts, DEFAULT_SINCE);
  const result = await withOpenSearchClient(opts, async (client) => {
    return await queryNames(client, {
      service: opts.service,
      since: opts.since ?? DEFAULT_SINCE,
      ...(opts.until === undefined ? {} : { until: opts.until }),
      limit: opts.limit,
    });
  });
  if (result.truncated) {
    printNotice(truncationNotice("metric names", opts.limit));
  }
  await emitRows({ command: "names", format, save: opts.save, rows: result.rows });
}

export function registerNamesCommand(program: Command): void {
  const command = program
    .command("names")
    .description("which metric names exist for a service/time-range, with kind, unit, and doc count");
  withServiceOption(command, true);
  withTimeRangeOptions(command);
  withLimitOption(command, DEFAULT_NAMES_LIMIT, "maximum metric names to return (0 for all)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runNames(command.opts<NamesOpts>());
  });
}
