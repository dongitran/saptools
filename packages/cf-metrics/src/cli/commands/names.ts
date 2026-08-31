import type { Command } from "commander";

import { DEFAULT_NAMES_LIMIT, DEFAULT_SINCE } from "../../config.js";
import { queryNames } from "../../names.js";
import { assertValidTimeBoundShape } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { NamesOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat } from "../output.js";
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
function checkTimeRange(opts: { readonly since?: string; readonly until?: string }): void {
  if (opts.since !== undefined) {
    assertValidTimeBoundShape("--since", opts.since);
  }
  if (opts.until !== undefined) {
    assertValidTimeBoundShape("--until", opts.until);
  }
}

async function runNames(opts: NamesOpts): Promise<void> {
  checkUpperLimit(opts.limit);
  const format = parseFormat(opts.format);
  checkTimeRange(opts);
  const rows = await withOpenSearchClient(opts, async (client) => {
    return await queryNames(client, {
      service: opts.service,
      since: opts.since ?? DEFAULT_SINCE,
      ...(opts.until === undefined ? {} : { until: opts.until }),
      limit: opts.limit,
    });
  });
  await emitRows({ command: "names", format, save: opts.save, rows });
}

export function registerNamesCommand(program: Command): void {
  const command = program
    .command("names")
    .description("which metric names exist for a service/time-range, with kind, unit, and doc count");
  withServiceOption(command, true);
  withTimeRangeOptions(command);
  withLimitOption(command, DEFAULT_NAMES_LIMIT);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runNames(command.opts<NamesOpts>());
  });
}
