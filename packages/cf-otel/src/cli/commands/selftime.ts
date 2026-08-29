import type { Command } from "commander";

import { pickIdentifyingAttribute } from "../../attributes.js";
import { DEFAULT_INDEX_PATTERN, DEFAULT_SELFTIME_TOP, MAX_SPANS_FETCHED, SPANS_PAGE_SIZE } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { searchAfterAll } from "../../opensearch-client.js";
import { computeSelftime } from "../../selftime.js";
import { hitToSpan } from "../../span-mapper.js";
import type { SelftimeAggregateRow } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SelftimeOpts } from "../commandTypes.js";
import { formatDurationNanos, formatPercent } from "../display.js";
import { emitRows, parseFormat, parseNonNegativeIntOption, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function buildRow(row: SelftimeAggregateRow, withSamples: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    NAME: row.key,
    COUNT: row.count,
    SELF_TOTAL: formatDurationNanos(row.selfTotalNanos),
    SELF_TOTAL_NANOS: row.selfTotalNanos,
    SELF_AVG: formatDurationNanos(row.selfAvgNanos),
    "PCT_OF_ROOT": formatPercent(row.pctOfRoot),
  };
  if (withSamples) {
    const identifying = pickIdentifyingAttribute(row.sample.raw);
    base["SAMPLE"] = identifying === undefined ? "" : `${identifying.key}=${JSON.stringify(identifying.value)}`;
  }
  return base;
}

async function runSelftime(traceId: string, opts: SelftimeOpts): Promise<void> {
  const format = parseFormat(opts.format);

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
    return { result: computeSelftime(paged.hits.map(hitToSpan)), truncated: paged.truncated };
  });
  if (truncated) {
    printNotice(
      "WARNING: the span fetch for this trace was truncated (hit the safety cap on spans fetched) — " +
        "self-time totals below are computed from an incomplete span set and may be wrong",
    );
  }

  const singleRoot = result.rootSpans.length === 1 ? result.rootSpans[0] : undefined;
  const rootLabel = singleRoot !== undefined && result.rootDurationNanos !== undefined
    ? `${singleRoot.name}  (duration: ${formatDurationNanos(result.rootDurationNanos)})`
    : `${String(result.rootSpans.length)} root span(s) found — % of root is unavailable`;
  printNotice(`Root span: ${rootLabel}`);
  printNotice(`Clamped spans (children-sum > own duration): ${String(result.clampedCount)}`);

  // A --top of 0 means "all" (consistent with --limit elsewhere), not zero
  // rows — both arrays are already-fetched, in-memory aggregations, not a
  // raw OpenSearch fetch size, so slicing all of it is always safe.
  const byName = opts.top === 0 ? result.byName : result.byName.slice(0, opts.top);
  await emitRows({
    command: "selftime",
    format,
    save: opts.save,
    rows: byName.map((row) => buildRow(row, opts.withSamples)),
  });

  if (opts.byService) {
    printNotice("--by-service breakdown:");
    const byService = opts.top === 0 ? result.byService : result.byService.slice(0, opts.top);
    await emitRows({
      command: "selftime-by-service",
      format,
      save: opts.save,
      rows: byService.map((row) => buildRow(row, false)),
    });
  }
}

export function registerSelftimeCommand(program: Command): void {
  const command = program
    .command("selftime <traceId>")
    .description("rank spans by self-time descending — the core, highest-value command for finding the real bottleneck");
  command.option("--top <n>", "how many ranked rows to show (0 for all)", parseNonNegativeIntOption, DEFAULT_SELFTIME_TOP);
  command.option("--by-service", "add the secondary serviceName breakdown", false);
  command.option(
    "--with-samples",
    "attach one representative example span's identifying attributes to each ranked row",
    false,
  );
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string) => {
    await runSelftime(traceId, command.opts<SelftimeOpts>());
  });
}
