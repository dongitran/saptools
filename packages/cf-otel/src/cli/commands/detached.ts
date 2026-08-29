import type { Command } from "commander";

import {
  DEFAULT_DETACHED_LIMIT,
  DEFAULT_DETACHED_PADDING_SECONDS,
  DEFAULT_INDEX_PATTERN,
  MAX_SPANS_FETCHED,
  SPANS_PAGE_SIZE,
} from "../../config.js";
import { findDetachedCandidates } from "../../detached.js";
import { CfOtelError } from "../../errors.js";
import { searchAfterAll } from "../../opensearch-client.js";
import { hitToSpan } from "../../span-mapper.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { DetachedOpts } from "../commandTypes.js";
import { formatDurationNanos } from "../display.js";
import { emitRows, parseFormat, parseNonNegativeIntOption, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withLimitOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function parseSortBy(value: string | undefined): "spanCount" | "duration" {
  if (value === undefined || value === "spanCount") {
    return "spanCount";
  }
  if (value === "duration") {
    return "duration";
  }
  throw new CfOtelError("CONFIG", `Invalid --sort "${value}" (expected spanCount or duration)`);
}

async function runDetached(traceId: string, opts: DetachedOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const sortBy = parseSortBy(opts.sort);

  const { result, truncated } = await withOpenSearchClient(opts, async (client) => {
    const paged = await searchAfterAll(
      client,
      DEFAULT_INDEX_PATTERN,
      { query: { term: { traceId } } },
      SPANS_PAGE_SIZE,
      MAX_SPANS_FETCHED,
    );
    if (paged.hits.length === 0) {
      throw new CfOtelError("TRACE_NOT_FOUND", `Trace "${traceId}" was not found`);
    }
    const detachedResult = await findDetachedCandidates(client, DEFAULT_INDEX_PATTERN, traceId, paged.hits.map(hitToSpan), {
      paddingSeconds: opts.padding,
      limit: opts.limit,
      sortBy,
    });
    return { result: detachedResult, truncated: paged.truncated };
  });
  if (truncated) {
    printNotice(
      "WARNING: the reference trace's own span fetch was truncated (hit the safety cap on spans fetched) — " +
        "its service/time window below may be based on an incomplete span set",
    );
  }

  printNotice(
    `Reference trace: serviceName=${result.referenceServiceName}, window=[${result.windowStart}, ${result.windowEnd}]`,
  );
  printNotice(
    `${String(result.totalCandidateSpanCount)} candidate spans found across ${String(result.totalCandidateTraceCount)} other traceId(s) in this window.`,
  );
  if (result.candidateBucketsTruncated) {
    printNotice(
      "WARNING: more than 10,000 distinct candidate traceIds exist in this window — the lowest-ranked ones by " +
        "--sort were dropped before this list was built",
    );
  }

  await emitRows({
    command: "detached",
    format,
    save: opts.save,
    rows: result.candidates.map((candidate) => ({
      TRACE_ID: candidate.traceId,
      SPAN_COUNT: candidate.spanCount,
      MIN_START: candidate.minStart,
      MAX_DURATION: formatDurationNanos(candidate.maxDurationNanos),
      MAX_DURATION_NANOS: candidate.maxDurationNanos,
      FIRST_SPAN_NAME: candidate.firstSpanName,
    })),
  });
}

export function registerDetachedCommand(program: Command): void {
  const command = program
    .command("detached <traceId>")
    .description(
      "finds likely detached/orphaned trace continuations in the same service and time window as a given trace — " +
        "use this when a trace's self-time is unexplained by any of its own child spans",
    );
  command.option(
    "--padding <seconds>",
    "seconds of padding around the reference trace's window",
    parseNonNegativeIntOption,
    DEFAULT_DETACHED_PADDING_SECONDS,
  );
  withLimitOption(command, DEFAULT_DETACHED_LIMIT, "maximum rows to return (0 for all)");
  command.option("--sort <field>", "spanCount or duration", "spanCount");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string) => {
    await runDetached(traceId, command.opts<DetachedOpts>());
  });
}
