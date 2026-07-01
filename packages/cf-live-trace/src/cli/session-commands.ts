import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { compactTraceEvent, type CompactTraceEvent } from "../trace-compact.js";
import {
  inspectTraceBodyResult,
  searchTraceRecords,
  type TraceBodySide,
  type TraceSearchBodySide,
  type TraceSearchMatch,
} from "../trace-inspect.js";
import {
  listTraceSessions,
  pruneTraceSessions,
  readTraceEvent,
  visitTraceEvents,
  type StoredTraceEventFile,
} from "../trace-store.js";

import { writeJson } from "./output.js";

const DISPLAY_HEADER_VALUE_LIMIT = 128;
const DISPLAY_BODY_LIMIT = 2000;
const DISPLAY_RESPONSE_BODY_LIMIT = 4000;
const REPLAY_OMITTED_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const TRUNCATED_MARKER = "... [Truncated for display]";

interface EventsOptions {
  readonly method?: string;
  readonly status?: number;
  readonly path?: string;
  readonly limit?: number;
}

interface SearchOptions {
  readonly body?: TraceSearchBodySide;
  readonly limit?: number;
  readonly length?: number;
}

interface BodyOptions {
  readonly body?: TraceBodySide;
  readonly path?: string;
  readonly limit?: number;
  readonly rows?: number;
}

interface CurlOptions {
  readonly target?: string;
  readonly copy?: boolean;
  readonly out?: string;
}

interface ReplayOptions {
  readonly target?: string;
}

export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("inspect saved live trace sessions");
  session.command("list").description("list active trace sessions").action(async () => {
    writeJson({ sessions: await listTraceSessions() });
  });
  session
    .command("events <sessionId>")
    .description("list compact events saved for a trace session")
    .option("--method <method>", "filter by HTTP method")
    .option("--status <code>", "filter by HTTP status", parseIntOption)
    .option("--path <text>", "filter by URL/path substring")
    .option("--limit <count>", "maximum events to print", parseIntOption)
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      await runEvents(sessionId, command.opts<EventsOptions>());
    });
  session
    .command("search <sessionId> <text>")
    .description("search saved request and response bodies")
    .option("--body <side>", "request, response, or both", parseSearchBodySide, "response")
    .option("--limit <count>", "maximum matches to print", parseIntOption)
    .option("--length <chars>", "maximum preview characters", parseIntOption)
    .action(async (sessionId: string, text: string, _options: unknown, command: Command) => {
      await runSearch(sessionId, text, command.opts<SearchOptions>());
    });
  session
    .command("body <sessionId> <requestId>")
    .description("inspect a saved JSON request or response body")
    .option("--body <side>", "request or response", parseBodySide, "response")
    .option("--path <pointer>", "JSON Pointer inside the saved body")
    .option("--limit <chars>", "maximum characters per value", parseIntOption)
    .option("--rows <count>", "maximum structure rows to print", parseIntOption)
    .action(async (sessionId: string, requestId: string, _options: unknown, command: Command) => {
      await runBody(sessionId, requestId, command.opts<BodyOptions>());
    });
  session
    .command("curl <sessionId> <requestId>")
    .description("export a saved request as a ready-to-run curl command")
    .option("--target <baseUrl>", "rewrite the request URL to a target base URL, for example http://localhost:4004")
    .option("--copy", "copy the full curl command to the clipboard")
    .option("--out <file>", "write the full curl command to a shell script file")
    .action(async (sessionId: string, requestId: string, _options: unknown, command: Command) => {
      await runCurl(sessionId, requestId, command.opts<CurlOptions>());
    });
  session
    .command("replay <sessionId> <requestId>")
    .description("replay a saved request directly from the CLI")
    .option("--target <baseUrl>", "rewrite the request URL to a target base URL, for example http://localhost:4004")
    .action(async (sessionId: string, requestId: string, _options: unknown, command: Command) => {
      await runReplay(sessionId, requestId, command.opts<ReplayOptions>());
    });
  session.command("prune").description("remove expired trace event files").action(async () => {
    writeJson({ removed: await pruneTraceSessions() });
  });
}

async function runEvents(sessionId: string, options: EventsOptions): Promise<void> {
  const limit = positive("--limit", options.limit, 50);
  const status = optionalHttpStatus(options.status);
  const events: CompactTraceEvent[] = [];
  await visitTraceEvents(sessionId, (record) => {
    if (matchesEvent(record, options, status)) {
      events.push(compactTraceEvent(record));
    }
    return events.length < limit;
  });
  writeJson({ sessionId, events });
}

async function runSearch(sessionId: string, text: string, options: SearchOptions): Promise<void> {
  const limit = positive("--limit", options.limit, 20);
  const body = options.body ?? "response";
  const previewLength = positive("--length", options.length, 128);
  const matches: TraceSearchMatch[] = [];
  await visitTraceEvents(sessionId, (record) => {
    const found = searchTraceRecords([record], text, {
      body,
      limit: limit - matches.length,
      previewLength,
    });
    matches.push(...found);
    return matches.length < limit;
  });
  writeJson({ sessionId, matches });
}

async function runBody(sessionId: string, requestId: string, options: BodyOptions): Promise<void> {
  const record = await readTraceEvent(sessionId, requestId);
  const body = options.body ?? "response";
  const inspection = inspectTraceBodyResult(record, {
    body,
    ...(options.path === undefined ? {} : { path: options.path }),
    limit: positive("--limit", options.limit, 4000),
    maxRows: positive("--rows", options.rows, 100),
  });
  writeJson({
    sessionId,
    requestId,
    body,
    format: body === "request" ? record.requestBodyFormat : record.responseBodyFormat,
    ...inspection,
  });
}

async function runCurl(sessionId: string, requestId: string, options: CurlOptions): Promise<void> {
  const record = await readSafeTraceEvent(sessionId, requestId);
  const curlOptions = curlCommandOptions(options.target);
  const fullCommand = buildCurlCommand(record, curlOptions).command;
  if (options.out !== undefined) {
    await writeFile(options.out, `#!/usr/bin/env sh\n${fullCommand}\n`, { mode: 0o700 });
  }
  if (options.copy === true) {
    await copyToClipboard(fullCommand);
  }
  if (options.out === undefined && options.copy !== true) {
    const displayCommand = buildCurlCommand(record, { ...curlOptions, display: true });
    process.stdout.write(`${displayCommand.command}\n`);
    if (displayCommand.truncated) {
      process.stderr.write("[cf-live-trace] warning: displayed curl was truncated to avoid flooding the terminal. Use --copy or --out to obtain the full command.\n");
    }
    return;
  }
  writeJson({ sessionId, requestId, copied: options.copy === true, out: options.out ?? null });
}

async function runReplay(sessionId: string, requestId: string, options: ReplayOptions): Promise<void> {
  const record = await readSafeTraceEvent(sessionId, requestId);
  const url = buildRequestUrl(record, options.target);
  const body = requestBodyForFetch(record);
  const response = await fetch(url, {
    method: record.event.method,
    headers: replayHeaders(record.event.requestHeaders),
    ...(body === undefined ? {} : { body }),
  });
  const responseBody = await response.text();
  writeJson({
    sessionId,
    requestId,
    url,
    status: response.status,
    statusText: response.statusText,
    body: truncateForDisplay(responseBody, DISPLAY_RESPONSE_BODY_LIMIT).value,
    bodyTruncatedForDisplay: responseBody.length > DISPLAY_RESPONSE_BODY_LIMIT,
  });
}

async function readSafeTraceEvent(sessionId: string, requestId: string): Promise<StoredTraceEventFile> {
  const record = await readTraceEvent(sessionId, requestId);
  if (record.event.requestBodyTruncated) {
    throw new Error("Request body was truncated during capture. Cannot safely replay. Please re-run the trace with a larger --max-body-bytes.");
  }
  return record;
}

function curlCommandOptions(target: string | undefined): { readonly target?: string } {
  return target === undefined ? {} : { target };
}

function buildCurlCommand(
  record: StoredTraceEventFile,
  options: { readonly target?: string; readonly display?: boolean } = {},
): { readonly command: string; readonly truncated: boolean } {
  const headers = options.display === true
    ? displayHeaders(record.event.requestHeaders)
    : { values: curlHeaders(record.event.requestHeaders), truncated: false };
  const body = options.display === true
    ? truncateForDisplay(record.event.requestBodyPreview, DISPLAY_BODY_LIMIT)
    : { value: record.event.requestBodyPreview, truncated: false };
  const parts = ["curl", "-i", "-X", shellQuote(record.event.method), shellQuote(buildRequestUrl(record, options.target))];
  for (const [name, value] of Object.entries(headers.values)) {
    parts.push("-H", shellQuote(`${name}: ${value}`));
  }
  if (body.value.length > 0 && allowsRequestBody(record.event.method)) {
    parts.push("--data-raw", shellQuote(body.value));
  }
  return { command: parts.join(" "), truncated: headers.truncated || body.truncated };
}

function buildRequestUrl(record: StoredTraceEventFile, target: string | undefined): string {
  const rawUrl = record.event.url.length > 0 ? record.event.url : record.event.normalizedUrl;
  if (target !== undefined) {
    return new URL(rawUrl, ensureTrailingSlash(target)).toString();
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
    return rawUrl;
  }
  const headers = lowerCaseHeaders(record.event.requestHeaders);
  const proto = firstHeaderValue(headers["x-forwarded-proto"]) ?? "http";
  const host = firstHeaderValue(headers["x-forwarded-host"]) ?? firstHeaderValue(headers["host"]);
  if (host === undefined || host.trim().length === 0) {
    throw new Error("Cannot reconstruct absolute request URL because the trace has no host or x-forwarded-host header. Use --target <baseUrl>.");
  }
  return `${proto}://${host}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`;
}

function ensureTrailingSlash(target: string): string {
  return target.endsWith("/") ? target : `${target}/`;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lowered[name.toLowerCase()] = value;
  }
  return lowered;
}

function displayHeaders(headers: Record<string, string>): { readonly values: Record<string, string>; readonly truncated: boolean } {
  const displayed: Record<string, string> = {};
  let truncated = false;
  for (const [name, value] of Object.entries(curlHeaders(headers))) {
    const displayValue = truncateForDisplay(value, DISPLAY_HEADER_VALUE_LIMIT);
    displayed[name] = displayValue.value;
    truncated ||= displayValue.truncated;
  }
  return { values: displayed, truncated };
}

function curlHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!REPLAY_OMITTED_HEADER_NAMES.has(name.toLowerCase())) {
      output[name] = value;
    }
  }
  return output;
}

function truncateForDisplay(value: string, limit: number): { readonly value: string; readonly truncated: boolean } {
  return value.length > limit
    ? { value: `${value.slice(0, limit)}${TRUNCATED_MARKER}`, truncated: true }
    : { value, truncated: false };
}

function requestBodyForFetch(record: StoredTraceEventFile): string | undefined {
  if (!allowsRequestBody(record.event.method) || record.event.requestBodyPreview.length === 0) {
    return undefined;
  }
  return record.event.requestBodyPreview;
}

function allowsRequestBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function replayHeaders(headers: Record<string, string>): Record<string, string> {
  return curlHeaders(headers);
}

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function copyToClipboard(text: string): Promise<void> {
  const candidates: readonly (readonly string[])[] = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], [["x", "clip"].join(""), "-selection", "clipboard"], [["x", "sel"].join(""), "--clipboard", "--input"]];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await writeToClipboardCommand(candidate, text);
      return;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Unable to copy to clipboard. Install a supported clipboard tool or use --out. ${errors.join(" ")}`.trim());
}

async function writeToClipboardCommand(command: readonly string[], text: string): Promise<void> {
  const child = spawn(command[0] ?? "", command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(text);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command.join(" ")} exited with code ${String(code)}`));
    });
  });
}

function matchesEvent(
  record: StoredTraceEventFile,
  options: EventsOptions,
  status: number | undefined,
): boolean {
  const method = options.method?.trim().toUpperCase();
  const path = options.path?.trim().toLowerCase();
  if (method !== undefined && record.event.method !== method) {
    return false;
  }
  if (status !== undefined && record.event.status !== status) {
    return false;
  }
  return path === undefined || record.event.normalizedUrl.toLowerCase().includes(path);
}

function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Expected an integer but received "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected a safe integer but received "${value}"`);
  }
  return parsed;
}

function positive(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function optionalHttpStatus(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value < 100 || value > 599) {
    throw new Error("--status must be an integer from 100 through 599");
  }
  return value;
}

function parseSearchBodySide(value: string): TraceSearchBodySide {
  if (value === "request" || value === "response" || value === "both") {
    return value;
  }
  throw new Error(`Invalid --body: "${value}" — expected request, response, or both.`);
}

function parseBodySide(value: string): TraceBodySide {
  if (value === "request" || value === "response") {
    return value;
  }
  throw new Error(`Invalid --body: "${value}" — expected request or response.`);
}
