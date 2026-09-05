import type { Command } from "commander";

import { DEFAULT_SINCE, DEFAULT_TOP_LIMIT } from "../../config.js";
import { parseMetricKind } from "../../kind.js";
import type { MetricKind } from "../../kind.js";
import { assertValidTimeRange } from "../../query-builder.js";
import { queryTop, resolveTopMetricKind } from "../../top.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { TopOpts } from "../commandTypes.js";
import { checkUpperLimit, emitRows, parseFormat, printNotice } from "../output.js";
import {
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withSaveOption,
  withTargetOptions,
  withTimeRangeOptions,
} from "../shared-options.js";

/** Fail fast on an unparseable --since/--until before any CF login or network call. */
async function runTop(opts: TopOpts): Promise<void> {
  checkUpperLimit(opts.limit);
  assertValidTimeRange(opts, DEFAULT_SINCE);
  const format = parseFormat(opts.format);
  const since = opts.since ?? DEFAULT_SINCE;
  // Parsed pre-network so a bad --kind fails fast, matching every other flag.
  const overrideKind = opts.kind === undefined ? undefined : parseMetricKind(opts.kind);
  // Collected, not printed, inside the callback: a rejected cached credential
  // re-runs it, and a notice written from in here appears once per attempt.
  const kindWarnings: string[] = [];
  const result = await withOpenSearchClient(opts, async (client) => {
    kindWarnings.length = 0;
    let kind: MetricKind | undefined = overrideKind;
    if (kind === undefined) {
      // Scoped to the ranking's own window: an all-time lookup answers with the
      // kind that dominated history rather than the one being ranked now.
      const resolution = await resolveTopMetricKind(client, opts.name, {
        since,
        ...(opts.until === undefined ? {} : { until: opts.until }),
      });
      kind = resolution?.kind;
      // Same anomaly `history` warns about: more than one kind for this name
      // means the terms agg silently discarded a whole other series before
      // ranking ever saw it.
      if (resolution !== undefined && resolution.otherKinds.length > 0) {
        kindWarnings.push(
          `WARNING: "${opts.name}" reports more than one kind in this window ` +
            `(${[resolution.kind, ...resolution.otherKinds].join(", ")}) — ranking as ${resolution.kind} ` +
            "(the most common); pass --kind to force a different one.",
        );
      }
    }
    return await queryTop(client, {
      name: opts.name,
      since,
      ...(opts.until === undefined ? {} : { until: opts.until }),
      ...(opts.unit === undefined ? {} : { unit: opts.unit }),
      limit: opts.limit,
      ...(kind === undefined ? {} : { kind }),
    });
  });
  for (const warning of kindWarnings) {
    printNotice(warning);
  }
  // See the same guard in `history`: a name that publishes several units ranks
  // apps on a blend of incommensurable series, which looks perfectly plausible.
  if (opts.unit === undefined && result.units.length > 1) {
    printNotice(
      `WARNING: "${opts.name}" reports ${String(result.units.length)} different units in this window ` +
        `(${result.units.join(", ")}) — this ranking blends incommensurable series and is NOT meaningful. ` +
        `Re-run with --unit <${result.units[0] ?? "unit"}> to pick one.`,
    );
  }
  await emitRows({ command: "top", format, save: opts.save, rows: result.rows });
}

export function registerTopCommand(program: Command): void {
  const command = program
    .command("top")
    .description("cross-app outlier ranking for one metric name — which apps have the highest CPU/memory over a range")
    .requiredOption("--name <metric-name>", "metric name to rank apps by");
  withTimeRangeOptions(command);
  withLimitOption(command, DEFAULT_TOP_LIMIT, "maximum apps to return (0 for all)");
  command.option("--unit <unit>", "restrict to one unit, for a metric name that publishes more than one series");
  command.option("--kind <kind>", "skip kind auto-resolution: GAUGE, SUM, or HISTOGRAM");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runTop(command.opts<TopOpts>());
  });
}
