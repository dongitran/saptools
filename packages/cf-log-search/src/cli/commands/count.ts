import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { buildSearchQuery } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { CountOpts } from "../commandTypes.js";
import { print } from "../output.js";
import { withCredentialOptions, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

function parseStatusOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--status "${value}" is not an integer HTTP status code`);
  }
  return parsed;
}

async function runCount(opts: CountOpts): Promise<void> {
  await withOpenSearchClient(opts, async (client) => {
    const query = buildSearchQuery({
      ...(opts.app === undefined ? {} : { app: opts.app }),
      ...(opts.logSpace === undefined ? {} : { space: opts.logSpace }),
      ...(opts.level === undefined ? {} : { level: opts.level }),
      ...(opts.sourceType === undefined ? {} : { sourceType: opts.sourceType }),
      ...(opts.query === undefined ? {} : { query: opts.query }),
      ...(opts.vcapRequestId === undefined ? {} : { vcapRequestId: opts.vcapRequestId }),
      ...(opts.correlationId === undefined ? {} : { correlationId: opts.correlationId }),
      ...(opts.status === undefined ? {} : { status: opts.status }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
    });
    const total = await client.count(DEFAULT_INDEX_PATTERN, { query });
    print(String(total));
  });
}

export function registerCountCommand(program: Command): void {
  const command = program
    .command("count")
    .description(`count matching rows in ${DEFAULT_INDEX_PATTERN} without fetching them`)
    .option("--app <name>", "filter by CF app name")
    .option("--log-space <name>", "filter by CF space name (the logs' own space_name field)")
    .option("--level <level>", "filter by exact log level")
    .option("--source-type <type>", "filter by source type: RTR, APP/PROC/WEB, CELL, STG, API, or an APP/TASK/<id>")
    .option("--query <text>", "full-text match against the log message")
    .option("--vcap-request-id <id>", "filter by the exact per-hop request id")
    .option("--correlation-id <id>", "filter by the coarser end-to-end business-transaction id")
    .option("--status <code>", "filter RTR rows by exact HTTP response status code", parseStatusOption);
  withTimeRangeOptions(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runCount(command.opts<CountOpts>());
  });
}
