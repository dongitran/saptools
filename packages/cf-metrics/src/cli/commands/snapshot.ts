import type { Command } from "commander";

import { querySnapshot } from "../../snapshot.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SnapshotOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withServiceOption, withTargetOptions } from "../shared-options.js";

async function runSnapshot(opts: SnapshotOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const rows = await withOpenSearchClient(opts, async (client) => {
    return await querySnapshot(client, { service: opts.service });
  });
  await emitRows({ command: "snapshot", format, save: opts.save, rows });
}

export function registerSnapshotCommand(program: Command): void {
  const command = program
    .command("snapshot")
    .description("latest single value per metric name for a service — point-in-time, no bucketing");
  withServiceOption(command, true);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runSnapshot(command.opts<SnapshotOpts>());
  });
}
