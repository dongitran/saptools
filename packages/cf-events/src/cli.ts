import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { parseTypeFilter } from "./events.js";
import {
  formatCrashReport,
  formatEventLine,
  formatEventsReport,
  formatSshStatusReport,
  formatStatusReport,
} from "./format.js";
import { CfEventsRuntime } from "./runtime.js";
import type { AuditEvent, CfCredentials } from "./types.js";

const DEFAULT_EVENT_LIMIT = 50;
const DEFAULT_CRASH_LIMIT = 50;
const DEFAULT_SSH_SINCE = "24h";
const DEFAULT_WATCH_INTERVAL_MS = 15_000;
const DEFAULT_WATCH_LOOKBACK = "2m";
const MIN_WATCH_INTERVAL_MS = 2000;

interface CommonFlags {
  readonly email?: string;
  readonly password?: string;
  readonly json?: boolean;
}

interface EventsFlags extends CommonFlags {
  readonly limit?: number;
  readonly since?: string;
  readonly type?: string;
}

interface SshStatusFlags extends CommonFlags {
  readonly since?: string;
}

interface CrashesFlags extends CommonFlags {
  readonly limit?: number;
  readonly since?: string;
}

interface WatchFlags extends CommonFlags {
  readonly interval?: number;
  readonly lookback?: string;
  readonly type?: string;
}

function resolveCredential(value: string | undefined, envName: string, optionName: string): string {
  const direct = value?.trim();
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error(`Missing SAP credentials. Pass --${optionName} or set the ${envName} environment variable.`);
}

function buildCredentials(flags: CommonFlags): CfCredentials {
  return {
    email: resolveCredential(flags.email, "SAP_EMAIL", "email"),
    password: resolveCredential(flags.password, "SAP_PASSWORD", "password"),
  };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function appLabel(selector: string): string {
  return (selector.split("/").at(-1) ?? selector).trim();
}

function resolveSelectorArgument(selector: string): string {
  // Bare app name or full path is passed as-is.
  // Bare names are resolved inside resolveSelector using the current CF target (no global snapshot search).
  return selector;
}

function writeOut(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runEvents(selector: string, flags: EventsFlags): Promise<void> {
  const resolvedSelector = resolveSelectorArgument(selector);
  const runtime = new CfEventsRuntime();
  const events = await runtime.fetchEvents(resolvedSelector, buildCredentials(flags), {
    limit: flags.limit ?? DEFAULT_EVENT_LIMIT,
    since: flags.since,
    types: parseTypeFilter(flags.type),
  });
  if (flags.json === true) {
    writeJson(events);
    return;
  }
  writeOut(formatEventsReport(appLabel(resolvedSelector), events, new Date()));
}

async function runSshStatus(selector: string, flags: SshStatusFlags): Promise<void> {
  const resolvedSelector = resolveSelectorArgument(selector);
  const runtime = new CfEventsRuntime();
  const status = await runtime.getSshStatus(
    resolvedSelector,
    buildCredentials(flags),
    flags.since ?? DEFAULT_SSH_SINCE,
  );
  if (flags.json === true) {
    writeJson(status);
    return;
  }
  writeOut(formatSshStatusReport(status, new Date()));
}

async function runCrashes(selector: string, flags: CrashesFlags): Promise<void> {
  const resolvedSelector = resolveSelectorArgument(selector);
  const runtime = new CfEventsRuntime();
  const summary = await runtime.getCrashes(resolvedSelector, buildCredentials(flags), {
    limit: flags.limit ?? DEFAULT_CRASH_LIMIT,
    since: flags.since,
  });
  if (flags.json === true) {
    writeJson(summary);
    return;
  }
  writeOut(formatCrashReport(summary, new Date()));
}

async function runStatus(selector: string, flags: CommonFlags): Promise<void> {
  const resolvedSelector = resolveSelectorArgument(selector);
  const runtime = new CfEventsRuntime();
  const health = await runtime.getStatus(resolvedSelector, buildCredentials(flags));
  if (flags.json === true) {
    writeJson(health);
    return;
  }
  writeOut(formatStatusReport(health, new Date()));
}

function emitWatchEvent(event: AuditEvent, asJson: boolean): void {
  if (asJson) {
    writeJsonLine(event);
    return;
  }
  writeOut(formatEventLine(event, new Date()));
}

async function runWatch(selector: string, flags: WatchFlags): Promise<void> {
  const resolvedSelector = resolveSelectorArgument(selector);
  const interval = flags.interval ?? DEFAULT_WATCH_INTERVAL_MS;
  if (interval < MIN_WATCH_INTERVAL_MS) {
    throw new Error(`--interval must be at least ${MIN_WATCH_INTERVAL_MS.toString()}ms.`);
  }

  const runtime = new CfEventsRuntime();
  const controller = new AbortController();
  const cleanup = bindTerminationSignals(() => {
    controller.abort();
  });
  const asJson = flags.json === true;

  try {
    process.stderr.write(`Watching ${resolvedSelector} for new audit events. Press Ctrl+C to stop.\n`);
    await runtime.watchEvents(
      resolvedSelector,
      buildCredentials(flags),
      {
        intervalMs: interval,
        lookback: flags.lookback ?? DEFAULT_WATCH_LOOKBACK,
        types: parseTypeFilter(flags.type),
      },
      (event) => {
        emitWatchEvent(event, asJson);
      },
      controller.signal,
    );
  } finally {
    cleanup();
  }
}

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

function addCommonOptions(command: Command): Command {
  return command
    .option("--email <value>", "SAP email (default: SAP_EMAIL env var)")
    .option("--password <value>", "SAP password (default: SAP_PASSWORD env var)")
    .option("--json", "Emit structured JSON instead of text", false);
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
    .name("cf-events")
    .description("Inspect SAP BTP Cloud Foundry application audit events and SSH/debug sessions")
    .version(readPackageVersion(), "-V, --version", "Print the cf-events package version");

  addCommonOptions(
    program
      .command("events")
      .description("List recent audit events for an app")
      .argument("<selector>", "region/org/space/app or a bare app name"),
  )
    .option(
      "--limit <count>",
      "Maximum number of events to return",
      (value: string) => parsePositiveInteger(value, "--limit"),
    )
    .option("--since <duration>", "Only events newer than a duration (e.g. 30m, 6h, 7d)")
    .option("--type <types>", 'Comma-separated CF event types, or the shorthand "ssh"/"crash"')
    .action(async (selector: string, flags: EventsFlags): Promise<void> => {
      await runEvents(selector, flags);
    });

  addCommonOptions(
    program
      .command("ssh-status")
      .description("Show whether SSH is enabled and detect recent SSH/debug sessions")
      .argument("<selector>", "region/org/space/app or a bare app name"),
  )
    .option("--since <duration>", "Look-back window for SSH events", DEFAULT_SSH_SINCE)
    .action(async (selector: string, flags: SshStatusFlags): Promise<void> => {
      await runSshStatus(selector, flags);
    });

  addCommonOptions(
    program
      .command("crashes")
      .description("Summarize recent crash events for an app")
      .argument("<selector>", "region/org/space/app or a bare app name"),
  )
    .option(
      "--limit <count>",
      "Maximum number of crash events to inspect",
      (value: string) => parsePositiveInteger(value, "--limit"),
    )
    .option("--since <duration>", "Only crashes newer than a duration (e.g. 30m, 6h, 7d)")
    .action(async (selector: string, flags: CrashesFlags): Promise<void> => {
      await runCrashes(selector, flags);
    });

  addCommonOptions(
    program
      .command("status")
      .description("Show app health: requested state, instances, SSH flag, and last event")
      .argument("<selector>", "region/org/space/app or a bare app name"),
  ).action(async (selector: string, flags: CommonFlags): Promise<void> => {
    await runStatus(selector, flags);
  });

  addCommonOptions(
    program
      .command("watch")
      .description("Poll for new audit events and print them as they appear")
      .argument("<selector>", "region/org/space/app or a bare app name"),
  )
    .option(
      "--interval <ms>",
      "Polling interval in milliseconds",
      (value: string) => parsePositiveInteger(value, "--interval"),
    )
    .option("--lookback <duration>", "Initial look-back window on start (e.g. 2m)", DEFAULT_WATCH_LOOKBACK)
    .option("--type <types>", 'Comma-separated CF event types, or the shorthand "ssh"/"crash"')
    .action(async (selector: string, flags: WatchFlags): Promise<void> => {
      await runWatch(selector, flags);
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
