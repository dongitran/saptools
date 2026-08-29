import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, DEFAULT_TOP_LIMIT } from "../../config.js";
import { parseDetachedCandidates, sortDetachedCandidates } from "../../detached.js";
import { CfOtelError } from "../../errors.js";
import { buildSpanBoolQuery } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { TopOpts } from "../commandTypes.js";
import { formatDurationNanos } from "../display.js";
import { emitRows, parseFormat } from "../output.js";
import {
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
  withTimeRangeOptions,
} from "../shared-options.js";

const NOT_A_REAL_TRACE_ID = "";

function parseSortBy(value: string | undefined): "duration" | "spanCount" {
  if (value === undefined || value === "duration") {
    return "duration";
  }
  if (value === "spanCount") {
    return "spanCount";
  }
  throw new CfOtelError("CONFIG", `Invalid --sort "${value}" (expected duration or spanCount)`);
}

async function runTop(opts: TopOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const sortBy = parseSortBy(opts.sort);

  const candidates = await withOpenSearchClient(opts, async (client) => {
    const query = buildSpanBoolQuery({
      service: opts.service,
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      errorsOnly: opts.errorsOnly,
    });
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 0,
      query,
      aggs: {
        by_trace: {
          terms: { field: "traceId", size: 10_000 },
          aggs: {
            min_start: { min: { field: "startTime" } },
            max_duration: { max: { field: "durationInNanos" } },
            first_hit: { top_hits: { size: 1, sort: [{ startTime: "asc" }] } },
          },
        },
      },
    });
    const candidates = sortDetachedCandidates(
      parseDetachedCandidates(response.aggregations, NOT_A_REAL_TRACE_ID),
      sortBy === "duration" ? "duration" : "spanCount",
    );
    // A limit of 0 means "all" (consistent with `detached`'s identical
    // pattern), not zero rows — Array.slice(0, 0) would otherwise silently
    // empty the list.
    return opts.limit === 0 ? candidates : candidates.slice(0, opts.limit);
  });

  await emitRows({
    command: "top",
    format,
    save: opts.save,
    rows: candidates.map((candidate) => ({
      TRACE_ID: candidate.traceId,
      NAME: candidate.firstSpanName,
      DURATION: formatDurationNanos(candidate.maxDurationNanos),
      DURATION_NANOS: candidate.maxDurationNanos,
      SPAN_COUNT: candidate.spanCount,
      START_TIME: candidate.minStart,
    })),
  });
}

export function registerTopCommand(program: Command): void {
  const command = program.command("top").description("outlier hunting across a time range without a starting traceId");
  withServiceOption(command, true);
  withTimeRangeOptions(command);
  withLimitOption(command, DEFAULT_TOP_LIMIT, "maximum rows to return (0 for all)");
  command.option("--sort <field>", "duration or spanCount", "duration");
  command.option("--errors-only", "shorthand for status.code == 2", false);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runTop(command.opts<TopOpts>());
  });
}
