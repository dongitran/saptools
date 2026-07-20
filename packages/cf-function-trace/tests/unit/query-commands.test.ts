import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  runDiffCommand,
  runPurgeCommand,
  runRunsCommand,
  runShowCommand,
  runStateCommand,
} from "../../src/cli/query-commands.js";
import { createTraceRun, writeTraceEvent } from "../../src/run-store.js";
import { createTraceRecorder } from "../../src/trace-recorder.js";

function outputCollector(): { readonly stream: Writable; readonly values: unknown[] } {
  const values: unknown[] = [];
  let buffered = "";
  return {
    values,
    stream: new Writable({
      write(chunk: Buffer | string, _encoding, callback): void {
        buffered += chunk.toString();
        for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) {
            const parsed: unknown = JSON.parse(line);
            values.push(parsed);
          }
        }
        callback();
      },
    }),
  };
}

describe("offline trace query commands", () => {
  it("shows events, reads state paths, diffs states, lists runs, and purges", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: { order: { status: "new" } },
    });
    await recorder.record({
      seq: 1,
      kind: "pause",
      functionName: "run",
      depth: 0,
      lineNumber: 2,
      columnNumber: 0,
      state: { order: { status: "done" } },
    });
    await recorder.complete("completed");

    try {
      const output = outputCollector();
      const context = { stdout: output.stream, saptoolsRoot: root };
      await runShowCommand("latest", { changesOnly: true, maxOutputBytes: "24000" }, context);
      await runStateCommand("latest", { at: "1", path: "/order/status", maxOutputBytes: "24000" }, context);
      await runDiffCommand("latest", { from: "0", to: "1", path: "/order", maxOutputBytes: "24000" }, context);
      await runRunsCommand({ limit: "10", maxOutputBytes: "24000" }, context);

      expect(output.values[0]).toMatchObject({ runId: run.runId, total: 3 });
      expect(output.values[1]).toMatchObject({ state: "done" });
      expect(output.values[2]).toMatchObject({ changedPaths: ["/status"] });
      expect(output.values[3]).toMatchObject({ total: 1 });

      await runPurgeCommand(run.runId, context);
      expect(output.values[4]).toEqual({ purged: true, runId: run.runId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pages a large timeline without discarding every event at the byte boundary", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      for (let seq = 0; seq < 40; seq += 1) {
        await writeTraceEvent(run, {
          seq,
          kind: seq === 0 ? "baseline" : "pause",
          stateHash: String(seq).padStart(64, "0"),
          artifactKind: seq === 0 ? "full" : "unchanged",
          changedPaths: seq === 0 ? [""] : [],
          functionName: "functionWithEnoughMetadataToRequirePagination",
          lineNumber: seq,
        });
      }
      const output = outputCollector();
      await runShowCommand(run.runId, {
        from: "0",
        limit: "40",
        maxOutputBytes: "1024",
      }, { stdout: output.stream, saptoolsRoot: root });

      expect(output.values[0]).toMatchObject({
        runId: run.runId,
        total: 40,
        hasMore: true,
      });
      expect(output.values[0]).not.toHaveProperty("truncated", true);
      expect(output.values[0]).toHaveProperty("nextSeq");
      expect(output.values[0]).toHaveProperty("events");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every event, including the terminal marker, when changed paths alone would blow the budget", async () => {
    // Reproduces a real regression: once diff/state-diff reports every
    // changed path honestly (instead of collapsing to one replace), a run
    // whose steps touch many paths (e.g. node-identity churn across steps)
    // can make full events far bigger than the default byte budget. The old
    // "pop full events from the end" degrade path silently dropped the run's
    // LATEST events -- including its terminal completed marker -- even
    // though every event's functionName/depth and a non-empty (if capped)
    // changedPaths would have fit.
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const bulkyPaths = Array.from({ length: 500 }, (_unused, index) => `/frames/0/nodes/n${index.toString()}/properties/value`);
    try {
      for (let seq = 0; seq < 20; seq += 1) {
        await writeTraceEvent(run, {
          seq,
          kind: "pause",
          stateHash: String(seq).padStart(64, "0"),
          artifactKind: "patch",
          changedPaths: bulkyPaths,
          functionName: "handler",
          depth: 0,
          lineNumber: seq,
          columnNumber: 1,
        });
      }
      await writeTraceEvent(run, {
        seq: 20,
        kind: "completed",
        stateHash: "f".repeat(64),
        artifactKind: "full",
        changedPaths: [],
      });
      const output = outputCollector();
      await runShowCommand(run.runId, {
        from: "0",
        limit: "21",
        maxOutputBytes: "24000",
      }, { stdout: output.stream, saptoolsRoot: root });

      const envelope = output.values[0] as Readonly<Record<string, unknown>>;
      expect(envelope).toMatchObject({ runId: run.runId, total: 21 });
      const events = envelope["events"] as readonly Readonly<Record<string, unknown>>[];
      expect(events.some((event) => event["kind"] === "completed")).toBe(true);
      expect(events.every((event) => event["functionName"] === undefined || event["functionName"] === "handler")).toBe(true);
      const pauseEvents = events.filter((event) => event["kind"] === "pause");
      expect(pauseEvents.length).toBeGreaterThan(0);
      for (const event of pauseEvents) {
        expect(event["functionName"]).toBe("handler");
        expect(event["lineNumber"]).toBeTypeOf("number");
        const changedPaths = event["changedPaths"];
        expect(Array.isArray(changedPaths) ? changedPaths.length : 0).toBeGreaterThan(0);
        if (event["changedPathCount"] !== undefined) {
          expect(event["changedPathCount"]).toBe(bulkyPaths.length);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes expired sensitive runs when the offline CLI is used again", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    try {
      const output = outputCollector();
      await runRunsCommand({ limit: "10", maxOutputBytes: "24000" }, {
        stdout: output.stream,
        saptoolsRoot: root,
      });

      expect(output.values[0]).toMatchObject({ total: 0, runs: [] });
      await expect(access(run.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the request envelope and adds an actionable hint when state exceeds the output budget (P0-5)", async () => {
    // Before the fix: an oversized state collapsed to a content-free
    // {truncated, originalBytes} stub with no runId/seq and no guidance.
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: { blob: "x".repeat(5000) },
    });
    await recorder.complete("completed");
    try {
      const output = outputCollector();
      await runStateCommand("latest", { at: "0", maxOutputBytes: "300" }, { stdout: output.stream, saptoolsRoot: root });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response["runId"]).toBe(run.runId);
      expect(response["seq"]).toBe(0);
      expect(response["truncated"]).toBe(true);
      expect(typeof response["originalBytes"]).toBe("number");
      expect(response["originalBytes"] as number).toBeGreaterThan(300);
      expect(response["state"]).toBeUndefined();
      const hint = response["hint"];
      expect(typeof hint).toBe("string");
      expect(hint as string).toContain("--max-output-bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the request envelope and adds an actionable hint when diff exceeds the output budget (P0-5)", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    // A single oversized replace at an already-narrowed --path: capping
    // operation COUNT cannot help (there is only one operation), so this
    // must fall all the way to the envelope-only summary -- and since --path
    // was already supplied, the hint must not also suggest --path again.
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: { order: { blob: "before" } },
    });
    await recorder.record({
      seq: 1,
      kind: "pause",
      functionName: "run",
      depth: 0,
      lineNumber: 2,
      columnNumber: 0,
      state: { order: { blob: "y".repeat(5000) } },
    });
    await recorder.complete("completed");
    try {
      const output = outputCollector();
      await runDiffCommand("latest", {
        from: "0",
        to: "1",
        path: "/order",
        maxOutputBytes: "300",
      }, { stdout: output.stream, saptoolsRoot: root });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response).toMatchObject({ runId: run.runId, from: 0, to: 1, path: "/order", truncated: true });
      expect(typeof response["originalBytes"]).toBe("number");
      expect(response["changedPathCount"]).toBe(1);
      expect(response["operationCount"]).toBe(1);
      expect(response["operations"]).toBeUndefined();
      const hint = response["hint"] as string;
      expect(hint).toContain("--max-output-bytes");
      expect(hint).not.toContain("--path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shrinks diff output by capping operation count before falling back to an envelope-only summary (P0-5)", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    const fieldCount = 300;
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let index = 0; index < fieldCount; index += 1) {
      before[`f${index.toString()}`] = "before";
      after[`f${index.toString()}`] = "y".repeat(100);
    }
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: before,
    });
    await recorder.record({
      seq: 1,
      kind: "pause",
      functionName: "run",
      depth: 0,
      lineNumber: 2,
      columnNumber: 0,
      state: after,
    });
    await recorder.complete("completed");
    try {
      const output = outputCollector();
      // Sized so the full 300-operation response (~45KB) does not fit, but
      // capping to 50 operations while keeping every changedPaths entry
      // (~10KB) comfortably does -- landing in the middle "capped" tier,
      // not the full response and not the final envelope-only fallback.
      await runDiffCommand("latest", { from: "0", to: "1", maxOutputBytes: "15000" }, {
        stdout: output.stream,
        saptoolsRoot: root,
      });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response["runId"]).toBe(run.runId);
      expect(response["truncated"]).toBeUndefined();
      const changedPaths = response["changedPaths"] as readonly string[] | undefined;
      expect(changedPaths).toHaveLength(fieldCount);
      const operations = response["operations"] as readonly unknown[] | undefined;
      expect(operations?.length).toBeGreaterThan(0);
      expect(operations?.length).toBeLessThan(fieldCount);
      expect(response["operationCount"]).toBe(fieldCount);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the request envelope instead of throwing when state can't even fit a hint at the documented floor (P0-5)", async () => {
    // --max-output-bytes=128 is the tool's own documented minimum (see
    // program.ts). The hint string alone is a ~100+ byte fixed guidance
    // message, so envelope + hint can exceed 128 even though the bare
    // envelope (runId/seq/truncated) always fits -- this must shed the hint
    // (and originalBytes if needed) instead of throwing.
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: { blob: "x".repeat(5000) },
    });
    await recorder.complete("completed");
    try {
      const output = outputCollector();
      await runStateCommand("latest", { at: "0", maxOutputBytes: "128" }, { stdout: output.stream, saptoolsRoot: root });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response["runId"]).toBe(run.runId);
      expect(response["seq"]).toBe(0);
      expect(response["truncated"]).toBe(true);
      expect(response["state"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the request envelope instead of throwing when diff can't even fit counts at the documented floor (P0-5)", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const recorder = createTraceRecorder(run, { checkpointEvery: 10 });
    await recorder.record({
      seq: 0,
      kind: "baseline",
      functionName: "run",
      depth: 0,
      lineNumber: 1,
      columnNumber: 0,
      state: { order: { blob: "before" } },
    });
    await recorder.record({
      seq: 1,
      kind: "pause",
      functionName: "run",
      depth: 0,
      lineNumber: 2,
      columnNumber: 0,
      state: { order: { blob: "y".repeat(5000) } },
    });
    await recorder.complete("completed");
    try {
      const output = outputCollector();
      await runDiffCommand("latest", {
        from: "0",
        to: "1",
        path: "/order",
        maxOutputBytes: "128",
      }, { stdout: output.stream, saptoolsRoot: root });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response["runId"]).toBe(run.runId);
      expect(response["from"]).toBe(0);
      expect(response["to"]).toBe(1);
      expect(response["truncated"]).toBe(true);
      expect(response["operations"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the summary envelope instead of throwing when show can't even fit one compact event at the documented floor (P0-5)", async () => {
    const root = join(tmpdir(), `cf-function-query-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      for (let seq = 0; seq < 10; seq += 1) {
        await writeTraceEvent(run, {
          seq,
          kind: seq === 0 ? "baseline" : "pause",
          stateHash: String(seq).padStart(64, "0"),
          artifactKind: seq === 0 ? "full" : "unchanged",
          changedPaths: seq === 0 ? [""] : [],
          functionName: "functionWithEnoughMetadataToRequirePagination",
          lineNumber: seq,
        });
      }
      const output = outputCollector();
      await runShowCommand(run.runId, { from: "0", limit: "10", maxOutputBytes: "128" }, {
        stdout: output.stream,
        saptoolsRoot: root,
      });

      const response = output.values[0] as Readonly<Record<string, unknown>>;
      expect(response["runId"]).toBe(run.runId);
      expect(response["total"]).toBe(10);
      expect(response["events"]).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
