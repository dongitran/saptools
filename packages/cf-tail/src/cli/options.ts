import process from "node:process";

import type { CfSessionInput, LogLevel } from "@saptools/cf-logs";
import type { Command } from "commander";

import { parseDurationMs, parseStatusRange } from "../filters.js";
import type { AppFilterInput, TailFilterOptions } from "../types.js";

export interface SessionFlags {
  readonly region?: string;
  readonly apiEndpoint?: string;
  readonly org?: string;
  readonly space?: string;
  readonly email?: string;
  readonly password?: string;
}

export interface AppSelectionFlags {
  readonly apps?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly includeRegex?: readonly string[];
  readonly excludeRegex?: readonly string[];
}

export interface RedactionFlags {
  readonly extraSecret?: readonly string[];
}

export interface RowFilterFlags {
  readonly level?: string;
  readonly search?: string;
  readonly source?: string;
  readonly tenant?: string;
  readonly status?: string;
  readonly stream?: string;
  readonly since?: string;
  readonly until?: string;
  readonly maxRows?: number;
  readonly newestFirst?: boolean;
}

export interface OutputFlags {
  readonly json?: boolean;
  readonly ndjson?: boolean;
  readonly byApp?: boolean;
  readonly noColor?: boolean;
  readonly showSource?: boolean;
  readonly truncate?: number;
}

export interface ConcurrencyFlags {
  readonly concurrency?: number;
  readonly logLimit?: number;
}

export interface StreamSpecificFlags {
  readonly logLimit?: number;
  readonly flushIntervalMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly maxLines?: number;
  readonly rediscover?: string;
  readonly save?: boolean;
  readonly quiet?: boolean;
}

export function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export function resolveCredential(value: string | undefined, envName: string): string {
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

export function buildSession(flags: SessionFlags): CfSessionInput {
  if ((flags.region ?? "").trim().length === 0 && (flags.apiEndpoint ?? "").trim().length === 0) {
    throw new Error("Either --region or --api-endpoint is required.");
  }
  return {
    ...(flags.apiEndpoint === undefined
      ? {}
      : { apiEndpoint: requireText(flags.apiEndpoint, "--api-endpoint") }),
    ...(flags.region === undefined ? {} : { region: requireText(flags.region, "--region") }),
    email: resolveCredential(flags.email, "SAP_EMAIL"),
    password: resolveCredential(flags.password, "SAP_PASSWORD"),
    org: requireText(flags.org, "--org"),
    space: requireText(flags.space, "--space"),
  };
}

export function buildAppFilterInput(flags: AppSelectionFlags): AppFilterInput {
  const includeFromApps = flags.apps ?? [];
  const include = [...includeFromApps, ...(flags.include ?? [])];
  return {
    ...(include.length === 0 ? {} : { include }),
    ...(flags.exclude === undefined ? {} : { exclude: flags.exclude }),
    ...(flags.includeRegex === undefined ? {} : { includeRegex: flags.includeRegex }),
    ...(flags.excludeRegex === undefined ? {} : { excludeRegex: flags.excludeRegex }),
  };
}

export function buildRowFilterOptions(flags: RowFilterFlags): TailFilterOptions {
  const sinceMs = flags.since === undefined ? undefined : parseDurationMs(flags.since);
  const untilMs = flags.until === undefined ? undefined : parseDurationMs(flags.until);
  if (flags.since !== undefined && sinceMs === undefined) {
    throw new Error(`Invalid --since value: ${flags.since}`);
  }
  if (flags.until !== undefined && untilMs === undefined) {
    throw new Error(`Invalid --until value: ${flags.until}`);
  }
  const statusRange = flags.status === undefined ? undefined : parseStatusRange(flags.status);
  if (flags.status !== undefined && statusRange === undefined) {
    throw new Error(`Invalid --status value: ${flags.status}`);
  }
  return {
    ...(flags.level === undefined ? {} : { level: parseLevel(flags.level) }),
    ...(flags.search === undefined ? {} : { searchTerm: flags.search }),
    ...(flags.source === undefined ? {} : { source: flags.source }),
    ...(flags.tenant === undefined ? {} : { tenant: flags.tenant }),
    ...(statusRange === undefined ? {} : { statusMin: statusRange.min, statusMax: statusRange.max }),
    ...(flags.stream === undefined ? {} : { stream: parseStreamFlag(flags.stream) }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(flags.maxRows === undefined ? {} : { maxRows: flags.maxRows }),
    ...(flags.newestFirst === undefined ? {} : { newestFirst: flags.newestFirst }),
  };
}

export function parseLevel(value: string): LogLevel | "all" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (
    normalized === "trace" ||
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "fatal"
  ) {
    return normalized;
  }
  throw new Error(`Invalid --level value: ${value}`);
}

export function parseStreamFlag(value: string): "out" | "err" | "all" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "out" || normalized === "err" || normalized === "all") {
    return normalized;
  }
  throw new Error(`Invalid --stream value: ${value}`);
}

export function resolveRediscoverIntervalMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().toLowerCase() === "off") {
    return 0;
  }
  const parsed = parseDurationMs(value);
  if (parsed === undefined) {
    throw new Error(`Invalid --rediscover value: ${value}`);
  }
  return parsed;
}

export function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

export function appendCollector(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function collectCommaList(value: string, previous: readonly string[]): readonly string[] {
  const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return [...previous, ...items];
}

export function addSessionOptions(command: Command): Command {
  return command
    .option("-r, --region <key>", "CF region key (e.g. ap10)")
    .option("--api-endpoint <url>", "Explicit CF API endpoint")
    .requiredOption("-o, --org <name>", "CF org name")
    .requiredOption("-s, --space <name>", "CF space name")
    .option("--email <value>", "SAP email (default: SAP_EMAIL)")
    .option("--password <value>", "SAP password (default: SAP_PASSWORD)");
}

export function addAppSelectionOptions(command: Command): Command {
  return command
    .option(
      "-a, --apps <names>",
      "Comma-separated app names to include (alias for --include)",
      collectCommaList,
      [],
    )
    .option("--include <name>", "Include a specific app name (repeatable)", appendCollector, [])
    .option("--exclude <name>", "Exclude a specific app name (repeatable)", appendCollector, [])
    .option(
      "--include-regex <pattern>",
      "Include apps whose name matches a regex (repeatable)",
      appendCollector,
      [],
    )
    .option(
      "--exclude-regex <pattern>",
      "Exclude apps whose name matches a regex (repeatable)",
      appendCollector,
      [],
    );
}

export function addRedactionOptions(command: Command): Command {
  return command.option(
    "--extra-secret <value>",
    "Add a custom redaction value (repeatable). Each occurrence is replaced with *** in output and storage",
    appendCollector,
    [],
  );
}

export function addRowFilterOptions(
  command: Command,
  options?: { readonly omitLevel?: boolean },
): Command {
  const omitLevel = options?.omitLevel === true;
  let next = command;
  if (!omitLevel) {
    next = next.option(
      "--level <name>",
      "Filter rows by level (trace|debug|info|warn|error|fatal|all)",
    );
  }
  return next
    .option("--search <text>", "Filter rows containing the given text (case-insensitive)")
    .option("--source <text>", "Filter rows whose CF source contains the given text")
    .option("--tenant <id>", "Filter rows by parsed tenant id")
    .option(
      "--status <range>",
      "Filter rows by router status code (single, e.g. 500; bucket, e.g. 5xx; range, e.g. 400-499)",
    )
    .option("--stream <value>", "Filter rows by CF stream (out|err|all)")
    .option("--since <duration>", "Keep rows newer than now - duration (e.g. 30s, 5m, 1h)")
    .option("--until <duration>", "Keep rows up to now - duration (older than this is dropped)")
    .option(
      "--max-rows <count>",
      "Maximum rows in the rendered output",
      (value: string) => parsePositiveInteger(value, "--max-rows"),
    )
    .option("--newest-first", "Render rows newest-first instead of oldest-first", false);
}

export function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "Emit a single structured JSON object", false)
    .option("--ndjson", "Emit line-delimited JSON rows", false)
    .option("--by-app", "Group rendered rows by app", false)
    .option("--no-color", "Disable ANSI colors")
    .option("--show-source", "Include the CF source segment in text output", false)
    .option(
      "--truncate <chars>",
      "Truncate text-mode messages longer than the given character count",
      (value: string) => parsePositiveInteger(value, "--truncate"),
    );
}

export function addConcurrencyOptions(command: Command): Command {
  return command
    .option(
      "--concurrency <n>",
      "Maximum apps fetched in parallel (default 4)",
      (value: string) => parsePositiveInteger(value, "--concurrency"),
    )
    .option(
      "--log-limit <count>",
      "Maximum parsed rows and bounded raw-text size per app",
      (value: string) => parsePositiveInteger(value, "--log-limit"),
    );
}

export function addStreamOptions(command: Command): Command {
  return command
    .option(
      "--max-lines <count>",
      "Stop after emitting the given number of streamed rows",
      (value: string) => parsePositiveInteger(value, "--max-lines"),
    )
    .option(
      "--rediscover <duration>",
      "Re-discover the app list at this interval (e.g. 30s, 2m, off)",
    )
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
    )
    .option(
      "--log-limit <count>",
      "Maximum parsed rows and bounded raw-text size per app",
      (value: string) => parsePositiveInteger(value, "--log-limit"),
    )
    .option("--save", "Persist bounded redacted stream appends to the cf-logs store", false)
    .option(
      "-q, --quiet",
      "Suppress discovery and stream-state messages on stderr (text mode)",
      false,
    );
}
