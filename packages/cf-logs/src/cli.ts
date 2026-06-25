import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { fetchStartedAppsViaCfCli } from "./cf.js";
import {
  buildSnapshotCompactDocument,
  createCompactStreamSession,
  printCompactAppendRows,
} from "./cli-compact.js";
import type { SessionListFlags, ShowFlags } from "./cli-sessions.js";
import {
  runSessionClear,
  runSessionList,
  runSessionPrune,
  runShow,
} from "./cli-sessions.js";
import { formatCompactLogDocument } from "./compact.js";
import { cfLogsStorePath } from "./paths.js";
import { CfLogsRuntime } from "./runtime.js";
import { clearStore, readStore } from "./store.js";
import { parseSinceDurationMs } from "./time-window.js";
import { LOG_LEVELS } from "./types.js";
import type {
  CfLogsRuntimeEvent,
  CfLogsRuntimeOptions,
  CfSessionInput,
  FilterRowsOptions,
  LogLevel,
  LogStoreEntry,
  ParseLogsOptions,
  RuntimeStreamState,
} from "./types.js";

interface SessionFlags {
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org?: string;
  readonly space?: string;
  readonly email?: string;
  readonly password?: string;
}

interface AppFlags extends SessionFlags {
  readonly app?: string;
}

interface SnapshotFlags extends AppFlags {
  readonly json?: boolean;
  readonly save?: boolean;
  readonly logLimit?: number;
  readonly since?: number;
  readonly search?: string;
  readonly minLevel?: LogLevel;
  readonly compact?: boolean;
  readonly compactMessageLimit?: number;
  readonly compactTtlMinutes?: number;
}

interface StreamFlags extends AppFlags {
  readonly json?: boolean;
  readonly save?: boolean;
  readonly maxLines?: number;
  readonly logLimit?: number;
  readonly search?: string;
  readonly minLevel?: LogLevel;
  readonly flushIntervalMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly compact?: boolean;
  readonly compactMessageLimit?: number;
  readonly compactTtlMinutes?: number;
}

interface AppsFlags extends SessionFlags {
  readonly json?: boolean;
}

interface StoreListFlags {
  readonly json?: boolean;
}

function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function resolveCredential(value: string | undefined, envName: string): string {
  const directValue = value?.trim();
  if (directValue !== undefined && directValue.length > 0) {
    return directValue;
  }
  const envValue = process.env[envName]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }
  throw new Error(`Missing required environment variable: ${envName}`);
}

function requireTarget(flags: SessionFlags): void {
  if ((flags.region ?? "").trim().length > 0 || (flags.apiEndpoint ?? "").trim().length > 0) {
    return;
  }
  throw new Error("Either --region or --api-endpoint is required.");
}

function buildSession(flags: SessionFlags): CfSessionInput {
  requireTarget(flags);
  return {
    ...(flags.apiEndpoint === undefined ? {} : { apiEndpoint: requireText(flags.apiEndpoint, "--api-endpoint") }),
    ...(flags.region === undefined ? {} : { region: requireText(flags.region, "--region") }),
    email: resolveCredential(flags.email, "SAP_EMAIL"),
    password: resolveCredential(flags.password, "SAP_PASSWORD"),
    org: requireText(flags.org, "--org"),
    space: requireText(flags.space, "--space"),
  };
}

function buildAppRef(flags: AppFlags): { readonly session: CfSessionInput; readonly appName: string } {
  return {
    session: buildSession(flags),
    appName: requireText(flags.app, "--app"),
  };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function parseSearchTerm(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("--search must not be empty.");
  }
  return trimmed;
}

function parseLogLevel(value: string, optionName: string): LogLevel {
  const normalized = value.trim().toLowerCase();
  const level = LOG_LEVELS.find((candidate) => candidate === normalized);
  if (level === undefined) {
    throw new Error(`${optionName} must be one of: ${LOG_LEVELS.join(", ")}.`);
  }
  return level;
}

function buildParseOptions(logLimit: number | undefined): ParseLogsOptions {
  return logLimit === undefined ? {} : { logLimit };
}

function buildRowFilterOptions(flags: Pick<SnapshotFlags, "search" | "minLevel">): FilterRowsOptions | undefined {
  if (flags.search === undefined && flags.minLevel === undefined) {
    return undefined;
  }
  return {
    ...(flags.search === undefined ? {} : { searchTerm: flags.search }),
    ...(flags.minLevel === undefined ? {} : { minLevel: flags.minLevel }),
  };
}

function buildSnapshotRuntimeOptions(flags: SnapshotFlags): CfLogsRuntimeOptions {
  const rowFilter = buildRowFilterOptions(flags);
  return {
    ...buildParseOptions(flags.logLimit),
    ...(flags.since === undefined ? {} : { sinceMs: flags.since }),
    ...(rowFilter === undefined ? {} : { rowFilter }),
    ...(flags.save === true && flags.compact !== true ? { persistSnapshots: true } : {}),
  };
}

function buildStreamRuntimeOptions(flags: StreamFlags): CfLogsRuntimeOptions {
  const rowFilter = buildRowFilterOptions(flags);
  return {
    ...buildParseOptions(flags.logLimit),
    ...(rowFilter === undefined ? {} : { rowFilter }),
    ...(flags.save === true && flags.compact !== true ? { persistStreamAppends: true } : {}),
    ...(flags.flushIntervalMs === undefined ? {} : { flushIntervalMs: flags.flushIntervalMs }),
    ...(flags.retryInitialMs === undefined ? {} : { retryInitialMs: flags.retryInitialMs }),
    ...(flags.retryMaxMs === undefined ? {} : { retryMaxMs: flags.retryMaxMs }),
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeRaw(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function toStatePayload(
  appName: string,
  streamState: RuntimeStreamState,
): {
  readonly type: "state";
  readonly appName: string;
  readonly status: RuntimeStreamState["status"];
  readonly updatedAt: string;
  readonly message?: string;
} {
  return {
    type: "state",
    appName,
    status: streamState.status,
    updatedAt: streamState.updatedAt,
    ...(streamState.message === undefined ? {} : { message: streamState.message }),
  };
}

function printState(appName: string, streamState: RuntimeStreamState, asJson: boolean): void {
  if (asJson) {
    writeJsonLine(toStatePayload(appName, streamState));
    return;
  }
  const message = streamState.message === undefined ? "" : ` ${streamState.message}`;
  process.stderr.write(`[${appName}] ${streamState.status}${message}\n`);
}

function printLines(appName: string, lines: readonly string[], asJson: boolean): number {
  if (asJson) {
    writeJsonLine({ type: "lines", appName, lines });
    return lines.length;
  }
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  return lines.length;
}

function addSessionOptions(command: Command): Command {
  return command
    .option("-r, --region <key>", "CF region key (e.g. ap10)")
    .option("--api-endpoint <url>", "Explicit CF API endpoint")
    .requiredOption("-o, --org <name>", "CF org name")
    .requiredOption("-s, --space <name>", "CF space name")
    .option("--email <value>", "SAP email (default: SAP_EMAIL)")
    .option("--password <value>", "SAP password (default: SAP_PASSWORD)");
}

function addAppOptions(command: Command): Command {
  return addSessionOptions(command).requiredOption("-a, --app <name>", "CF app name");
}

async function runSnapshot(flags: SnapshotFlags): Promise<void> {
  const { session, appName } = buildAppRef(flags);
  const runtime = new CfLogsRuntime(buildSnapshotRuntimeOptions(flags));
  runtime.setSession(session);
  runtime.setAvailableApps([{ name: appName, runningInstances: 1 }]);
  try {
    const snapshot = await runtime.fetchSnapshot(appName);
    if (flags.compact === true) {
      const compactDocument = await buildSnapshotCompactDocument(session, snapshot, flags);
      if (flags.json === true) {
        writeJson(compactDocument);
        return;
      }
      writeRaw(formatCompactLogDocument(compactDocument));
      return;
    }
    if (flags.json === true) {
      writeJson(snapshot);
      return;
    }
    writeRaw(snapshot.rawText);
  } finally {
    await runtime.dispose();
  }
}

async function runApps(flags: AppsFlags): Promise<void> {
  const session = buildSession(flags);
  const apps = await fetchStartedAppsViaCfCli(session);
  if (flags.json === true) {
    writeJson(apps);
    return;
  }
  for (const app of apps) {
    process.stdout.write(`${app.name}\t${app.runningInstances.toString()}\n`);
  }
}

function formatStoreEntry(entry: LogStoreEntry): string {
  return [
    entry.key.apiEndpoint,
    `${entry.key.org}/${entry.key.space}/${entry.key.app}`,
    `rows=${entry.rowCount.toString()}`,
    `truncated=${String(entry.truncated)}`,
    `updatedAt=${entry.updatedAt}`,
  ].join("\t");
}

async function runStoreList(flags: StoreListFlags): Promise<void> {
  const store = await readStore();
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

async function runStream(flags: StreamFlags): Promise<void> {
  const { session, appName } = buildAppRef(flags);
  const runtime = new CfLogsRuntime(buildStreamRuntimeOptions(flags));
  const compactSession = flags.compact === true
    ? await createCompactStreamSession(session, appName, flags)
    : undefined;
  let emittedLineCount = 0;
  let lastEmittedRowId = 0;
  let finished = false;
  runtime.setSession(session);
  runtime.setAvailableApps([{ name: appName, runningInstances: 1 }]);

  const waitForExit = new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanupHandlers = bindTerminationSignals(async (): Promise<void> => {
      await shutdown(resolvePromise);
    });
    const unsubscribe = runtime.subscribe((event) => {
      void handleStreamEvent(event, flags, appName);
    });

    const handleStreamEvent = async (
      event: CfLogsRuntimeEvent,
      currentFlags: StreamFlags,
      currentAppName: string,
    ): Promise<void> => {
      if (event.appName !== currentAppName) {
        return;
      }
      if (event.type === "stream-state") {
        printState(currentAppName, event.streamState, currentFlags.json === true);
        return;
      }
      if (event.type !== "append") {
        return;
      }
      let emittedCount: number;
      if (currentFlags.compact === true) {
        const remainingRows = currentFlags.maxLines === undefined
          ? undefined
          : currentFlags.maxLines - emittedLineCount;
        const result = await printCompactAppendRows(
          event,
          currentFlags,
          compactSession,
          lastEmittedRowId,
          remainingRows,
        );
        emittedCount = result.emittedCount;
        lastEmittedRowId = result.lastRowId ?? lastEmittedRowId;
      } else {
        emittedCount = printLines(currentAppName, event.lines, currentFlags.json === true);
      }
      emittedLineCount += emittedCount;
      if (currentFlags.maxLines !== undefined && emittedLineCount >= currentFlags.maxLines) {
        await shutdown(resolvePromise);
      }
    };

    const shutdown = async (onDone: () => void): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupHandlers();
      unsubscribe();
      await runtime.dispose();
      onDone();
    };

    void runtime.setActiveApps([appName]).catch(async (error: unknown) => {
      cleanupHandlers();
      unsubscribe();
      await runtime.dispose();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await waitForExit;
}

function bindTerminationSignals(stop: () => Promise<void>): () => void {
  const onSigint = (): void => {
    void stop();
  };
  const onSigterm = (): void => {
    void stop();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function addLogLimitOption(command: Command): Command {
  return command.option(
    "--log-limit <count>",
    "Max parsed rows and raw-text budget",
    (value: string) => parsePositiveInteger(value, "--log-limit"),
  );
}

function addRowFilterOptions(command: Command): Command {
  return command
    .option("--search <text>", "Keep rows containing text, case-insensitive", parseSearchTerm)
    .option(
      "--min-level <level>",
      `Keep level >= ${LOG_LEVELS.join("/")}`,
      (value: string) => parseLogLevel(value, "--min-level"),
    );
}

function addRetryOptions(command: Command): Command {
  return command
    .option(
      "--flush-interval-ms <ms>",
      "Batch window for stream line flushes",
      (value: string) => parsePositiveInteger(value, "--flush-interval-ms"),
    )
    .option(
      "--retry-initial-ms <ms>",
      "Initial reconnect delay for unexpected stream exits",
      (value: string) => parsePositiveInteger(value, "--retry-initial-ms"),
    )
    .option(
      "--retry-max-ms <ms>",
      "Maximum reconnect delay for unexpected stream exits",
      (value: string) => parsePositiveInteger(value, "--retry-max-ms"),
    );
}

function addCompactOptions(command: Command): Command {
  return command
    .option("--compact", "Emit compact rows")
    .option(
      "--compact-message-limit <count>",
      "Max compact message/body chars",
      (value: string) => parsePositiveInteger(value, "--compact-message-limit"),
    );
}

function addCompactSessionOptions(command: Command): Command {
  return addCompactOptions(command).option(
    "--compact-ttl-minutes <count>",
    "Minutes compact refs stay valid",
    (value: string) => parsePositiveInteger(value, "--compact-ttl-minutes"),
  );
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

function suppressBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException): void => {
      if (error.code === "EPIPE") {
        process.exit(0);
      }
      throw error;
    });
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("cf-logs")
    .description("Manage Cloud Foundry application logs")
    .version(readPackageVersion(), "-V, --version", "Print the cf-logs package version");

  addCompactSessionOptions(
    addRowFilterOptions(
      addLogLimitOption(
        addAppOptions(
          program
            .command("snapshot")
            .description("Fetch recent logs for one app"),
        ),
      ),
    ),
  )
    .option("--json", "Emit JSON")
    .option("--save", "Save output; with --compact, emit refs")
    .option("--since <duration>", "Keep rows newer than duration, e.g. 15m, 1h", parseSinceDurationMs)
    .action(async (flags: SnapshotFlags): Promise<void> => {
      await runSnapshot(flags);
    });

  addRetryOptions(
    addCompactSessionOptions(
      addRowFilterOptions(
        addLogLimitOption(
          addAppOptions(
            program
              .command("stream")
              .description("Stream live logs for one app"),
          ),
        ),
      ),
    ),
  )
    .option("--json", "Emit JSON Lines")
    .option("--save", "Save output; with --compact, emit refs")
    .option(
      "--max-lines <count>",
      "Stop after N emitted lines/rows",
      (value: string) => parsePositiveInteger(value, "--max-lines"),
    )
    .action(async (flags: StreamFlags): Promise<void> => {
      await runStream(flags);
    });

  program
    .command("show")
    .description("Show a full row for a compact ref")
    .argument("<ref>", "Compact ref: <session-id>:<row-id>")
    .option("--json", "Emit JSON")
    .action(async (ref: string, flags: ShowFlags): Promise<void> => {
      await runShow(ref, flags);
    });

  const session = program.command("session").description("List or clear compact ref sessions");
  session
    .command("list")
    .description("List active compact ref sessions")
    .option("--json", "Emit JSON")
    .action(async (flags: SessionListFlags): Promise<void> => {
      await runSessionList(flags);
    });

  session
    .command("prune")
    .description("Remove expired compact ref sessions")
    .action(async (): Promise<void> => {
      await runSessionPrune();
    });

  session
    .command("clear")
    .description("Remove all compact ref sessions")
    .action(async (): Promise<void> => {
      await runSessionClear();
    });

  addSessionOptions(
    program
      .command("apps")
      .description("List started apps in a CF org/space"),
  )
    .option("--json", "Emit JSON")
    .action(async (flags: AppsFlags): Promise<void> => {
      await runApps(flags);
    });

  const store = program.command("store").description("Inspect the persistent snapshot store");
  store
    .command("path")
    .description("Print the store path")
    .action((): void => {
      process.stdout.write(`${cfLogsStorePath()}\n`);
    });

  store
    .command("list")
    .description("List cached store entries")
    .option("--json", "Emit JSON")
    .action(async (flags: StoreListFlags): Promise<void> => {
      await runStoreList(flags);
    });

  store
    .command("clear")
    .description("Remove all cached store entries")
    .action(async (): Promise<void> => {
      await clearStore();
      process.stdout.write(`Cleared ${cfLogsStorePath()}\n`);
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
