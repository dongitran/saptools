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
});
