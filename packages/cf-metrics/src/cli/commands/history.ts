import type { Command } from "commander";

import { DEFAULT_HISTORY_INTERVAL, DEFAULT_SINCE } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import type { OutputRow } from "../../format.js";
import { queryHistory, resolveMetricKind } from "../../history.js";
import { parseMetricKind } from "../../kind.js";
import type { MetricKind } from "../../kind.js";
import { assertValidTimeRange } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { HistoryOpts } from "../commandTypes.js";
import { collectRepeatable, emitRows, parseFormat, printNotice } from "../output.js";
import {
  withCredentialOptions,
  withFormatOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
  withTimeRangeOptions,
} from "../shared-options.js";

// OpenSearch's `fixed_interval` accepts a plain `<integer><unit>` with no
// calendar units (ms/s/m/h/d only — month/week/quarter/year need
// `calendar_interval` instead, which this command never sends). The digit
// group is captured so a zero magnitude ("0m", "0s", ...) can be rejected
// below — the shape alone would otherwise accept it, since `\d+` allows a
// lone `0`, and a zero-width bucket has no sensible meaning here.
const INTERVAL_PATTERN = /^(\d+)(?:ms|s|m|h|d)$/;

/** Fail fast on an unparseable --since/--until/--interval before any CF login or network call. */
function checkTimeOptions(opts: { readonly since?: string; readonly until?: string; readonly interval: string }): void {
  assertValidTimeRange(opts, DEFAULT_SINCE);
  const match = INTERVAL_PATTERN.exec(opts.interval.trim());
  if (match === null || Number(match[1]) === 0) {
    throw new CfMetricsError(
      "CONFIG",
      `Invalid --interval value "${opts.interval}" (expected a duration like "10m", "1h", "30s", or "500ms")`,
    );
  }
}

async function runHistory(opts: HistoryOpts): Promise<void> {
  if (opts.name.length === 0) {
    throw new CfMetricsError("CONFIG", "At least one --name is required (use `cf-metrics names` to discover names first)");
  }
  checkTimeOptions(opts);
  const format = parseFormat(opts.format);
  const since = opts.since ?? DEFAULT_SINCE;
  // Parsed here rather than inside the client callback so a bad --kind fails in
  // milliseconds like every other flag, instead of after a ~20s CF login.
  const overrideKind = opts.kind === undefined ? undefined : parseMetricKind(opts.kind);

  // Rows are collected across every --name and emitted ONCE. Emitting inside
  // the loop produced one independent document per name, so `--format json`
  // with two --name flags wrote two concatenated arrays — not parseable JSON —
  // while still exiting 0, and `--format csv` grew a second header row midway.
  // With more than one name a NAME column keeps the combined rows attributable.
  const multiple = opts.name.length > 1;

  // Accumulated *inside* the callback and returned, never into a variable that
  // outlives it: `withOpenSearchClient` deliberately re-runs this whole
  // function when a cached credential turns out to be rejected (HTTP 401/403),
  // so an accumulator declared outside would keep the rows from the abandoned
  // first attempt and emit every already-fetched name twice, at exit 0 — and
  // persist the duplicates under `--save`.
  const collected = await withOpenSearchClient(opts, async (client) => {
    const rows: OutputRow[] = [];
    for (const name of opts.name) {
      let kind: MetricKind;
      if (overrideKind === undefined) {
        // Same window the chart below uses, so the kind that shapes the query
        // is the kind the charted data actually has — and so the warning's own
        // "in this window" is true of what it looked at.
        const resolution = await resolveMetricKind(client, opts.service, name, {
          since,
          ...(opts.until === undefined ? {} : { until: opts.until }),
        });
        kind = resolution.kind;
        // A name reporting more than one kind is not the expected multi-unit
        // case `units` already warns about below — it means the terms agg
        // above silently discarded a whole other series. See KindResolution.
        if (resolution.otherKinds.length > 0) {
          printNotice(
            `WARNING: "${name}" reports more than one kind in this window ` +
              `(${[resolution.kind, ...resolution.otherKinds].join(", ")}) — using ${resolution.kind} ` +
              "(the most common); pass --kind to force a different one.",
          );
        }
      } else {
        kind = overrideKind;
      }
      const result = await queryHistory(client, {
        service: opts.service,
        name,
        since,
        ...(opts.until === undefined ? {} : { until: opts.until }),
        ...(opts.unit === undefined ? {} : { unit: opts.unit }),
        interval: opts.interval,
        kind,
      });
      // A metric name is not guaranteed to be a single series: Cloud Foundry
      // publishes `container.cpu.usage` as both `unit="1"` (fraction of the
      // app's CPU entitlement) and `unit="cpu"` (fraction of one core), whose
      // values differ by ~17x. Averaging across them yields a number with no
      // physical meaning, and the blend looks entirely plausible — hence a
      // loud warning rather than a footnote.
      if (opts.unit === undefined && result.units.length > 1) {
        printNotice(
          `WARNING: "${name}" reports ${String(result.units.length)} different units in this window ` +
            `(${result.units.join(", ")}) — the values below average incommensurable series and are NOT meaningful. ` +
            `Re-run with --unit <${result.units[0] ?? "unit"}> to pick one.`,
        );
      }
      if (result.cumulativeWarning) {
        printNotice(
          `WARNING: "${name}" reports AGGREGATION_TEMPORALITY_CUMULATIVE — the SUM column below is the raw ` +
            "per-bucket sum, not delta-corrected (v1 limitation, see kind.ts)",
        );
      }
      if (multiple) {
        printNotice(`${name} (${kind}): ${String(result.rows.length)} buckets`);
        rows.push(...result.rows.map((row) => ({ NAME: name, ...row })));
      } else {
        rows.push(...result.rows);
      }
    }
    return rows;
  });

  await emitRows({
    command: multiple ? "history" : `history:${opts.name[0] ?? ""}`,
    format,
    save: opts.save,
    rows: collected,
  });
}

export function registerHistoryCommand(program: Command): void {
  const command = program
    .command("history")
    .description("time-bucketed values for one or more metric names, kind-aware (GAUGE/SUM/HISTOGRAM)");
  withServiceOption(command, true);
  command.option("--name <metric-name>", "metric name to chart (repeatable, required)", collectRepeatable, []);
  withTimeRangeOptions(command);
  command.option("--unit <unit>", "restrict to one unit, for a metric name that publishes more than one series");
  command.option("--interval <duration>", "bucket size, e.g. 10m, 1h", DEFAULT_HISTORY_INTERVAL);
  command.option("--kind <kind>", "skip kind auto-resolution: GAUGE, SUM, or HISTOGRAM");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runHistory(command.opts<HistoryOpts>());
  });
}
