import { rm } from "node:fs/promises";

import { canonicalizeState } from "./canonical-state.js";
import type { JsonValue, TraceRunManifest } from "./contracts.js";
import { TraceDataError } from "./errors.js";
import {
  updateTraceRunStatus,
  writeFullState,
  writePatchState,
  writeTraceEvent,
  type TraceRun,
} from "./run-store.js";
import { diffStates } from "./state-diff.js";
import type { TraceStateRecord } from "./trace-controller.js";

export interface TraceRecorderOptions {
  readonly checkpointEvery: number;
}

export interface TraceRecorder {
  record(record: TraceStateRecord): Promise<void>;
  complete(
    status: "completed" | "partial" | "cancelled",
    terminalKind?: "completed" | "truncated" | "none",
  ): Promise<void>;
  fail(status: "failed" | "cancelled" | "partial"): Promise<void>;
}

interface RecorderState {
  nextSeq: number;
  previousState?: JsonValue;
  previousArtifactSeq?: number;
}

interface RecordedArtifact {
  readonly artifactKind: "full" | "patch" | "unchanged";
  readonly hash: string;
  readonly changedPaths: readonly string[];
  readonly path?: string;
}

function assertNextSequence(state: RecorderState, seq: number): void {
  if (seq !== state.nextSeq) {
    throw new TraceDataError("INVALID_ARGUMENT", `Expected trace sequence ${state.nextSeq.toString()}.`);
  }
}

async function writeRecordedState(
  run: TraceRun,
  record: TraceStateRecord,
  state: RecorderState,
  checkpointEvery: number,
): Promise<RecordedArtifact> {
  const canonical = canonicalizeState(record.state);
  const previous = state.previousState;
  const checkpoint = record.seq === 0 || record.seq % checkpointEvery === 0;
  if (previous === undefined || checkpoint) {
    const written = await writeFullState(run, record.seq, canonical.value);
    return {
      artifactKind: "full",
      hash: canonical.hash,
      changedPaths: previous === undefined ? [""] : diffStates(previous, canonical.value).changedPaths,
      path: written.path,
    };
  }
  const patch = diffStates(previous, canonical.value);
  if (patch.operations.length === 0) {
    return { artifactKind: "unchanged", hash: canonical.hash, changedPaths: [] };
  }
  const parentSeq = state.previousArtifactSeq;
  if (parentSeq === undefined) {
    throw new TraceDataError("INVALID_ARTIFACT", "Patch state has no parent artifact.");
  }
  const written = await writePatchState(run, record.seq, parentSeq, patch);
  return { artifactKind: "patch", hash: patch.after.hash, changedPaths: patch.changedPaths, path: written.path };
}

async function rollbackArtifact(path: string | undefined): Promise<void> {
  if (path !== undefined) {
    await rm(path, { force: true });
  }
}

async function recordState(
  run: TraceRun,
  record: TraceStateRecord,
  state: RecorderState,
  checkpointEvery: number,
): Promise<void> {
  assertNextSequence(state, record.seq);
  const artifact = await writeRecordedState(run, record, state, checkpointEvery);
  try {
    await writeTraceEvent(run, {
      seq: record.seq,
      kind: record.kind,
      stateHash: artifact.hash,
      artifactKind: artifact.artifactKind,
      changedPaths: artifact.changedPaths,
      functionName: record.functionName,
      depth: record.depth,
      lineNumber: record.lineNumber,
      columnNumber: record.columnNumber,
    });
  } catch (error: unknown) {
    await rollbackArtifact(artifact.path);
    throw error;
  }
  state.previousState = canonicalizeState(record.state).value;
  if (artifact.artifactKind !== "unchanged") {
    state.previousArtifactSeq = record.seq;
  }
  state.nextSeq += 1;
}

async function writeTerminalState(
  run: TraceRun,
  state: RecorderState,
  kind: "completed" | "truncated",
): Promise<void> {
  const previous = state.previousState;
  if (previous === undefined) {
    return;
  }
  const artifact = await writeFullState(run, state.nextSeq, previous);
  try {
    await writeTraceEvent(run, {
      seq: state.nextSeq,
      kind,
      stateHash: artifact.hash,
      artifactKind: "full",
      changedPaths: [],
    });
  } catch (error: unknown) {
    await rollbackArtifact(artifact.path);
    throw error;
  }
  state.previousArtifactSeq = state.nextSeq;
  state.nextSeq += 1;
}

function validateCheckpointEvery(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new TraceDataError("INVALID_ARGUMENT", "checkpointEvery must be between 1 and 1000.");
  }
  return value;
}

export function createTraceRecorder(run: TraceRun, options: TraceRecorderOptions): TraceRecorder {
  const checkpointEvery = validateCheckpointEvery(options.checkpointEvery);
  const state: RecorderState = { nextSeq: 0 };
  return {
    record: async (record): Promise<void> => {
      await recordState(run, record, state, checkpointEvery);
    },
    complete: async (status, terminalKind): Promise<void> => {
      const kind = terminalKind ?? (status === "completed" ? "completed" : "truncated");
      if (kind !== "none") {
        await writeTerminalState(run, state, kind);
      }
      await updateTraceRunStatus(run, status);
    },
    fail: async (status: TraceRunManifest["status"]): Promise<void> => {
      await updateTraceRunStatus(run, status);
    },
  };
}
