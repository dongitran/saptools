import type { Command } from "commander";

import { compactTraceEvent } from "../trace-compact.js";
import { inspectTraceBody, searchTraceRecords, type TraceBodySide, type TraceSearchBodySide } from "../trace-inspect.js";
import {
  listTraceEvents,
  listTraceSessions,
  pruneTraceSessions,
  readTraceEvent,
  type StoredTraceEventFile,
} from "../trace-store.js";

import { writeJson } from "./output.js";

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
    .option("--body <side>", "request, response, or both", parseSearchBodySide, "both")
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
    .action(async (sessionId: string, requestId: string, _options: unknown, command: Command) => {
      await runBody(sessionId, requestId, command.opts<BodyOptions>());
    });
  session.command("prune").description("remove expired trace event files").action(async () => {
    writeJson({ removed: await pruneTraceSessions() });
  });
}

async function runEvents(sessionId: string, options: EventsOptions): Promise<void> {
  const records = await listTraceEvents(sessionId);
  const events = filterEvents(records, options)
    .slice(0, positive("--limit", options.limit, 50))
    .map(compactTraceEvent);
  writeJson({ sessionId, events });
}

async function runSearch(sessionId: string, text: string, options: SearchOptions): Promise<void> {
  const records = await listTraceEvents(sessionId);
  const matches = searchTraceRecords(records, text, {
    body: options.body ?? "both",
    limit: positive("--limit", options.limit, 20),
    previewLength: positive("--length", options.length, 128),
  });
  writeJson({ sessionId, matches });
}

async function runBody(sessionId: string, requestId: string, options: BodyOptions): Promise<void> {
  const record = await readTraceEvent(sessionId, requestId);
  const body = options.body ?? "response";
  writeJson({
    sessionId,
    requestId,
    body,
    format: body === "request" ? record.requestBodyFormat : record.responseBodyFormat,
    rows: inspectTraceBody(record, {
      body,
      ...(options.path === undefined ? {} : { path: options.path }),
      limit: positive("--limit", options.limit, 4000),
    }),
  });
}

function filterEvents(records: readonly StoredTraceEventFile[], options: EventsOptions): readonly StoredTraceEventFile[] {
  const method = options.method?.trim().toUpperCase();
  const path = options.path?.trim().toLowerCase();
  return records.filter((record) => {
    if (method !== undefined && record.event.method !== method) {
      return false;
    }
    if (options.status !== undefined && record.event.status !== options.status) {
      return false;
    }
    return path === undefined || record.event.normalizedUrl.toLowerCase().includes(path);
  });
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
