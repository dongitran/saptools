import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readStateAt, readTraceEvents, readTraceManifest } from "../../src/run-reader.js";
import { createTraceRun, writeTraceEvent } from "../../src/run-store.js";
import { createTraceRecorder } from "../../src/trace-recorder.js";

describe("trace timeline recorder", () => {
  it("stores a baseline, patches, unchanged events, checkpoints, and a terminal full state", async () => {
    const root = join(tmpdir(), `cf-function-recorder-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      const recorder = createTraceRecorder(run, { checkpointEvery: 3 });
      await recorder.record({
        seq: 0,
        kind: "baseline",
        functionName: "run",
        depth: 0,
        lineNumber: 10,
        columnNumber: 0,
        state: { count: 1 },
      });
      await recorder.record({
        seq: 1,
        kind: "pause",
        functionName: "run",
        depth: 0,
        lineNumber: 11,
        columnNumber: 0,
        state: { count: 2 },
      });
      await recorder.record({
        seq: 2,
        kind: "pause",
        functionName: "run",
        depth: 0,
        lineNumber: 12,
        columnNumber: 0,
        state: { count: 2 },
      });
      await recorder.record({
        seq: 3,
        kind: "pause",
        functionName: "run",
        depth: 0,
        lineNumber: 13,
        columnNumber: 0,
        state: { count: 3 },
      });
      await recorder.complete("completed");

      const events = await readTraceEvents(run.runId, { saptoolsRoot: root });
      expect(events.map((event) => event.artifactKind)).toEqual([
        "full",
        "patch",
        "unchanged",
        "full",
        "full",
      ]);
      expect(events[1]?.changedPaths).toEqual(["/count"]);
      expect(events[2]?.changedPaths).toEqual([]);
      expect(events[4]?.kind).toBe("completed");
      expect(await readStateAt(run.runId, 4, { saptoolsRoot: root })).toEqual({ count: 3 });
      expect((await readTraceManifest(run.runId, { saptoolsRoot: root })).status).toBe("completed");

      const stateFiles = await readdir(run.statesDirectory);
      expect(stateFiles).toEqual([
        "000000.full.json",
        "000001.patch.json",
        "000003.full.json",
        "000004.full.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-sequential records and can mark a run failed", async () => {
    const root = join(tmpdir(), `cf-function-recorder-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
      await expect(recorder.record({
        seq: 1,
        kind: "pause",
        functionName: "run",
        depth: 0,
        lineNumber: 10,
        columnNumber: 0,
        state: {},
      })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await recorder.fail("failed");
      expect((await readTraceManifest(run.runId, { saptoolsRoot: root })).status).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites an event sequence and rolls back its uncommitted state artifact", async () => {
    const root = join(tmpdir(), `cf-function-recorder-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      await writeTraceEvent(run, {
        seq: 0,
        kind: "baseline",
        stateHash: "0".repeat(64),
        artifactKind: "unchanged",
        changedPaths: [],
      });
      const recorder = createTraceRecorder(run, { checkpointEvery: 10 });

      await expect(recorder.record({
        seq: 0,
        kind: "baseline",
        functionName: "run",
        depth: 0,
        lineNumber: 1,
        columnNumber: 0,
        state: { count: 1 },
      })).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
      expect(await readdir(run.statesDirectory)).toEqual([]);
      expect(await readTraceEvents(run.runId, { saptoolsRoot: root })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a step-limited terminal event as truncated instead of returned", async () => {
    const root = join(tmpdir(), `cf-function-recorder-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
      await recorder.record({
        seq: 0,
        kind: "baseline",
        functionName: "run",
        depth: 0,
        lineNumber: 10,
        columnNumber: 0,
        state: { count: 1 },
      });
      await recorder.complete("partial");

      const events = await readTraceEvents(run.runId, { saptoolsRoot: root });
      expect(events.at(-1)?.kind).toBe("truncated");
      expect((await readTraceManifest(run.runId, { saptoolsRoot: root })).status).toBe("partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an exception as the terminal event of a completed trace", async () => {
    const root = join(tmpdir(), `cf-function-recorder-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
      await recorder.record({
        seq: 0,
        kind: "exception",
        functionName: "run",
        depth: 0,
        lineNumber: 10,
        columnNumber: 0,
        state: { message: "redacted" },
      });
      await recorder.complete("completed", "none");

      const events = await readTraceEvents(run.runId, { saptoolsRoot: root });
      expect(events.map((event) => event.kind)).toEqual(["exception"]);
      expect((await readTraceManifest(run.runId, { saptoolsRoot: root })).status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
