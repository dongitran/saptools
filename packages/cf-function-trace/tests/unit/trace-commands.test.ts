import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  runPlanCommand,
  runRecordCommand,
  type TraceRuntime,
  type TraceRuntimeRunner,
} from "../../src/cli/trace-commands.js";
import { TraceDataError } from "../../src/errors.js";
import { listTraceRuns, readStateAt, readTraceManifest } from "../../src/run-reader.js";
import type { TraceTarget } from "../../src/session.js";
import type { TracePlan } from "../../src/trace-controller.js";

const PLAN: TracePlan = {
  functionSelector: "OrderService.create",
  scriptId: "script-7",
  scriptUrl: "file:///srv/app/dist/order.js",
  sourceHash: "a".repeat(64),
  startLine: 9,
  startColumn: 2,
  endLine: 15,
  endColumn: 3,
  entryLocation: { scriptId: "script-7", lineNumber: 10, columnNumber: 4 },
  appRoots: ["/srv/app"],
  callDepth: 1,
};

function collectingOutput(): { readonly stream: Writable; readonly values: unknown[] } {
  const values: unknown[] = [];
  return {
    values,
    stream: new Writable({
      write(chunk: Buffer | string, _encoding, callback): void {
        const parsed: unknown = JSON.parse(chunk.toString());
        values.push(parsed);
        callback();
      },
    }),
  };
}

function runtimeRunner(runtime: TraceRuntime): TraceRuntimeRunner {
  return {
    withRuntime: async <TResult>(
      _target: TraceTarget,
      callback: (selectedRuntime: TraceRuntime) => Promise<TResult>,
    ): Promise<TResult> => await callback(runtime),
  };
}

function localFlags(): {
  readonly port: string;
  readonly callDepth: string;
  readonly confirmImpact: false;
} {
  return { port: "9229", callDepth: "1", confirmImpact: false };
}

function stringProperty(value: unknown, field: string): string | undefined {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, field) === "string"
    ? String(Reflect.get(value, field))
    : undefined;
}

describe("trace plan and record commands", () => {
  it("plans against the runtime cwd without exposing source text", async () => {
    const output = collectingOutput();
    const plan = vi.fn(async (): Promise<TracePlan> => PLAN);
    const runtime: TraceRuntime = {
      resolveAppRoot: async (): Promise<string> => "/srv/app",
      plan,
      record: async (): Promise<never> => {
        throw new Error("record must not run while planning");
      },
    };

    await runPlanCommand("dist/order.js", "OrderService.create", localFlags(), {
      stdout: output.stream,
      runtimeRunner: runtimeRunner(runtime),
    });

    expect(plan).toHaveBeenCalledWith({
      file: "dist/order.js",
      functionSelector: "OrderService.create",
      appRoots: ["/srv/app"],
      callDepth: 1,
    });
    expect(output.values[0]).toEqual({
      functionSelector: "OrderService.create",
      scriptUrl: "file:///srv/app/dist/order.js",
      sourceHash: "a".repeat(64),
      startLine: 10,
      endLine: 16,
      entryLine: 11,
      entryColumn: 5,
      callDepth: 1,
      asynchronous: false,
      appRoots: ["/srv/app"],
    });
  });

  it("records full state then patches and marks a completed run", async () => {
    const root = join(tmpdir(), `cf-function-trace-command-${randomUUID()}`);
    const output = collectingOutput();
    const progress = collectingOutput();
    const runtime: TraceRuntime = {
      resolveAppRoot: async (): Promise<string> => "/srv/app",
      plan: async (): Promise<TracePlan> => PLAN,
      record: async (_plan, options, capture): Promise<{ readonly stopReason: "function-returned"; readonly stepCount: number }> => {
        expect(capture).toMatchObject({ maxFrames: 2, graphLimits: { maxDepth: 4 } });
        await options.onProgress?.({ kind: "breakpoint-armed" });
        await options.onState({
          seq: 0,
          kind: "baseline",
          functionName: "create",
          depth: 0,
          lineNumber: 10,
          columnNumber: 4,
          state: { input: { id: "42", status: "new" } },
        });
        await options.onState({
          seq: 1,
          kind: "pause",
          functionName: "create",
          depth: 0,
          lineNumber: 11,
          columnNumber: 4,
          state: { input: { id: "42", status: "done" } },
        });
        return { stopReason: "function-returned", stepCount: 2 };
      },
    };

    try {
      await runRecordCommand("dist/order.js", "OrderService.create", localFlags(), {
        stdout: output.stream,
        stderr: progress.stream,
        saptoolsRoot: root,
        runtimeRunner: runtimeRunner(runtime),
      });
      const result = output.values[0];
      expect(result).toMatchObject({ status: "completed", stopReason: "function-returned", stepCount: 2 });
      expect(progress.values).toEqual([{ event: "breakpoint-armed" }]);
      expect(result).not.toHaveProperty("source");
      const runsDirectory = join(root, "cf-function-trace", "data");
      const runId = typeof result === "object" && result !== null ? Reflect.get(result, "runId") : undefined;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("record output did not contain a run id");
      }
      await expect(readTraceManifest(runId, { saptoolsRoot: root })).resolves.toMatchObject({
        status: "completed",
        sourceHash: "a".repeat(64),
      });
      await expect(readStateAt(runId, 1, { saptoolsRoot: root })).resolves.toEqual({ input: { id: "42", status: "done" } });
      const stateFiles = await readFile(join(runsDirectory, runId, "events", "000001.json"), "utf8");
      expect(stateFiles).toContain('"artifactKind": "patch"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks max-step runs partial and aborted runs cancelled", async () => {
    const root = join(tmpdir(), `cf-function-trace-status-${randomUUID()}`);
    const output = collectingOutput();
    const partialRuntime: TraceRuntime = {
      resolveAppRoot: async (): Promise<string> => "/srv/app",
      plan: async (): Promise<TracePlan> => PLAN,
      record: async (): Promise<{ readonly stopReason: "max-steps"; readonly stepCount: number }> => ({
        stopReason: "max-steps",
        stepCount: 200,
      }),
    };
    const abortRuntime: TraceRuntime = {
      ...partialRuntime,
      record: async (): Promise<never> => {
        throw new TraceDataError("TRACE_ABORTED", "aborted");
      },
    };

    try {
      await runRecordCommand("dist/order.js", "OrderService.create", localFlags(), {
        stdout: output.stream,
        saptoolsRoot: root,
        runtimeRunner: runtimeRunner(partialRuntime),
      });
      expect(output.values[0]).toMatchObject({ status: "partial", stopReason: "max-steps" });

      await expect(runRecordCommand("dist/order.js", "OrderService.create", localFlags(), {
        stdout: output.stream,
        saptoolsRoot: root,
        runtimeRunner: runtimeRunner(abortRuntime),
      })).rejects.toMatchObject({ code: "TRACE_ABORTED" });
      const manifests = await listTraceRuns({ saptoolsRoot: root });
      expect(manifests.map(({ status }) => status).sort()).toEqual(["cancelled", "partial"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("threads the partial run's id and directory onto a MAX_PAUSED_TIME error so it can be recovered (P1-1)", async () => {
    // Before the fix: executeRecord's catch block re-threw the original
    // error unchanged, even though createTraceRun had already succeeded and
    // recorder.fail() had already persisted real partial data under that
    // runId -- an agent seeing only the generic error had no handle to find
    // and recover it with `show`/`state`.
    const root = join(tmpdir(), `cf-function-trace-timeout-${randomUUID()}`);
    const timeoutRuntime: TraceRuntime = {
      resolveAppRoot: async (): Promise<string> => "/srv/app",
      plan: async (): Promise<TracePlan> => PLAN,
      record: async (): Promise<never> => {
        throw new TraceDataError("MAX_PAUSED_TIME", "Cumulative pause budget exceeded.");
      },
    };

    try {
      let caught: unknown;
      try {
        await runRecordCommand("dist/order.js", "OrderService.create", localFlags(), {
          stdout: collectingOutput().stream,
          saptoolsRoot: root,
          runtimeRunner: runtimeRunner(timeoutRuntime),
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "MAX_PAUSED_TIME" });
      const runId = stringProperty(caught, "runId");
      const directory = stringProperty(caught, "directory");
      expect(runId).toBeDefined();
      expect(directory).toBeDefined();

      const manifests = await listTraceRuns({ saptoolsRoot: root });
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toMatchObject({ runId, status: "partial" });
      expect(directory).toContain(runId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a trace when the breakpoint-armed consumer has closed", async () => {
    const root = join(tmpdir(), `cf-function-trace-progress-${randomUUID()}`);
    const closedProgress = new Writable({
      write(_chunk, _encoding, callback): void {
        callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
      },
    });
    const runtime: TraceRuntime = {
      resolveAppRoot: async (): Promise<string> => "/srv/app",
      plan: async (): Promise<TracePlan> => PLAN,
      record: async (_plan, options): Promise<never> => {
        await options.onProgress?.({ kind: "breakpoint-armed" });
        throw new Error("progress callback should have aborted");
      },
    };

    try {
      await expect(runRecordCommand("dist/order.js", "OrderService.create", localFlags(), {
        stdout: collectingOutput().stream,
        stderr: closedProgress,
        saptoolsRoot: root,
        runtimeRunner: runtimeRunner(runtime),
      })).rejects.toMatchObject({ code: "TRACE_ABORTED" });
      await expect(listTraceRuns({ saptoolsRoot: root })).resolves.toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
