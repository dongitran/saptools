import process from "node:process";
import type { Writable } from "node:stream";

import { TraceDataError } from "../errors.js";
import { redactValue } from "../redaction.js";
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

import { writeJsonOutput } from "./output.js";
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

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(redactValue(value))}\n`);
}

function compactEvent(event: StoredTraceEvent): ShowOutputEvent & Readonly<Record<string, unknown>> {
  return {
    seq: event.seq,
    kind: event.kind,
    stateHash: event.stateHash,
    artifactKind: event.artifactKind,
    changedPathCount: event.changedPaths.length,
    detailsOmitted: true,
  };
}

function boundedShowPage(
  runId: string,
  total: number,
  from: number,
  matching: readonly StoredTraceEvent[],
  requestedLimit: number,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  const selected = [...matching.slice(0, requestedLimit)];
  while (selected.length > 0) {
    const envelope = showEnvelope(runId, total, matching.length, from, selected);
    if (serializedBytes(envelope) <= maxBytes) {
      return envelope;
    }
    selected.pop();
  }
  const first = matching[0];
  const fallback = showEnvelope(runId, total, matching.length, from, first === undefined ? [] : [compactEvent(first)]);
  if (serializedBytes(fallback) > maxBytes) {
    throw new TraceDataError("INVALID_ARGUMENT", "Output budget is too small for one trace event summary.");
  }
  return fallback;
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
  await writeJsonOutput(context.stdout, {
    runId: run.runId,
    seq,
    ...(flags.path === undefined ? {} : { path: flags.path }),
    state,
  }, outputLimit(flags.maxOutputBytes));
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
  await writeJsonOutput(context.stdout, {
    runId: run.runId,
    from,
    to,
    ...(flags.path === undefined ? {} : { path: flags.path }),
    changedPaths: patch.changedPaths,
    operations: patch.operations,
  }, outputLimit(flags.maxOutputBytes));
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
