import type { Command } from "commander";

import { DEFAULT_SNAPSHOT_LIMIT } from "../../config.js";
import { querySnapshot } from "../../snapshot.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SnapshotOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat, printNotice, truncationNotice } from "../output.js";
import {
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
} from "../shared-options.js";

async function runSnapshot(opts: SnapshotOpts): Promise<void> {
  checkUpperLimit(opts.limit);
  const format = parseFormat(opts.format);
  const result = await withOpenSearchClient(opts, async (client) => {
    return await querySnapshot(client, { service: opts.service, limit: opts.limit });
  });
  // The metric names dropped by a `terms` cap are the sparsest ones, which are
  // usually the interesting ones — so say when the list is short rather than
  // letting it look complete.
  if (result.truncated) {
    printNotice(truncationNotice("metric names", opts.limit));
  }
  await emitRows({ command: "snapshot", format, save: opts.save, rows: result.rows });
}

export function registerSnapshotCommand(program: Command): void {
  const command = program
    .command("snapshot")
    .description("latest single value per metric name for a service — point-in-time, no bucketing");
  withServiceOption(command, true);
  withLimitOption(command, DEFAULT_SNAPSHOT_LIMIT, "maximum metric names to return (0 for all)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runSnapshot(command.opts<SnapshotOpts>());
  });
}
