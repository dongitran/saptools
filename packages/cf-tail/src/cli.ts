import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveApiEndpoint } from "@saptools/cf-logs";
import type { LogLevel } from "@saptools/cf-logs";
import { Command } from "commander";

import {
  addAppSelectionOptions,
  addConcurrencyOptions,
  addOutputOptions,
  addRedactionOptions,
  addRowFilterOptions,
  addSessionOptions,
  addStreamOptions,
  buildAppFilterInput,
  buildRowFilterOptions,
  buildSession,
  resolveRediscoverIntervalMs,
  type AppSelectionFlags,
  type ConcurrencyFlags,
  type OutputFlags,
  type RedactionFlags,
  type RowFilterFlags,
  type SessionFlags,
  type StreamSpecificFlags,
} from "./cli/options.js";
import {
  bindTerminationSignals,
  printAppErrors,
  shouldUseColor,
  suppressBrokenPipe,
  writeJson,
  writeJsonLine,
  writeRaw,
} from "./cli/output.js";
import { discoverMatchingApps } from "./discovery.js";
import { filterTailRows } from "./filters.js";
import { formatGroupedByApp, formatRowsText } from "./format.js";
import { tagRowsWithApp } from "./merge.js";
import { cfTailStorePath } from "./paths.js";
import { CfTailRuntime } from "./runtime.js";
import { fetchMultiSnapshot } from "./snapshot.js";
import { clearTailStore, persistTailSnapshot, readTailStore } from "./store.js";
import { summarizeRows } from "./summary.js";
import type {
  AppSnapshotResult,
  CfTailEvent,
  MultiSnapshotResult,
  TailLogRow,
  TailStoreEntry,
} from "./types.js";

interface AppsCommandFlags extends SessionFlags, AppSelectionFlags {
  readonly json?: boolean;
}

interface SnapshotCommandFlags
  extends SessionFlags,
    AppSelectionFlags,
    RedactionFlags,
    RowFilterFlags,
    OutputFlags,
    ConcurrencyFlags {
  readonly save?: boolean;
}

interface SummaryCommandFlags
  extends SessionFlags,
    AppSelectionFlags,
    RedactionFlags,
    RowFilterFlags,
    ConcurrencyFlags {
  readonly json?: boolean;
}

interface ErrorsCommandFlags
  extends SessionFlags,
    AppSelectionFlags,
    RedactionFlags,
    Omit<RowFilterFlags, "level">,
    OutputFlags,
    ConcurrencyFlags {}

interface StreamCommandFlags
  extends SessionFlags,
    AppSelectionFlags,
    RedactionFlags,
    Pick<RowFilterFlags, "level" | "search" | "source" | "tenant" | "status" | "stream">,
    OutputFlags,
    StreamSpecificFlags {}

interface StoreListFlags {
  readonly json?: boolean;
}

function tagAllAppRows(apps: readonly AppSnapshotResult[]): readonly TailLogRow[] {
  const tagged: TailLogRow[] = [];
  for (const app of apps) {
    tagged.push(...tagRowsWithApp(app.appName, app.rows));
  }
  return tagged;
}

function snapshotResultToJson(
  result: MultiSnapshotResult,
  rows: readonly TailLogRow[],
): unknown {
  return {
    fetchedAt: result.fetchedAt,
    appCount: result.apps.length,
    rowCount: rows.length,
    apps: result.apps.map((entry) => ({
      appName: entry.appName,
      rowCount: entry.rows.length,
      truncated: entry.truncated,
      fetchedAt: entry.fetchedAt,
    })),
    errors: result.errors,
    rows,
  };
}

async function runApps(flags: AppsCommandFlags): Promise<void> {
  const session = buildSession(flags);
  const filterInput = buildAppFilterInput(flags);
  const apps = await discoverMatchingApps({ ...session, ...filterInput });
  if (flags.json === true) {
    writeJson(apps);
    return;
  }
  if (apps.length === 0) {
    process.stdout.write("(no matching apps)\n");
    return;
  }
  for (const app of apps) {
    process.stdout.write(`${app.name}\t${app.runningInstances.toString()}\n`);
  }
}

async function runSnapshot(flags: SnapshotCommandFlags): Promise<void> {
  const session = buildSession(flags);
  const filterInput = buildAppFilterInput(flags);
  const result = await fetchMultiSnapshot({
    ...session,
    ...filterInput,
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.logLimit === undefined ? {} : { logLimit: flags.logLimit }),
    ...(flags.extraSecret === undefined ? {} : { extraSecrets: flags.extraSecret }),
    persist: flags.save === true,
  });
  const filterOptions = buildRowFilterOptions(flags);
  const rows = filterTailRows(tagAllAppRows(result.apps), filterOptions);

  if (flags.save === true) {
    await persistTailSnapshot({
      key: {
        apiEndpoint: resolveApiEndpoint(session),
        org: session.org,
        space: session.space,
      },
      fetchedAt: result.fetchedAt,
      apps: result.apps,
    });
  }

  if (flags.ndjson === true) {
    for (const row of rows) {
      writeJsonLine(row);
    }
    for (const error of result.errors) {
      writeJsonLine({ type: "error", ...error });
    }
    return;
  }

  if (flags.json === true) {
    writeJson(snapshotResultToJson(result, rows));
    return;
  }

  printAppErrors(result.errors);

  if (rows.length === 0) {
    process.stdout.write("(no rows matched)\n");
    return;
  }
  const formatOptions = {
    color: shouldUseColor(flags),
    showSource: flags.showSource === true,
    showRequestMeta: true,
    ...(flags.truncate === undefined ? {} : { truncateMessage: flags.truncate }),
  };
  if (flags.byApp === true) {
    writeRaw(formatGroupedByApp(rows, formatOptions));
    return;
  }
  writeRaw(formatRowsText(rows, formatOptions));
}

async function runErrors(flags: ErrorsCommandFlags): Promise<void> {
  await runSnapshot({ ...flags, level: "error" });
}

async function runSummary(flags: SummaryCommandFlags): Promise<void> {
  const session = buildSession(flags);
  const filterInput = buildAppFilterInput(flags);
  const result = await fetchMultiSnapshot({
    ...session,
    ...filterInput,
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.logLimit === undefined ? {} : { logLimit: flags.logLimit }),
    ...(flags.extraSecret === undefined ? {} : { extraSecrets: flags.extraSecret }),
  });
  const filterOptions = buildRowFilterOptions(flags);
  const rows = filterTailRows(tagAllAppRows(result.apps), filterOptions);
  const summary = summarizeRows(rows);
  if (flags.json === true) {
    writeJson({
      fetchedAt: result.fetchedAt,
      summary: {
        total: summary.total,
        levels: summary.levels,
        apps: summary.apps.map((app) => ({
          appName: app.appName,
          total: app.total,
          levels: app.levels,
          sources: Object.fromEntries(app.sources),
          statusBuckets: Object.fromEntries(app.statusBuckets),
          tenants: Object.fromEntries(app.tenants),
          firstAt: app.firstAt,
          lastAt: app.lastAt,
        })),
      },
      errors: result.errors,
    });
    return;
  }
  printAppErrors(result.errors);
  if (summary.total === 0) {
    process.stdout.write("(no rows matched)\n");
    return;
  }
  process.stdout.write(`Total rows: ${summary.total.toString()}\n`);
  process.stdout.write(formatLevelLine("All apps", summary.levels));
  process.stdout.write("\n");
  for (const appSummary of summary.apps) {
    process.stdout.write(formatLevelLine(appSummary.appName, appSummary.levels));
    if (appSummary.statusBuckets.size > 0) {
      const statusEntries = [...appSummary.statusBuckets.entries()]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => `${key}=${value.toString()}`)
        .join(" ");
      process.stdout.write(`  status: ${statusEntries}\n`);
    }
    if (appSummary.tenants.size > 0) {
      const tenantEntries = [...appSummary.tenants.entries()]
        .sort(([, leftValue], [, rightValue]) => rightValue - leftValue)
        .slice(0, 5)
        .map(([key, value]) => `${key}=${value.toString()}`)
        .join(" ");
      process.stdout.write(`  tenants: ${tenantEntries}\n`);
    }
  }
}

function formatLevelLine(label: string, levels: Readonly<Record<LogLevel, number>>): string {
  const entries = (["fatal", "error", "warn", "info", "debug", "trace"] as const).map(
    (level) => `${level}=${levels[level].toString()}`,
  );
  return `${label}\t${entries.join(" ")}\n`;
}

async function runStream(flags: StreamCommandFlags): Promise<void> {
  const session = buildSession(flags);
  const filterInput = buildAppFilterInput(flags);
  const rediscoverMs = resolveRediscoverIntervalMs(flags.rediscover);
  const runtime = new CfTailRuntime({
    ...(flags.logLimit === undefined ? {} : { logLimit: flags.logLimit }),
    ...(flags.flushIntervalMs === undefined ? {} : { flushIntervalMs: flags.flushIntervalMs }),
    ...(flags.retryInitialMs === undefined ? {} : { retryInitialMs: flags.retryInitialMs }),
    ...(flags.retryMaxMs === undefined ? {} : { retryMaxMs: flags.retryMaxMs }),
    ...(rediscoverMs === undefined ? {} : { rediscoverIntervalMs: rediscoverMs }),
    ...(flags.save === true ? { persistStreamAppends: true } : {}),
    ...(flags.extraSecret === undefined ? {} : { extraSecrets: flags.extraSecret }),
  });
  runtime.setSession(session);
  runtime.setAppFilter(filterInput);

  const useColor = shouldUseColor(flags);
  const useJson = flags.json === true || flags.ndjson === true;
  const filterOptions = buildRowFilterOptions(flags);
  const formatOptions = {
    color: useColor,
    showSource: flags.showSource === true,
    showRequestMeta: true,
    ...(flags.truncate === undefined ? {} : { truncateMessage: flags.truncate }),
  };
  const quiet = flags.quiet === true && !useJson;
  let emittedRowCount = 0;
  let finished = false;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanupHandlers = bindTerminationSignals(async (): Promise<void> => {
      await shutdown();
    });

    const handleEvent = (event: CfTailEvent): void => {
      if (event.type === "discovery") {
        emitDiscoveryEvent(event, useJson, quiet);
        return;
      }
      if (event.type === "discovery-error") {
        emitDiscoveryErrorEvent(event, useJson);
        return;
      }
      if (event.type === "stream-state") {
        emitStreamStateEvent(event, useJson, quiet);
        return;
      }
      const tailRows = filterTailRows(event.rows, filterOptions);
      if (tailRows.length === 0) {
        return;
      }
      const remaining =
        flags.maxLines === undefined ? tailRows.length : flags.maxLines - emittedRowCount;
      if (remaining <= 0) {
        return;
      }
      const limitedRows = tailRows.length <= remaining ? tailRows : tailRows.slice(0, remaining);
      emittedRowCount += limitedRows.length;
      if (useJson) {
        if (flags.ndjson === true) {
          for (const row of limitedRows) {
            writeJsonLine(row);
          }
        } else {
          writeJsonLine({ type: "lines", appName: event.appName, rows: limitedRows });
        }
      } else {
        process.stdout.write(`${formatRowsText(limitedRows, formatOptions)}\n`);
      }
      if (flags.maxLines !== undefined && emittedRowCount >= flags.maxLines) {
        void shutdown();
      }
    };

    const unsubscribe = runtime.subscribe(handleEvent);

    const shutdown = async (): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupHandlers();
      unsubscribe();
      await runtime.stop();
      resolvePromise();
    };

    runtime.start().catch(async (error: unknown) => {
      cleanupHandlers();
      unsubscribe();
      await runtime.stop();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function emitDiscoveryEvent(
  event: Extract<CfTailEvent, { readonly type: "discovery" }>,
  useJson: boolean,
  quiet: boolean,
): void {
  if (useJson) {
    writeJsonLine({
      type: "discovery",
      apps: event.apps.map((app) => app.name),
      addedApps: event.addedApps,
      removedApps: event.removedApps,
      initial: event.initial,
      changed: event.changed,
      at: event.at,
    });
    return;
  }
  if (quiet) {
    return;
  }
  if (!event.initial && !event.changed) {
    return;
  }
  process.stderr.write(
    `[discovery] ${event.apps.length.toString()} apps (added: ${event.addedApps.join(",")}; removed: ${event.removedApps.join(",")})\n`,
  );
}

function emitDiscoveryErrorEvent(
  event: Extract<CfTailEvent, { readonly type: "discovery-error" }>,
  useJson: boolean,
): void {
  if (useJson) {
    writeJsonLine({ type: "discovery-error", message: event.message, at: event.at });
    return;
  }
  process.stderr.write(`[discovery-error] ${event.message}\n`);
}

function emitStreamStateEvent(
  event: Extract<CfTailEvent, { readonly type: "stream-state" }>,
  useJson: boolean,
  quiet: boolean,
): void {
  if (useJson) {
    writeJsonLine({
      type: "stream-state",
      appName: event.appName,
      status: event.streamState.status,
      updatedAt: event.streamState.updatedAt,
      ...(event.streamState.message === undefined ? {} : { message: event.streamState.message }),
    });
    return;
  }
  if (quiet) {
    return;
  }
  const message = event.streamState.message === undefined ? "" : ` ${event.streamState.message}`;
  process.stderr.write(`[${event.appName}] ${event.streamState.status}${message}\n`);
}

async function runStoreList(flags: StoreListFlags): Promise<void> {
  const store = await readTailStore();
  if (flags.json === true) {
    writeJson(store);
    return;
  }
  if (store.entries.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }
  for (const entry of store.entries) {
    process.stdout.write(`${formatStoreEntry(entry)}\n`);
  }
}

function formatStoreEntry(entry: TailStoreEntry): string {
  return [
    entry.key.apiEndpoint,
    `${entry.key.org}/${entry.key.space}`,
    `apps=${entry.appCount.toString()}`,
    `rows=${entry.rowCount.toString()}`,
    `updatedAt=${entry.updatedAt}`,
  ].join("\t");
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { readonly version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("cf-tail")
    .description(
      `Aggregate CF logs across every app in a space (cache: ${cfTailStorePath()})`,
    )
    .version(readPackageVersion(), "-V, --version", "Print the cf-tail package version");

  addAppSelectionOptions(
    addSessionOptions(
      program
        .command("apps")
        .description("List started apps in a CF org/space matching include/exclude filters"),
    ),
  )
    .option("--json", "Emit JSON instead of tab-separated output", false)
    .action(async (flags: AppsCommandFlags): Promise<void> => {
      await runApps(flags);
    });

  addOutputOptions(
    addRowFilterOptions(
      addRedactionOptions(
        addConcurrencyOptions(
          addAppSelectionOptions(
            addSessionOptions(
              program
                .command("snapshot")
                .description(
                  "Fetch recent logs for every matching app in parallel and merge by timestamp",
                ),
            ),
          ),
        ),
      ),
    ),
  )
    .option("--save", "Persist redacted per-app snapshots and an aggregate store entry", false)
    .action(async (flags: SnapshotCommandFlags): Promise<void> => {
      await runSnapshot(flags);
    });

  addOutputOptions(
    addRowFilterOptions(
      addRedactionOptions(
        addConcurrencyOptions(
          addAppSelectionOptions(
            addSessionOptions(
              program
                .command("errors")
                .description(
                  "Convenience: snapshot every matching app and keep only error-level rows",
                ),
            ),
          ),
        ),
      ),
      { omitLevel: true },
    ),
  ).action(async (flags: ErrorsCommandFlags): Promise<void> => {
    await runErrors(flags);
  });

  addRowFilterOptions(
    addRedactionOptions(
      addConcurrencyOptions(
        addAppSelectionOptions(
          addSessionOptions(
            program
              .command("summary")
              .description(
                "Aggregate parsed log counts per app, level, source, status, and tenant",
              ),
          ),
        ),
      ),
    ),
  )
    .option("--json", "Emit JSON instead of tab-separated output", false)
    .action(async (flags: SummaryCommandFlags): Promise<void> => {
      await runSummary(flags);
    });

  addStreamOptions(
    addOutputOptions(
      addRowFilterOptions(
        addRedactionOptions(
          addAppSelectionOptions(
            addSessionOptions(
              program
                .command("stream")
                .description(
                  "Multiplex live logs from every matching app with optional rediscovery",
                ),
            ),
          ),
        ),
      ),
    ),
  ).action(async (flags: StreamCommandFlags): Promise<void> => {
    await runStream(flags);
  });

  const store = program.command("store").description("Inspect the cf-tail aggregate store");
  store
    .command("path")
    .description("Print the local cf-tail store path")
    .action((): void => {
      process.stdout.write(`${cfTailStorePath()}\n`);
    });

  store
    .command("list")
    .description("List cached cf-tail store entries")
    .option("--json", "Emit the full store as JSON", false)
    .action(async (flags: StoreListFlags): Promise<void> => {
      await runStoreList(flags);
    });

  store
    .command("clear")
    .description("Remove every cached entry from the cf-tail store")
    .action(async (): Promise<void> => {
      await clearTailStore();
      process.stdout.write(`Cleared ${cfTailStorePath()}\n`);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync([...argv]);
}

function isMainModule(): boolean {
  const executedPath = process.argv[1];
  if (executedPath === undefined) {
    return false;
  }
  try {
    return realpathSync(executedPath) === fileURLToPath(import.meta.url);
  } catch {
    return resolve(executedPath) === fileURLToPath(import.meta.url);
  }
}

async function runCli(): Promise<void> {
  suppressBrokenPipe();
  try {
    await main(process.argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

if (isMainModule()) {
  await runCli();
}
