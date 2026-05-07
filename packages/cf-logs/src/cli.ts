import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { fetchStartedAppsViaCfCli } from "./cf.js";
import { appendRawLogText, parseRecentLogs } from "./parser.js";
import { cfLogsStorePath } from "./paths.js";
import { CfLogsRuntime } from "./runtime.js";
import { readStore } from "./store.js";
import type {
  CfLogsRuntimeEvent,
  CfLogsRuntimeOptions,
  CfSessionInput,
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
}

interface StreamFlags extends AppFlags {
  readonly json?: boolean;
  readonly save?: boolean;
  readonly maxLines?: number;
  readonly logLimit?: number;
  readonly flushIntervalMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
}

interface AppsFlags extends SessionFlags {
  readonly json?: boolean;
}

interface ParseFlags {
  readonly input?: string;
  readonly logLimit?: number;
  readonly raw?: boolean;
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

function buildParseOptions(logLimit: number | undefined): ParseLogsOptions {
  return logLimit === undefined ? {} : { logLimit };
}

function buildSnapshotRuntimeOptions(flags: SnapshotFlags): CfLogsRuntimeOptions {
  return {
    ...buildParseOptions(flags.logLimit),
    ...(flags.save === true ? { persistSnapshots: true } : {}),
  };
}

function buildStreamRuntimeOptions(flags: StreamFlags): CfLogsRuntimeOptions {
  return {
    ...buildParseOptions(flags.logLimit),
    ...(flags.save === true ? { persistStreamAppends: true } : {}),
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

async function readInputText(inputPath: string | undefined): Promise<string> {
  if (inputPath !== undefined) {
    return await readFile(inputPath, "utf8");
  }
  return await readStdin();
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
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

function printLines(appName: string, lines: readonly string[], asJson: boolean): void {
  if (asJson) {
    writeJsonLine({ type: "lines", appName, lines });
    return;
  }
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
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
    if (flags.json === true) {
      writeJson(snapshot);
      return;
    }
    writeRaw(snapshot.rawText);
  } finally {
    await runtime.dispose();
  }
}

async function runParse(flags: ParseFlags): Promise<void> {
  const input = await readInputText(flags.input);
  const parseOptions = buildParseOptions(flags.logLimit);
  const boundedText = appendRawLogText("", input, parseOptions);
  if (flags.raw === true) {
    writeRaw(boundedText);
    return;
  }
  writeJson(parseRecentLogs(boundedText, parseOptions));
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
  let emittedLineCount = 0;
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
      printLines(currentAppName, event.lines, currentFlags.json === true);
      emittedLineCount += event.lines.length;
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
    "Maximum number of parsed rows and bounded raw-text size",
    (value: string) => parsePositiveInteger(value, "--log-limit"),
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

function buildProgram(): Command {
  const program = new Command();
  program
    .name("cf-logs")
    .description(`Manage Cloud Foundry logs and log snapshots in ${cfLogsStorePath()}`);

  addLogLimitOption(
    addAppOptions(
      program
        .command("snapshot")
        .description("Fetch recent CF logs for one app and optionally persist a redacted snapshot"),
    ),
  )
    .option("--json", "Emit structured JSON instead of raw text", false)
    .option("--save", "Persist the redacted snapshot to the package store", false)
    .action(async (flags: SnapshotFlags): Promise<void> => {
      await runSnapshot(flags);
    });

  addRetryOptions(
    addLogLimitOption(
      addAppOptions(
        program
          .command("stream")
          .description("Start a live CF log stream for one app"),
      ),
    ),
  )
    .option("--json", "Emit line-delimited JSON events", false)
    .option("--save", "Persist bounded redacted stream appends to the package store", false)
    .option(
      "--max-lines <count>",
      "Stop after emitting the given number of streamed lines",
      (value: string) => parsePositiveInteger(value, "--max-lines"),
    )
    .action(async (flags: StreamFlags): Promise<void> => {
      await runStream(flags);
    });

  addLogLimitOption(
    program
      .command("parse")
      .description("Parse a local log file or stdin into structured rows"),
  )
    .option("--input <path>", "Read from a local file instead of stdin")
    .option("--raw", "Print bounded raw input instead of structured rows", false)
    .action(async (flags: ParseFlags): Promise<void> => {
      await runParse(flags);
    });

  addSessionOptions(
    program
      .command("apps")
      .description("List started apps with running instances for a CF org/space"),
  )
    .option("--json", "Emit JSON instead of tab-separated output", false)
    .action(async (flags: AppsFlags): Promise<void> => {
      await runApps(flags);
    });

  const store = program.command("store").description("Inspect the package-managed log store");
  store
    .command("path")
    .description("Print the local log-store path")
    .action((): void => {
      process.stdout.write(`${cfLogsStorePath()}\n`);
    });

  store
    .command("list")
    .description("List cached log-store entries")
    .option("--json", "Emit the full store as JSON", false)
    .action(async (flags: StoreListFlags): Promise<void> => {
      await runStoreList(flags);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync([...argv]);
}

function isMainModule(): boolean {
  const executedPath = process.argv[1];
  return executedPath !== undefined && resolve(executedPath) === fileURLToPath(import.meta.url);
}

async function runCli(): Promise<void> {
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
