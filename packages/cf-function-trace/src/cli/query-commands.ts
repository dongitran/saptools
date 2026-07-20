import process from "node:process";
import type { Writable } from "node:stream";

import type { StatePatchOperation } from "../contracts.js";
import { TraceDataError } from "../errors.js";
import {
  listTraceRuns,
  readStateAt,
  readStatePath,
  readTraceEvents,
  resolveTraceRun,
  type StoredTraceEvent,
} from "../run-reader.js";
import { pruneTraceRuns, purgeTraceRun, type TraceStoreOptions } from "../run-store.js";
import { diffStates } from "../state-diff.js";

import { measureJsonBytes, writeJsonOutput } from "./output.js";
import type {
  DiffCliFlags,
  RunsCliFlags,
  ShowCliFlags,
  StateCliFlags,
} from "./program.js";

export interface QueryCommandContext {
  readonly stdout: Writable;
  readonly saptoolsRoot?: string;
}

function defaultContext(): QueryCommandContext {
  return { stdout: process.stdout };
}

function storeOptions(context: QueryCommandContext): TraceStoreOptions {
  return context.saptoolsRoot === undefined ? {} : { saptoolsRoot: context.saptoolsRoot };
}

function parseInteger(raw: string, label: string, minimum: number, maximum: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || value.toString() !== raw.trim()) {
    throw new TraceDataError("INVALID_ARGUMENT", `${label} is outside its supported integer range.`);
  }
  return value;
}

function outputLimit(raw: string | undefined): number {
  return parseInteger(raw ?? "24000", "--max-output-bytes", 128, 1_000_000);
}

async function prepareStore(context: QueryCommandContext): Promise<TraceStoreOptions> {
  const options = storeOptions(context);
  await pruneTraceRuns(options);
  return options;
}

interface ShowOutputEvent {
  readonly seq: number;
}

function showEnvelope(
  runId: string,
  total: number,
  matching: number,
  from: number,
  events: readonly ShowOutputEvent[],
): Readonly<Record<string, unknown>> {
  const last = events.at(-1);
  const hasMore = events.length < matching;
  return {
    runId,
    total,
    matching,
    shown: events.length,
    returned: events.length,
    from,
    hasMore,
    ...(hasMore && last !== undefined ? { nextSeq: last.seq + 1 } : {}),
    events,
  };
}

// Field priority favors orientation-per-byte: functionName/line/column tell
// an agent where it is for a few bytes each, while the 64-char stateHash has
// no standalone debugging value, so it is the first thing dropped under
// pressure rather than the last.
function compactEvent(event: StoredTraceEvent): ShowOutputEvent & Readonly<Record<string, unknown>> {
  return {
    seq: event.seq,
    kind: event.kind,
    artifactKind: event.artifactKind,
    changedPathCount: event.changedPaths.length,
    detailsOmitted: true,
    ...(event.functionName === undefined ? {} : { functionName: event.functionName }),
    ...(event.depth === undefined ? {} : { depth: event.depth }),
    ...(event.lineNumber === undefined ? {} : { lineNumber: event.lineNumber }),
    ...(event.columnNumber === undefined ? {} : { columnNumber: event.columnNumber }),
  };
}

const MAX_SHOWN_CHANGED_PATHS = 20;

// `changedPaths` is the one genuinely unbounded field on an event (its size
// tracks how much of the object graph churned that step, not how much this
// tool chooses to show) -- capping IT specifically preserves every other
// cheap, high-value field (functionName/line/column) and keeps `changedPaths`
// non-empty (just possibly partial) for `--changes-only`, which needs it to
// be more than a bare count.
function withBoundedChangedPaths(event: StoredTraceEvent): ShowOutputEvent & Readonly<Record<string, unknown>> {
  if (event.changedPaths.length <= MAX_SHOWN_CHANGED_PATHS) {
    return { ...event };
  }
  return {
    ...event,
    changedPaths: event.changedPaths.slice(0, MAX_SHOWN_CHANGED_PATHS),
    changedPathCount: event.changedPaths.length,
  };
}

function shrinkToFit(
  runId: string,
  total: number,
  from: number,
  matchingCount: number,
  events: readonly (ShowOutputEvent & Readonly<Record<string, unknown>>)[],
  maxBytes: number,
): Readonly<Record<string, unknown>> | undefined {
  const shrinking = [...events];
  while (shrinking.length > 0) {
    const envelope = showEnvelope(runId, total, matchingCount, from, shrinking);
    if (measureJsonBytes(envelope) <= maxBytes) {
      return envelope;
    }
    shrinking.pop();
  }
  return undefined;
}

function boundedShowPage(
  runId: string,
  total: number,
  from: number,
  matching: readonly StoredTraceEvent[],
  requestedLimit: number,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const selected = matching.slice(0, requestedLimit);
  const full = showEnvelope(runId, total, matching.length, from, selected);
  if (measureJsonBytes(full) <= maxBytes) {
    return full;
  }
  // Degrade event CONTENT before ever dropping an event outright: a run whose
  // steps carry many changed paths (e.g. one exercising node-identity churn
  // across steps) can make full events far bigger than necessary, and
  // silently popping full events from the end would drop the run's later
  // events -- including its terminal completed/truncated marker -- even
  // though capping just the unbounded field would have let everything fit.
  const capped = selected.map(withBoundedChangedPaths);
  const cappedEnvelope = showEnvelope(runId, total, matching.length, from, capped);
  if (measureJsonBytes(cappedEnvelope) <= maxBytes) {
    return cappedEnvelope;
  }
  const compact = selected.map(compactEvent);
  const compactEnvelope = showEnvelope(runId, total, matching.length, from, compact);
  if (measureJsonBytes(compactEnvelope) <= maxBytes) {
    return compactEnvelope;
  }
  const shrunk = shrinkToFit(runId, total, from, matching.length, compact, maxBytes);
  if (shrunk !== undefined) {
    return shrunk;
  }
  // Even a single compact event's variable-length functionName can exceed
  // --max-output-bytes near the tool's own documented floor (128); the
  // fixed-shape summary counts with zero events shown are the true final
  // tier (mirrors boundedStateResponse/boundedDiffResponse's progressive
  // degrade), so this is tried before giving up entirely.
  const summaryOnly = showEnvelope(runId, total, matching.length, from, []);
  if (measureJsonBytes(summaryOnly) <= maxBytes) {
    return summaryOnly;
  }
  throw new TraceDataError("INVALID_ARGUMENT", "Output budget is too small for one trace event summary.");
}

async function stateValue(
  runId: string,
  seq: number,
  path: string | undefined,
  options: TraceStoreOptions,
): Promise<unknown> {
  return path === undefined
    ? await readStateAt(runId, seq, options)
    : await readStatePath(runId, seq, path, options);
}

function truncationHint(path: string | undefined, maxBytes: number): string {
  const pathAdvice = path === undefined ? "narrow with --path, or " : "";
  return `Exceeds --max-output-bytes=${String(maxBytes)}; ${pathAdvice}raise --max-output-bytes to see the full result.`;
}

function stateEnvelope(runId: string, seq: number, path: string | undefined): Readonly<Record<string, unknown>> {
  return { runId, seq, ...(path === undefined ? {} : { path }) };
}

// Returns the first candidate (richest first) that fits, or undefined if none
// do. Candidates must be ordered richest-to-barest: the caller's last entry
// is its final, most-degraded fallback before giving up entirely.
function firstFitting(
  candidates: readonly Readonly<Record<string, unknown>>[],
  maxBytes: number,
): Readonly<Record<string, unknown>> | undefined {
  return candidates.find((candidate) => measureJsonBytes(candidate) <= maxBytes);
}

// Mirrors boundedShowPage's never-a-content-free-stub guarantee. `state`'s
// payload is a single arbitrary JSON value, not a list this tool can shrink
// piece-by-piece like show's events, so its degrade path drops the payload
// while keeping the request envelope, then progressively drops the hint and
// originalBytes too if even those do not fit -- --max-output-bytes=128 (the
// tool's own documented floor) is smaller than envelope + hint (the hint
// alone is a ~100+ byte fixed guidance string), so preserving runId/seq at
// every budget above the bare minimum requires shedding the richer fields
// first. This never falls back to the old content-free {truncated,
// originalBytes} stub with no runId/seq.
function boundedStateResponse(
  envelope: Readonly<Record<string, unknown>>,
  state: unknown,
  path: string | undefined,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const full = { ...envelope, state };
  const originalBytes = measureJsonBytes(full);
  if (originalBytes <= maxBytes) {
    return full;
  }
  const fitting = firstFitting([
    { ...envelope, truncated: true, originalBytes, hint: truncationHint(path, maxBytes) },
    { ...envelope, truncated: true, originalBytes },
    { ...envelope, truncated: true },
  ], maxBytes);
  if (fitting !== undefined) {
    return fitting;
  }
  throw new TraceDataError("INVALID_ARGUMENT", "Output budget is too small for a truncated state response.");
}

function diffEnvelope(runId: string, from: number, to: number, path: string | undefined): Readonly<Record<string, unknown>> {
  return { runId, from, to, ...(path === undefined ? {} : { path }) };
}

const MAX_DIFF_OPERATIONS = 50;

// The embedded `value` on an add/replace operation is diff's analogue of
// show's unbounded `changedPaths`: capping operation COUNT (while keeping
// every changedPaths entry, which are cheap path strings) shrinks the common
// "many small changes" case. A single oversized operation (e.g. one large
// root replace) is not helped by count-capping and falls through to the
// envelope-only fallback below, same as show's own final tier.
function cappedOperations(operations: readonly StatePatchOperation[]): {
  readonly operations: readonly StatePatchOperation[];
  readonly operationCount?: number;
} {
  if (operations.length <= MAX_DIFF_OPERATIONS) {
    return { operations };
  }
  return { operations: operations.slice(0, MAX_DIFF_OPERATIONS), operationCount: operations.length };
}

function boundedDiffResponse(
  envelope: Readonly<Record<string, unknown>>,
  changedPaths: readonly string[],
  operations: readonly StatePatchOperation[],
  path: string | undefined,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const full = { ...envelope, changedPaths, operations };
  const originalBytes = measureJsonBytes(full);
  if (originalBytes <= maxBytes) {
    return full;
  }
  const capped = { ...envelope, changedPaths, ...cappedOperations(operations) };
  if (measureJsonBytes(capped) <= maxBytes) {
    return capped;
  }
  // Same progressive degrade as boundedStateResponse: at --max-output-bytes
  // near the tool's own documented floor (128), envelope + counts + hint can
  // exceed the budget even though the bare envelope alone always fits, so the
  // hint and then the counts are shed before giving up.
  const fitting = firstFitting([
    {
      ...envelope,
      truncated: true,
      originalBytes,
      changedPathCount: changedPaths.length,
      operationCount: operations.length,
      hint: truncationHint(path, maxBytes),
    },
    { ...envelope, truncated: true, originalBytes, changedPathCount: changedPaths.length, operationCount: operations.length },
    { ...envelope, truncated: true, originalBytes },
    { ...envelope, truncated: true },
  ], maxBytes);
  if (fitting !== undefined) {
    return fitting;
  }
  throw new TraceDataError("INVALID_ARGUMENT", "Output budget is too small for a truncated diff response.");
}

export async function runShowCommand(
  selector: string,
  flags: ShowCliFlags,
  context: QueryCommandContext = defaultContext(),
): Promise<void> {
  const options = await prepareStore(context);
  const run = await resolveTraceRun(selector, options);
  const events = await readTraceEvents(run.runId, options);
  const from = parseInteger(flags.from ?? "0", "--from", 0, 999_999);
  const limit = parseInteger(flags.limit ?? "100", "--limit", 1, 1000);
  const eligible = events.filter((event) => event.seq >= from);
  const matching = flags.changesOnly === true
    ? eligible.filter((event) => event.changedPaths.length > 0)
    : eligible;
  const maxBytes = outputLimit(flags.maxOutputBytes);
  await writeJsonOutput(context.stdout, boundedShowPage(run.runId, events.length, from, matching, limit, maxBytes), maxBytes);
}

export async function runStateCommand(
  selector: string,
  flags: StateCliFlags,
  context: QueryCommandContext = defaultContext(),
): Promise<void> {
  const options = await prepareStore(context);
  const run = await resolveTraceRun(selector, options);
  const seq = parseInteger(flags.at, "--at", 0, 999_999);
  const state = await stateValue(run.runId, seq, flags.path, options);
  const maxBytes = outputLimit(flags.maxOutputBytes);
  const response = boundedStateResponse(stateEnvelope(run.runId, seq, flags.path), state, flags.path, maxBytes);
  await writeJsonOutput(context.stdout, response, maxBytes);
}

export async function runDiffCommand(
  selector: string,
  flags: DiffCliFlags,
  context: QueryCommandContext = defaultContext(),
): Promise<void> {
  const options = await prepareStore(context);
  const run = await resolveTraceRun(selector, options);
  const from = parseInteger(flags.from, "--from", 0, 999_999);
  const to = parseInteger(flags.to, "--to", 0, 999_999);
  const before = await stateValue(run.runId, from, flags.path, options);
  const after = await stateValue(run.runId, to, flags.path, options);
  const patch = diffStates(before, after);
  const maxBytes = outputLimit(flags.maxOutputBytes);
  const envelope = diffEnvelope(run.runId, from, to, flags.path);
  const response = boundedDiffResponse(envelope, patch.changedPaths, patch.operations, flags.path, maxBytes);
  await writeJsonOutput(context.stdout, response, maxBytes);
}

export async function runRunsCommand(
  flags: RunsCliFlags,
  context: QueryCommandContext = defaultContext(),
): Promise<void> {
  const limit = parseInteger(flags.limit ?? "20", "--limit", 1, 100);
  const options = await prepareStore(context);
  const runs = await listTraceRuns(options);
  await writeJsonOutput(context.stdout, {
    total: runs.length,
    shown: Math.min(limit, runs.length),
    runs: runs.slice(0, limit),
  }, outputLimit(flags.maxOutputBytes));
}

export async function runPurgeCommand(
  runId: string,
  context: QueryCommandContext = defaultContext(),
): Promise<void> {
  const purged = await purgeTraceRun(runId, storeOptions(context));
  await writeJsonOutput(context.stdout, { purged, runId }, 1024);
}
