import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, DEFAULT_SEARCH_LIMIT, MAX_ROWS_FETCHED, SEARCH_PAGE_SIZE } from "../../config.js";
import { pitSearchAll } from "../../pit-pagination.js";
import { buildSearchQuery } from "../../query-builder.js";
import { mapHitToLogRow } from "../../row-mapper.js";
import type { RawLogSource } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SearchOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions, withTimeRangeOptions } from "../shared-options.js";

function parseStatusOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--status "${value}" is not an integer HTTP status code`);
  }
  return parsed;
}

function parseLimitOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--limit "${value}" must be a positive integer`);
  }
  return parsed;
}

async function runSearch(opts: SearchOpts): Promise<void> {
  const format = parseFormat(opts.format);
  checkUpperLimit(opts.limit);
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
    const maxTotal = Math.min(opts.limit, MAX_ROWS_FETCHED);
    const page = await pitSearchAll<RawLogSource>(client, DEFAULT_INDEX_PATTERN, query, Math.min(SEARCH_PAGE_SIZE, maxTotal), maxTotal);
    if (page.truncated) {
      printNotice(`showing ${String(page.hits.length)} of ${String(page.totalHits)} matching rows — narrow --since/--until or add filters, or raise --limit (capped at ${String(MAX_ROWS_FETCHED)}), to see more.`);
    }
    const rows = page.hits.map((hit) => mapHitToLogRow({ id: hit.id, source: hit.source }) as unknown as Record<string, unknown>);
    await emitRows({ command: "search", format, save: opts.save, rows });
  });
}

export function registerSearchCommand(program: Command): void {
  const command = program
    .command("search")
    .description(`full-text and structured search over historical SAP Cloud Foundry application logs (${DEFAULT_INDEX_PATTERN})`)
    .option("--app <name>", "filter by CF app name")
    .option("--log-space <name>", "filter by CF space name (the logs' own space_name field — see --space for which space to connect to)")
    .option("--level <level>", "filter by exact log level (debug, info, warn, error, ...) — APP-log rows only, RTR rows have none")
    .option("--source-type <type>", "filter by source type: RTR, APP/PROC/WEB, CELL, STG, API, or an APP/TASK/<id>")
    .option("--query <text>", "full-text match against the log message (APP-log rows only; RTR rows have no message field)")
    .option("--vcap-request-id <id>", "filter by the exact per-hop request id (see `trace <id> --with-span` to pull the correlated OTel spans)")
    .option("--correlation-id <id>", "filter by the coarser end-to-end business-transaction id (many requests share one)")
    .option("--status <code>", "filter RTR rows by exact HTTP response status code", parseStatusOption)
    .option("--limit <n>", "maximum rows to fetch", parseLimitOption, DEFAULT_SEARCH_LIMIT);
  withTimeRangeOptions(command);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runSearch(command.opts<SearchOpts>());
  });
}
