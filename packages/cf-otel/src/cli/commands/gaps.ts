import type { Command } from "commander";

import { DEFAULT_GAPS_TOP, DEFAULT_INDEX_PATTERN, MAX_SPANS_FETCHED, SPANS_PAGE_SIZE } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { computeGaps } from "../../gaps.js";
import { searchAfterAll } from "../../opensearch-client.js";
import { hitToSpan } from "../../span-mapper.js";
import type { GapsResult } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { GapsOpts } from "../commandTypes.js";
import { formatDurationNanos } from "../display.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function parseBuckets(value: string | undefined): readonly number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => Number.isNaN(part))) {
    throw new CfOtelError("CONFIG", `Invalid --buckets "${value}"; expected comma-separated millisecond values`);
  }
  return parts.map((ms) => ms * 1_000_000);
}

function printGapsSummary(result: GapsResult, spanId: string): void {
  printNotice(`Direct children of ${spanId}: ${String(result.children.length)}`);
  printNotice(
    `Total gap time: ${formatDurationNanos(result.stats.sumNanos)} ` +
      `(sanity check vs selftime for this span: ${formatDurationNanos(result.selfTimeNanos)})`,
  );
  printNotice(
    `Gap stats (all ${String(result.gaps.length)} gaps): min=${formatDurationNanos(result.stats.minNanos)} ` +
      `max=${formatDurationNanos(result.stats.maxNanos)} mean=${formatDurationNanos(result.stats.meanNanos)} ` +
      `median=${formatDurationNanos(result.stats.medianNanos)} stdev=${formatDurationNanos(result.stats.stdevNanos)}`,
  );
  printNotice(`Histogram: ${JSON.stringify(result.histogram)}`);
  if (result.regression !== undefined) {
    printNotice(
      `Regression (${String(result.regression.sampleCount)} filtered gaps): ` +
        `intercept=${formatDurationNanos(result.regression.interceptNanos)} ` +
        `predicted first=${formatDurationNanos(result.regression.predictedFirstNanos)}, ` +
        `last=${formatDurationNanos(result.regression.predictedLastNanos)} ` +
        `verdict=${result.regression.verdict.toUpperCase()}`,
    );
  }
  printNotice(
    `Overlap check: ${String(result.overlappingPairCount)} / ${String(result.totalPairCount)} consecutive child pairs overlap in time`,
  );
}

async function runGaps(traceId: string, spanId: string, opts: GapsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const bucketEdgesNanos = parseBuckets(opts.buckets);

  const { parent, children, truncated } = await withOpenSearchClient(opts, async (client) => {
    const parentResponse = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 1,
      query: { bool: { filter: [{ term: { traceId } }, { term: { spanId } }] } },
    });
    const parentHit = parentResponse.hits[0];
    if (parentHit === undefined) {
      throw new CfOtelError("TRACE_NOT_FOUND", `Span "${spanId}" was not found in trace "${traceId}"`);
    }
    const paged = await searchAfterAll(
      client,
      DEFAULT_INDEX_PATTERN,
      { query: { bool: { filter: [{ term: { traceId } }, { term: { parentSpanId: spanId } }] } } },
      SPANS_PAGE_SIZE,
      MAX_SPANS_FETCHED,
    );
    return { parent: hitToSpan(parentHit), children: paged.hits.map(hitToSpan), truncated: paged.truncated };
  });
  if (truncated) {
    printNotice(
      "WARNING: the child-span fetch was truncated (hit the safety cap on spans fetched) — " +
        "gap stats below are computed from an incomplete child set and may be wrong",
    );
  }

  const result = computeGaps(parent, children, {
    ...(opts.filterNext === undefined ? {} : { filterNextPattern: opts.filterNext }),
    ...(bucketEdgesNanos === undefined ? {} : { bucketEdgesNanos }),
    topN: DEFAULT_GAPS_TOP,
  });

  printGapsSummary(result, spanId);

  await emitRows({
    command: "gaps",
    format,
    save: opts.save,
    rows: result.topGaps.map((gap) => ({
      INDEX: gap.index,
      GAP: formatDurationNanos(gap.gapNanos),
      GAP_NANOS: gap.gapNanos,
      NEXT: gap.nextSpan.name,
    })),
  });
}

export function registerGapsCommand(program: Command): void {
  const command = program
    .command("gaps <traceId> <spanId>")
    .description("analyze timing gaps between one parent span's direct children");
  command.option(
    "--filter-next <pattern>",
    "restrict the regression to gaps immediately preceding a matching child name (supports * wildcard)",
  );
  command.option("--buckets <ms-list>", "comma-separated millisecond histogram bucket edges");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string, spanId: string) => {
    await runGaps(traceId, spanId, command.opts<GapsOpts>());
  });
}
