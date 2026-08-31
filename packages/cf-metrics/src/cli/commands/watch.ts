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

  try {
    await withOpenSearchClient(opts, async (client) => {
      // Printed only once target/credential resolution has actually
      // succeeded — printing it earlier would claim "watching" right before
      // an unrelated target/credential failure aborts the command.
      printNotice(`watching ${opts.service}${opts.name === undefined ? "" : ` (${opts.name})`} — press Ctrl+C to stop`);
      await watchMetrics(
        client,
        {
          service: opts.service,
          ...(opts.name === undefined ? {} : { name: opts.name }),
          intervalMs: opts.interval,
          lookback: opts.lookback,
        },
        (source) => {
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
