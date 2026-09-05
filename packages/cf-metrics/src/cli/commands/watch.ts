import type { Command } from "commander";

import { MIN_WATCH_INTERVAL_MS } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import { assertValidTimeBoundShape } from "../../query-builder.js";
import { watchMetrics } from "../../watch.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { WatchOpts } from "../commandTypes.js";
import { print, printNotice } from "../output.js";
import { withCredentialOptions, withServiceOption, withTargetOptions, withWatchOptions } from "../shared-options.js";

function bindTerminationSignals(stop: () => void): () => void {
  const handler = (): void => {
    stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function displayValue(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function formatWatchLine(source: Readonly<Record<string, unknown>>): string {
  const time = typeof source["time"] === "string" ? source["time"] : "";
  const name = typeof source["name"] === "string" ? source["name"] : "";
  const value = displayValue(source["value"] ?? source["sum"]);
  const unit = typeof source["unit"] === "string" ? source["unit"] : "";
  return `${time}  ${name}  ${value}${unit.length > 0 ? ` ${unit}` : ""}`;
}

async function runWatch(opts: WatchOpts): Promise<void> {
  if (opts.interval < MIN_WATCH_INTERVAL_MS) {
    throw new CfMetricsError("CONFIG", `--interval must be at least ${String(MIN_WATCH_INTERVAL_MS)}ms`);
  }
  assertValidTimeBoundShape("--lookback", opts.lookback);
  const controller = new AbortController();
  const cleanup = bindTerminationSignals(() => {
    controller.abort();
  });

  // Survives a retry on purpose. `watchMetrics` re-seeds its cursor from
  // `--lookback` every time it is entered, and `withOpenSearchClient` re-enters
  // it when a cached credential is rejected mid-session — so without this, a
  // 401 an hour into a watch replays the whole lookback window as duplicate
  // output. `watchMetrics`'s own dedup set only covers ties at its current
  // cursor, which a fresh start discards.
  let lastPrintedTime = "";
  let started = false;
  // Only ever true while catching back up after a retry. In steady state
  // `watchMetrics` dedups by document id, so two genuinely distinct points
  // sharing a timestamp must both print; filtering on time alone would drop
  // the second one. This narrows that filter to the replayed window.
  let replaying = false;

  try {
    await withOpenSearchClient(opts, async (client) => {
      // Printed only once target/credential resolution has actually
      // succeeded — printing it earlier would claim "watching" right before
      // an unrelated target/credential failure aborts the command. On a retry
      // the session is already announced, so saying it again reads as a second
      // watch starting.
      if (started) {
        replaying = true;
      } else {
        printNotice(`watching ${opts.service}${opts.name === undefined ? "" : ` (${opts.name})`} — press Ctrl+C to stop`);
        started = true;
      }
      await watchMetrics(
        client,
        {
          service: opts.service,
          ...(opts.name === undefined ? {} : { name: opts.name }),
          intervalMs: opts.interval,
          lookback: opts.lookback,
        },
        (source) => {
          const time = typeof source["time"] === "string" ? source["time"] : "";
          if (replaying) {
            // `<=` rather than `<`: a point sharing the newest printed
            // timestamp was already emitted by the abandoned attempt, and the
            // re-fetch cannot tell the two apart. Erring toward one dropped
            // duplicate beats erring toward a replayed window.
            if (time !== "" && time <= lastPrintedTime) {
              return;
            }
            // Past the replayed window; dedup goes back to `watchMetrics`.
            replaying = false;
          }
          lastPrintedTime = time > lastPrintedTime ? time : lastPrintedTime;
          if (opts.json) {
            print(JSON.stringify(source));
            return;
          }
          print(formatWatchLine(source));
        },
        controller.signal,
        (message) => {
          printNotice(message);
        },
      );
    });
  } finally {
    cleanup();
  }
}

export function registerWatchCommand(program: Command): void {
  const command = program.command("watch").description("poll for new metric points as they land — live monitoring during a deploy or incident");
  withServiceOption(command, true);
  command.option("--name <metric-name>", "restrict to one metric name (omit to watch every metric for the service)");
  withWatchOptions(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runWatch(command.opts<WatchOpts>());
  });
}
