import process from "node:process";

import { Command } from "commander";

import { createTemporaryCfHome, removeTemporaryCfHome } from "../cf.js";
import { LiveTraceSession } from "../session.js";
import type { LiveTraceEvent, LiveTraceStateEvent, LiveTraceStopReason } from "../types.js";

import { buildRunOptionsWithCurrentTarget, type CliFlags, type RunOptions } from "./options.js";
import { writeJson, writeJsonLine, writeLog, writeProgress, writeSummaryLine } from "./output.js";

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("cf-live-trace")
    .description("Inject a runtime HTTP trace hook into a Cloud Foundry Node.js app and stream request/response events")
    .option("-r, --region <key>", "CF region key (default: current cf target)")
    .option("--api-endpoint <url>", "Explicit CF API endpoint")
    .option("-o, --org <name>", "CF org name (default: current cf target)")
    .option("-s, --space <name>", "CF space name (default: current cf target)")
    .requiredOption("-a, --app <name>", "CF app name")
    .option("--email <value>", "SAP email (default: SAP_EMAIL)")
    .option("--password <value>", "SAP password (default: SAP_PASSWORD)")
    .option("-i, --instance <index>", "CF app instance index (default: 0)")
    .option("--cf-home <dir>", "Use an existing CF_HOME instead of a temporary one")
    .option("--cf-command <path>", "CF CLI executable or test shim")
    .option("--duration <seconds>", "Stop after N seconds")
    .option("--max-events <count>", "Stop after N trace events")
    .option("--max-body-bytes <bytes>", "Maximum request/response preview bytes; 0 keeps unlimited previews locally", "4096")
    .option("--no-capture-headers", "Do not capture request/response headers")
    .option("--no-capture-request-body", "Do not capture request body previews")
    .option("--no-capture-response-body", "Do not capture response body previews")
    .option("--no-uninstall-on-exit", "Disable the runtime hook instead of uninstalling it on exit")
    .option("--format <format>", "Output format: ndjson, summary, json", "ndjson")
    .option("--quiet", "Suppress progress messages on stderr")
    .action(async (flags: CliFlags): Promise<void> => {
      await runTraceCommand(await buildRunOptionsWithCurrentTarget(flags, process.env));
    });

  await program.parseAsync([...argv]);
}

export async function runTraceCommand(options: RunOptions): Promise<void> {
  const cfHome = await resolveCfHome(options);
  try {
    const events: LiveTraceEvent[] = [];
    const eventLimit = createEventLimit(options);
    const runtimeError = createRuntimeErrorStopWaiter();
    const session = new LiveTraceSession({
      target: { ...options.target, cfHomeDir: cfHome.path },
      onState: (event) => {
        if (!options.quiet) {
          writeProgress(event);
        }
        runtimeError.report(event);
      },
      onLog: (message) => {
        if (!options.quiet) {
          writeLog(message);
        }
      },
      onEvents: (batch) => {
        handleEvents(batch, options, events);
        eventLimit.check(events.length);
      },
    });
    await runUntilStopped(session, options, eventLimit, runtimeError);
    if (options.format === "json") {
      writeJson({ events });
    }
  } finally {
    await cfHome.dispose();
  }
}

function handleEvents(batch: readonly LiveTraceEvent[], options: RunOptions, events: LiveTraceEvent[]): void {
  for (const event of batch) {
    events.push(event);
    if (options.format === "ndjson") {
      writeJsonLine(event);
    }
    if (options.format === "summary") {
      writeSummaryLine(event);
    }
  }
}

async function runUntilStopped(
  session: LiveTraceSession,
  options: RunOptions,
  eventLimit: StopWaiter & { readonly check: (count: number) => void },
  runtimeError: RuntimeErrorStopWaiter,
): Promise<void> {
  const abort = createAbortPromise();
  const duration = createDurationStopWaiter(options.limits.durationMs);
  let stopReason: LiveTraceStopReason = "user";
  let failed = false;
  try {
    await session.start(options.trace);
    stopReason = await waitForStop([abort, eventLimit, duration, runtimeError]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    abort.cleanup();
    duration.cleanup();
    eventLimit.cleanup();
    runtimeError.cleanup();
    await session.stop({ uninstallRuntimeHook: options.uninstallOnExit, reason: failed ? "error" : stopReason });
  }
}

interface StopWaiter {
  readonly promise: Promise<LiveTraceStopReason>;
  cleanup(): void;
}

interface RuntimeErrorStopWaiter extends StopWaiter {
  report(event: LiveTraceStateEvent): void;
}

async function waitForStop(waiters: readonly StopWaiter[]): Promise<LiveTraceStopReason> {
  return await Promise.race(waiters.map((waiter) => waiter.promise));
}

function createDurationStopWaiter(durationMs: number | undefined): StopWaiter {
  if (durationMs === undefined) {
    return createNeverStopWaiter();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<LiveTraceStopReason>((resolve) => {
    timer = setTimeout(() => {
      resolve("duration");
    }, durationMs);
  });
  return {
    promise,
    cleanup: (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

function createAbortPromise(): { readonly promise: Promise<LiveTraceStopReason>; readonly cleanup: () => void } {
  let resolveStop: (reason: LiveTraceStopReason) => void = () => {
    return;
  };
  const promise = new Promise<LiveTraceStopReason>((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = (): void => {
    resolveStop("user");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    promise,
    cleanup: (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

function createNeverStopWaiter(): StopWaiter {
  return {
    promise: new Promise<LiveTraceStopReason>(() => {
      return;
    }),
    cleanup: (): void => {
      return;
    },
  };
}

function createRuntimeErrorStopWaiter(): RuntimeErrorStopWaiter {
  let hasStreamed = false;
  let settled = false;
  let rejectStop: (error: Error) => void = () => {
    return;
  };
  const promise = new Promise<LiveTraceStopReason>((_resolve, reject) => {
    rejectStop = reject;
  });
  promise.catch(() => {
    return;
  });
  return {
    promise,
    report: (event): void => {
      if (event.state === "streaming") {
        hasStreamed = true;
        return;
      }
      if (event.state !== "error" || !hasStreamed || settled) {
        return;
      }
      settled = true;
      rejectStop(new Error(event.message));
    },
    cleanup: (): void => {
      settled = true;
    },
  };
}

function createEventLimit(options: RunOptions): {
  readonly promise: Promise<LiveTraceStopReason>;
  readonly check: (count: number) => void;
  readonly cleanup: () => void;
} {
  if (options.limits.maxEvents === undefined) {
    return {
      ...createNeverStopWaiter(),
      check: (): void => {
        return;
      },
    };
  }
  let resolveLimit: (reason: LiveTraceStopReason) => void = () => {
    return;
  };
  const promise = new Promise<LiveTraceStopReason>((resolve) => {
    resolveLimit = resolve;
  });
  return {
    promise,
    check: (count): void => {
      if (options.limits.maxEvents !== undefined && count >= options.limits.maxEvents) {
        resolveLimit("max-events");
      }
    },
    cleanup: (): void => {
      return;
    },
  };
}

async function resolveCfHome(options: RunOptions): Promise<{ readonly path: string; readonly dispose: () => Promise<void> }> {
  if (options.target.cfHomeDir !== undefined) {
    return {
      path: options.target.cfHomeDir,
      dispose: (): Promise<void> => Promise.resolve(),
    };
  }
  const path = await createTemporaryCfHome();
  return {
    path,
    dispose: async (): Promise<void> => {
      await removeTemporaryCfHome(path);
    },
  };
}
