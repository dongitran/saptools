import type { Command } from "commander";

import { DEFAULT_DIFF_TOP, DEFAULT_INDEX_PATTERN, MAX_SPANS_FETCHED, SPANS_PAGE_SIZE } from "../../config.js";
import { computeDiff, sortDiffRows } from "../../diff.js";
import { CfOtelError } from "../../errors.js";
import { searchAfterAll } from "../../opensearch-client.js";
import { hitToSpan } from "../../span-mapper.js";
import type { DiffSort } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { DiffOpts } from "../commandTypes.js";
import { formatDurationNanos, formatSignedDuration, formatSignedPercent } from "../display.js";
import { emitRows, parseFormat, parseNonNegativeIntOption, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function parseSort(value: string | undefined): DiffSort {
  if (value === undefined || value === "delta") {
    return "delta";
  }
  if (value === "pct" || value === "selfA" || value === "selfB") {
    return value;
  }
  throw new CfOtelError("CONFIG", `Invalid --sort "${value}" (expected delta, pct, selfA, or selfB)`);
}

async function runDiff(traceIdA: string, traceIdB: string, opts: DiffOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const sortBy = parseSort(opts.sort);

  const { spansA, spansB, truncatedA, truncatedB } = await withOpenSearchClient(opts, async (client) => {
    const [pagedA, pagedB] = await Promise.all([
      searchAfterAll(client, DEFAULT_INDEX_PATTERN, { query: { term: { traceId: traceIdA } } }, SPANS_PAGE_SIZE, MAX_SPANS_FETCHED),
      searchAfterAll(client, DEFAULT_INDEX_PATTERN, { query: { term: { traceId: traceIdB } } }, SPANS_PAGE_SIZE, MAX_SPANS_FETCHED),
    ]);
    return {
      spansA: pagedA.hits.map(hitToSpan),
      spansB: pagedB.hits.map(hitToSpan),
      truncatedA: pagedA.truncated,
      truncatedB: pagedB.truncated,
    };
  });
  if (spansA.length === 0) {
    throw new CfOtelError("TRACE_NOT_FOUND", `Trace "${traceIdA}" was not found`);
  }
  if (spansB.length === 0) {
    throw new CfOtelError("TRACE_NOT_FOUND", `Trace "${traceIdB}" was not found`);
  }
  if (truncatedA || truncatedB) {
    const which = truncatedA && truncatedB ? "both traces'" : truncatedA ? `trace "${traceIdA}"'s` : `trace "${traceIdB}"'s`;
    printNotice(
      `WARNING: ${which} span fetch was truncated (hit the safety cap on spans fetched) — self-time totals below are computed from an incomplete span set and may be wrong`,
    );
  }

  const result = computeDiff(spansA, spansB);
  // A --top of 0 means "all" (consistent with --limit elsewhere), not zero rows.
  const rankedRows = sortDiffRows(result.rows, sortBy);
  const sorted = opts.top === 0 ? rankedRows : rankedRows.slice(0, opts.top);

  const rootAText = result.rootANanos === undefined ? "unknown" : formatDurationNanos(result.rootANanos);
  const rootBText = result.rootBNanos === undefined ? "unknown" : formatDurationNanos(result.rootBNanos);
  const deltaText = result.rootANanos === undefined || result.rootBNanos === undefined
    ? ""
    : `  Δ: ${formatSignedDuration(result.rootBNanos - result.rootANanos)} (${formatSignedPercent(result.rootANanos, result.rootBNanos)})`;
  printNotice(`Root A: ${rootAText}   Root B: ${rootBText}${deltaText}`);

  await emitRows({
    command: "diff",
    format,
    save: opts.save,
    rows: sorted.map((row) => ({
      NAME: row.name,
      SELF_A: formatDurationNanos(row.selfANanos),
      SELF_B: formatDurationNanos(row.selfBNanos),
      DELTA: formatSignedDuration(row.selfBNanos - row.selfANanos),
      PCT_CHANGE: row.selfANanos === 0 ? "" : formatSignedPercent(row.selfANanos, row.selfBNanos),
      COUNT_A: row.countA,
      COUNT_B: row.countB,
    })),
  });
}

export function registerDiffCommand(program: Command): void {
  const command = program.command("diff <traceIdA> <traceIdB>").description("compare two traces' self-time breakdowns");
  command.option("--top <n>", "how many rows to show (0 for all)", parseNonNegativeIntOption, DEFAULT_DIFF_TOP);
  command.option("--sort <field>", "delta, pct, selfA, or selfB", "delta");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceIdA: string, traceIdB: string) => {
    await runDiff(traceIdA, traceIdB, command.opts<DiffOpts>());
  });
}
